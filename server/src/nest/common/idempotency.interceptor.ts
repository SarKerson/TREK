import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, defer, from, of } from 'rxjs';
import { finalize, switchMap } from 'rxjs/operators';
import { DatabaseService } from '../database/database.service';
import { isVercelRuntime } from '../../runtime';
import { decrypt_api_key, encrypt_api_key, is_encrypted_api_key } from './crypto/apiKeyCrypto';

/**
 * Replaces the `applyIdempotency` middleware the Express `authenticate` ran on
 * every authenticated request. Both are gone; this is the only implementation.
 *
 * The TREK client attaches an `X-Idempotency-Key` to ALL write operations (see
 * client/src/api/client.ts) and the offline sync queue replays mutations with
 * that key, so a migrated mutating route MUST honour it — otherwise a replayed
 * POST would create a duplicate instead of returning the cached response. This
 * reproduces the legacy behaviour exactly, against the same `idempotency_keys`
 * table:
 *   - non-mutating method, or no key, or no authenticated user -> pass through
 *   - key longer than the cap -> 400 with the exact legacy message
 *   - (key, user, method, path) already stored -> replay the cached response
 *   - the same key still in flight -> wait for it, then replay its response
 *   - otherwise -> capture a successful JSON response under the key
 *
 * The in-flight step is the one thing the Express wrapper did not do. The row
 * only exists once the first request answers, so two overlapping replays of one
 * key (two tabs draining the same offline queue, or a client retrying after a
 * timeout) both missed the SELECT and both ran the handler — the duplicate
 * write the key exists to prevent. Waiting keeps the promise the client was
 * given: the second caller gets the first one's response, not a new error to
 * interpret.
 *
 * Capturing wraps `res.json`, so 204 / `res.end()` responses are not cached —
 * matching the Express wrapper, which only fires on `res.json`.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_KEY_LENGTH = 128;
const MAX_CACHED_BODY_BYTES = 256 * 1024;
// Preserve replay for bulk responses while staying within the function response budget.
const MAX_SHARED_CACHED_BODY_BYTES = 4 * 1024 * 1024;

/**
 * (user, method, path, key) of every request currently running, resolved when it
 * answers. In memory rather than a reservation row on purpose: better-sqlite3 is
 * synchronous and the whole overlap lives inside one process, so a crash cannot
 * leave a key wedged for the table's 30-day TTL.
 */
const inFlight = new Map<string, Promise<void>>();

