import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Observable, from, lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { IdempotencyInterceptor } from '../../../src/nest/common/idempotency.interceptor';

const runtime = vi.hoisted(() => ({ vercel: false }));
vi.mock('../../../src/runtime', () => ({ isVercelRuntime: () => runtime.vercel, vercelSecrets: () => null }));

let folder: string;
let connections: Sqlite.Database[];
let db: DatabaseService;
let secondDb: DatabaseService;

const request = (key = 'one-write', path = '/api/places', userId = 1) => ({
  method: 'POST', path, headers: { 'x-idempotency-key': key }, user: { id: userId },
});
function response() {
  const res = {
    statusCode: 200,
    status: vi.fn((code: number) => { res.statusCode = code; return res; }),
    setHeader: vi.fn(),
    json: vi.fn((body: unknown) => body),
  };
  return res;
}
function context(req: ReturnType<typeof request>, res: ReturnType<typeof response>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
}
function handler(result: unknown): CallHandler & { handle: ReturnType<typeof vi.fn> } {
  return { handle: vi.fn(() => of(result)) };
}

beforeEach(() => {
  runtime.vercel = true;
  folder = mkdtempSync(join(tmpdir(), 'trek-idempotency-'));
  connections = [new Sqlite(join(folder, 'db.sqlite')), new Sqlite(join(folder, 'db.sqlite'))];
  connections[0].exec(`
    CREATE TABLE idempotency_keys(key TEXT,user_id INTEGER,method TEXT,path TEXT,status_code INTEGER,response_body TEXT,created_at INTEGER,PRIMARY KEY(key,user_id,method,path));
    CREATE TABLE idempotency_claims(key TEXT,user_id INTEGER,method TEXT,path TEXT,state TEXT DEFAULT 'pending',created_at INTEGER,PRIMARY KEY(key,user_id,method,path));
    CREATE TABLE effects(id INTEGER PRIMARY KEY, value TEXT);
  `);
  db = new DatabaseService(connections[0]);
  secondDb = new DatabaseService(connections[1]);
});

afterEach(async () => {
  // Let deferred response finalizers run before closing their connections.
  await new Promise<void>(resolve => setImmediate(resolve));
  vi.restoreAllMocks();
  connections.forEach(connection => connection.close());
  rmSync(folder, { recursive: true, force: true });
  runtime.vercel = false;
});

