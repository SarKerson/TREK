import crypto from 'crypto';
import type { DatabaseService } from '../database/database.service';
import { isVercelRuntime } from '../../runtime';

let sharedDb: DatabaseService | undefined;
export function configureEphemeralTokenDatabase(db: DatabaseService): void { sharedDb = db; }
function remoteDb(): DatabaseService | undefined {
  if (!isVercelRuntime()) return undefined;
  if (!sharedDb) throw new Error('Shared token database is not initialized');
  return sharedDb;
}
const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const TTL: Record<string, number> = {
  ws: 30_000,
  download: 60_000,
};

const MAX_STORE_SIZE = 10_000;

interface TokenEntry {
  userId: number;
  purpose: string;
  expiresAt: number;
  /**
   * Snapshot of the user's `password_version` at mint time, used for the
   * defence-in-depth session gate on WebSocket connects. `undefined` for
   * tokens minted without a version (legacy/other purposes), which callers
   * treat as version 0 — mirroring the JWT `pv` claim semantics.
   */
  pv?: number;
}

export interface EphemeralTokenMeta {
  /** Bind the token to the user's current password_version (session gate). */
  pv?: number;
}

const store = new Map<string, TokenEntry>();

export function createEphemeralToken(
  userId: number,
  purpose: string,
  meta?: EphemeralTokenMeta,
): string | null {
  const db = remoteDb();
  if (db) {
    db.run('DELETE FROM ephemeral_tokens WHERE expires_at <= ?', Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    const result = db.run(
      'INSERT INTO ephemeral_tokens (token_hash, user_id, purpose, expires_at, pv) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM ephemeral_tokens) < ?',
      tokenHash(token), userId, purpose, Date.now() + (TTL[purpose] ?? 60_000), meta?.pv ?? null, MAX_STORE_SIZE,
    );
    return result.changes ? token : null;
  }
  if (store.size >= MAX_STORE_SIZE) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = TTL[purpose] ?? 60_000;
  store.set(token, { userId, purpose, expiresAt: Date.now() + ttl, pv: meta?.pv });
  return token;
}

export function consumeEphemeralToken(token: string, purpose: string): number | null {
  return consumeEphemeralTokenWithMeta(token, purpose)?.userId ?? null;
}

/**
 * Like `consumeEphemeralToken`, but also returns the `password_version` the
 * token was minted with. Used by the WebSocket handshake so a token issued
 * before a password change can be rejected even within its short TTL.
 */
export function consumeEphemeralTokenWithMeta(
  token: string,
  purpose: string,
): { userId: number; pv?: number } | null {
  const db = remoteDb();
  if (db) {
    // One statement is the compare-and-delete: two instances cannot redeem it.
    const row = db.get<{ user_id: number; purpose: string; expires_at: number; pv: number | null }>(
      'DELETE FROM ephemeral_tokens WHERE token_hash = ? RETURNING user_id, purpose, expires_at, pv', tokenHash(token),
    );
    if (!row || row.purpose !== purpose || Date.now() >= row.expires_at) return null;
    return { userId: row.user_id, pv: row.pv ?? undefined };
  }
  const entry = store.get(token);
  if (!entry) return null;
  store.delete(token);
  if (entry.purpose !== purpose || Date.now() > entry.expiresAt) return null;
  return { userId: entry.userId, pv: entry.pv };
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenCleanup(): void {
  if (isVercelRuntime() || cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of store) {
      if (now > entry.expiresAt) store.delete(token);
    }
  }, 60_000);
  // Allow process to exit even if interval is active
  if (cleanupInterval.unref) cleanupInterval.unref();
}

export function stopTokenCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