interface IdempotencyRow {
  status_code: number;
  response_body: string;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly database: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: { id: number } }>();
    const res = context.switchToHttp().getResponse<Response>();

    if (!MUTATING_METHODS.has(req.method)) return next.handle();

    const key = req.headers['x-idempotency-key'] as string | undefined;
    if (!key) return next.handle();

    // Idempotency only applies to authenticated requests — the legacy code runs
    // inside `authenticate`, after req.user is set.
    const userId = req.user?.id;
    if (userId == null) return next.handle();

    if (key.length > MAX_KEY_LENGTH) {
      throw new HttpException({ error: 'X-Idempotency-Key exceeds maximum length of 128 characters' }, 400);
    }

    const existing = this.lookup(key, userId, req);
    if (existing) return this.replay(existing, res);

    if (isVercelRuntime()) return this.runShared(key, userId, req, res, next);

    const signature = `${userId}|${req.method}|${req.path}|${key}`;
    const pending = inFlight.get(signature);
    if (pending !== undefined) {
      return from(pending).pipe(
        switchMap(() => {
          const stored = this.lookup(key, userId, req);
          if (stored) return this.replay(stored, res);
          // The first request answered without caching anything (it failed, or
          // it never went through res.json). Run this one normally rather than
          // inventing a response for it.
          return this.run(signature, key, userId, req, res, next);
        }),
      );
    }

    return this.run(signature, key, userId, req, res, next);
  }

  /**
   * A reservation is durable BEFORE executing a handler. It deliberately has no
   * expiry: a dead worker may already have applied the write, and a lease timeout
   * is not evidence that rerunning it is safe. Only a durably captured response
   * releases the reservation. Uncertain outcomes require reconciliation.
   */
  private runShared(key: string, userId: number, req: Request, res: Response, next: CallHandler): Observable<unknown> {
    let claim: { owned: boolean; stored?: IdempotencyRow };
    try {
      claim = this.database.transaction(() => {
        // Write first to avoid a read-to-write transaction upgrade race. Recheck
        // the response under that lock: another worker may have completed after
        // the optimistic lookup above and already removed its reservation.
        const owned = this.database.run(`INSERT OR IGNORE INTO idempotency_claims
          (key, user_id, method, path, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
        key, userId, req.method, req.path, Math.floor(Date.now() / 1000)).changes === 1;
        const stored = this.lookup(key, userId, req);
        if (owned && stored) this.deleteSharedClaim(key, userId, req);
        return { owned, stored };
      });
    } catch {
      return this.unresolved(res);
    }
    if (claim.stored) return this.replay(claim.stored, res);
    if (!claim.owned) return this.unresolved(res);

    const originalJson = res.json.bind(res);
    let captured = false;
    res.json = (body: unknown): Response => {
      if (res.statusCode >= 200 && res.statusCode < 500) {
        try {
          const serialized = JSON.stringify(body);
          if (serialized === undefined || Buffer.byteLength(serialized) > MAX_SHARED_CACHED_BODY_BYTES) {
            throw new Error('Response exceeds the durable replay limit');
          }
          this.database.transaction(() => {
            this.database.run(`INSERT INTO idempotency_keys
              (key, user_id, method, path, status_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            key, userId, req.method, req.path, res.statusCode, encrypt_api_key(serialized), Math.floor(Date.now() / 1000));
            this.deleteSharedClaim(key, userId, req);
          });
          captured = true;
        } catch {
          // The mutation may already exist. Never report a replayable success or
          // remove its reservation if the result could not be durably recorded.
          this.markSharedUncertain(key, userId, req);
          res.status(503);
          res.setHeader('Retry-After', '1');
          return originalJson(this.unresolvedBody());
        }
      } else {
        this.markSharedUncertain(key, userId, req);
      }
      return originalJson(body);
    };

    return defer(() => next.handle()).pipe(finalize(() => {
      // Nest serializes several microtasks after observable completion. This
      // backstop records throws/send/end/disconnect without racing res.json.
      setImmediate(() => {
        if (!captured) this.markSharedUncertain(key, userId, req);
      });
    }));
  }

  private deleteSharedClaim(key: string, userId: number, req: Request): void {
    this.database.run('DELETE FROM idempotency_claims WHERE key = ? AND user_id = ? AND method = ? AND path = ?',
      key, userId, req.method, req.path);
  }

  private markSharedUncertain(key: string, userId: number, req: Request): void {
    try {
      this.database.run(`UPDATE idempotency_claims SET state = 'uncertain'
        WHERE key = ? AND user_id = ? AND method = ? AND path = ?`, key, userId, req.method, req.path);
    } catch {
      // The original pending reservation remains durable even if this advisory
      // label cannot be written. Both states refuse another execution.
    }
  }

  private unresolvedBody(): { error: string; code: string } {
    return { error: 'Request outcome is pending or uncertain. Retry with the same idempotency key; do not submit a new copy.', code: 'IDEMPOTENCY_UNRESOLVED' };
  }

  private unresolved(res: Response): Observable<unknown> {
    res.status(503);
    res.setHeader('Retry-After', '1');
    return of(this.unresolvedBody());
  }

  /**
   * Scope the lookup by method + path as well as user, so the same key replayed
   * against a different endpoint can't return an unrelated cached body.
   */
  private lookup(key: string, userId: number, req: Request): IdempotencyRow | undefined {
    return this.database.get<IdempotencyRow>(
      'SELECT status_code, response_body FROM idempotency_keys WHERE key = ? AND user_id = ? AND method = ? AND path = ?',
      key, userId, req.method, req.path,
    );
  }

  private replay(row: IdempotencyRow, res: Response): Observable<unknown> {
    res.status(row.status_code);
    // Auth mutations can return setup secrets, backup codes or one-time tickets.
    // Shared replay storage must not turn those into long-lived plaintext copies.
    const serialized = is_encrypted_api_key(row.response_body) ? decrypt_api_key(row.response_body) : row.response_body;
    if (serialized == null) throw new HttpException({ error: 'Unable to read the stored request outcome' }, 503);
    return of(JSON.parse(serialized));
  }

  private run(
    signature: string,
    key: string,
    userId: number,
    req: Request,
    res: Response,
    next: CallHandler,
  ): Observable<unknown> {
    const originalJson = res.json.bind(res);
    const database = this.database;

    let done!: () => void;
    inFlight.set(signature, new Promise<void>((resolve) => { done = resolve; }));
    let released = false;
    // Idempotent: whichever of the two paths below gets there first releases the
    // waiter, and the other one is a no-op.
    const release = () => {
      if (released) return;
      released = true;
      inFlight.delete(signature);
      done();
    };

    res.json = function (body: unknown): Response {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          const serialized = JSON.stringify(body);
          if (serialized.length <= MAX_CACHED_BODY_BYTES) {
            database.run(
              `INSERT OR IGNORE INTO idempotency_keys (key, user_id, method, path, status_code, response_body, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              key, userId, req.method, req.path, res.statusCode, serialized, Math.floor(Date.now() / 1000),
            );
          }
        } catch {
          // Non-fatal: if storage fails, the request still succeeds.
        }
      }
      // Release here, not in finalize: this is the point the row exists, and a
      // waiter woken any earlier looks the key up, misses, and runs the handler
      // a second time - the duplicate write the key is meant to prevent.
      // Release here, not in finalize: this is the point the row exists, and a
      // waiter woken any earlier looks the key up, misses, and runs the handler
      // a second time - the duplicate write the key is meant to prevent.
      release();
      return originalJson(body);
    };

    return next.handle().pipe(
      finalize(() => {
        // Backstop for a handler that never reaches res.json: it threw, or it
        // answered through @Res() with send/end. Deferred by a full tick because
        // finalize runs when the handler's observable completes and Nest writes
        // the response several microtasks after that - firing straight away
        // would beat the wrapper above to it on the ordinary path.
        setImmediate(release);
      }),
    );
  }
}