describe('shared idempotency reservations', () => {
  it('executes overlapping same-key requests only once across independent connections', async () => {
    let finish!: () => void;
    const first = new IdempotencyInterceptor(db);
    const second = new IdempotencyInterceptor(secondDb);
    const firstRes = response();
    const effect = vi.fn(() => {
      db.run("INSERT INTO effects VALUES (1, 'applied once')");
      return from(new Promise(resolve => { finish = () => resolve({ id: 1 }); }));
    });
    const pending = lastValueFrom(first.intercept(context(request(), firstRes), { handle: effect }));
    const duplicate = handler({ id: 2 });
    const duplicateRes = response();
    expect(await lastValueFrom(second.intercept(context(request(), duplicateRes), duplicate)))
      .toMatchObject({ code: 'IDEMPOTENCY_UNRESOLVED' });
    expect(duplicateRes.statusCode).toBe(503);
    expect(duplicateRes.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(duplicate.handle).not.toHaveBeenCalled();
    finish();
    expect(await pending).toEqual({ id: 1 });
    firstRes.statusCode = 201;
    expect(firstRes.json({ id: 1 })).toEqual({ id: 1 });
    const retriedRes = response();
    expect(await lastValueFrom(second.intercept(context(request(), retriedRes), duplicate))).toEqual({ id: 1 });
    expect(retriedRes.statusCode).toBe(201);
    expect(secondDb.get<{ count: number }>('SELECT COUNT(*) AS count FROM effects')?.count).toBe(1);
    expect(secondDb.get('SELECT * FROM idempotency_claims')).toBeUndefined();
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('persists the response before the original response writer runs', async () => {
    const res = response();
    res.json.mockImplementation(body => {
      const cached = secondDb.get<{ response_body: string }>('SELECT response_body FROM idempotency_keys')!;
      expect(cached.response_body).toMatch(/^enc:v1:/);
      expect(cached.response_body).not.toContain('id');
      expect(secondDb.get('SELECT * FROM idempotency_claims')).toBeUndefined();
      return body;
    });
    const operation = handler({ id: 1 });
    await lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), operation));
    res.json({ id: 1 });
  });

  it('never expires an unresolved claim from a crashed worker', async () => {
    db.run("INSERT INTO effects VALUES (1, 'write before crash')");
    db.run("INSERT INTO idempotency_claims VALUES ('one-write',1,'POST','/api/places','pending',0)");
    const operation = handler({ id: 2 });
    const res = response();
    expect(await lastValueFrom(new IdempotencyInterceptor(secondDb).intercept(context(request(), res), operation)))
      .toMatchObject({ code: 'IDEMPOTENCY_UNRESOLVED' });
    expect(res.statusCode).toBe(503);
    expect(operation.handle).not.toHaveBeenCalled();
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM effects')?.count).toBe(1);
  });

  it('retains an uncertain reservation when an executing request disconnects', async () => {
    const res = response();
    const subscription = new IdempotencyInterceptor(db).intercept(context(request(), res), {
      handle: () => new Observable(() => { db.run("INSERT INTO effects VALUES (1, 'written')"); }),
    }).subscribe();
    subscription.unsubscribe();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(secondDb.get('SELECT state FROM idempotency_claims')).toEqual({ state: 'uncertain' });
    const next = handler({ id: 2 });
    await lastValueFrom(new IdempotencyInterceptor(secondDb).intercept(context(request(), response()), next));
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('retains uncertainty after a handler throws following a mutation', async () => {
    const res = response();
    await expect(lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), {
      handle: () => { db.run("INSERT INTO effects VALUES (1, 'written')"); return throwError(() => new Error('failed after write')); },
    }))).rejects.toThrow('failed after write');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(secondDb.get('SELECT state FROM idempotency_claims')).toEqual({ state: 'uncertain' });
    const next = handler({ id: 2 });
    await lastValueFrom(new IdempotencyInterceptor(secondDb).intercept(context(request(), response()), next));
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('fails closed if response persistence fails after the mutation', async () => {
    const originalRun = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((sql, ...params) => {
      if (sql.includes('INSERT INTO idempotency_keys')) throw new Error('storage unavailable');
      return originalRun(sql, ...params);
    });
    const res = response();
    await lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), {
      handle: () => { db.run("INSERT INTO effects VALUES (1, 'written')"); return of({ id: 1 }); },
    }));
    expect(res.json({ id: 1 })).toMatchObject({ code: 'IDEMPOTENCY_UNRESOLVED' });
    expect(res.statusCode).toBe(503);
    expect(secondDb.get('SELECT * FROM idempotency_keys')).toBeUndefined();
    expect(secondDb.get('SELECT state FROM idempotency_claims')).toEqual({ state: 'uncertain' });
    const next = handler({ id: 2 });
    await lastValueFrom(new IdempotencyInterceptor(secondDb).intercept(context(request(), response()), next));
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('does not execute anything if the durable claim cannot be acquired', async () => {
    vi.spyOn(db, 'transaction').mockImplementation(() => { throw new Error('offline'); });
    const res = response(); const next = handler({ id: 1 });
    await lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), next));
    expect(res.statusCode).toBe(503);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('rechecks a response completed between optimistic lookup and claim acquisition', async () => {
    db.run("INSERT INTO idempotency_keys VALUES ('one-write',1,'POST','/api/places',201,'{\"id\":1}',0)");
    vi.spyOn(db, 'get').mockReturnValueOnce(undefined);
    const res = response(); const next = handler({ id: 2 });
    expect(await lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), next))).toEqual({ id: 1 });
    expect(next.handle).not.toHaveBeenCalled();
    expect(secondDb.get('SELECT * FROM idempotency_claims')).toBeUndefined();
  });

  it('durably replays a successful bulk response larger than the local 256 KiB cap', async () => {
    const body = { rows: 'x'.repeat(300 * 1024) };
    const res = response();
    await lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), handler(body)));
    expect(res.json(body)).toEqual(body);
    expect(res.statusCode).toBe(200);
    const next = handler({ wrong: true });
    expect(await lastValueFrom(new IdempotencyInterceptor(secondDb).intercept(context(request(), response()), next))).toEqual(body);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('replays a known validation error instead of making its outcome uncertain', async () => {
    const body = { error: 'Invalid date' };
    const res = response();
    await lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), handler(body)));
    res.statusCode = 400;
    res.json(body);
    const retried = response(); const next = handler({ wrong: true });
    expect(await lastValueFrom(new IdempotencyInterceptor(secondDb).intercept(context(request(), retried), next))).toEqual(body);
    expect(retried.statusCode).toBe(400);
    expect(next.handle).not.toHaveBeenCalled();
    expect(secondDb.get('SELECT * FROM idempotency_claims')).toBeUndefined();
  });

  it('keeps an oversized UTF-8 response unresolved rather than silently dropping replay safety', async () => {
    const res = response(); const body = { value: '🙂'.repeat(1_100_000) };
    await lastValueFrom(new IdempotencyInterceptor(db).intercept(context(request(), res), handler(body)));
    expect(res.json(body)).toMatchObject({ code: 'IDEMPOTENCY_UNRESOLVED' });
    expect(res.statusCode).toBe(503);
    expect(secondDb.get('SELECT state FROM idempotency_claims')).toEqual({ state: 'uncertain' });
  });

  it('scopes durable reservations by user, method and path', async () => {
    db.run("INSERT INTO idempotency_claims VALUES ('one-write',1,'POST','/api/places','pending',0)");
    const interceptor = new IdempotencyInterceptor(secondDb);
    for (const req of [request('one-write', '/api/places', 2), request('one-write', '/api/days'), { ...request(), method: 'PATCH' }]) {
      const next = handler({ ok: true }); const res = response();
      await lastValueFrom(interceptor.intercept(context(req, res), next));
      expect(next.handle).toHaveBeenCalledTimes(1);
      res.json({ ok: true });
    }
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM idempotency_keys')?.count).toBe(3);
  });
});
