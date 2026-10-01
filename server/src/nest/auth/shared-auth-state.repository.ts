import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ENCRYPTION_KEY } from '../../config';
import { DatabaseService } from '../database/database.service';

interface StateRow { value: string; expires_at: number }
export interface SharedAuthState<T> { value: T; revision: string }
type ConsumedState<T> = { expired: true } | { expired: false; value: T };

/** Cross-instance auth state. Only digests and authenticated ciphertext reach the DB. */
export class SharedAuthStateRepository {
  private lastSweep = 0;

  constructor(private readonly db: DatabaseService) {}

  private hash(namespace: string, key: string): string {
    return createHash('sha256').update(JSON.stringify([namespace, key])).digest('hex');
  }

  private encryptionKey(): Buffer {
    return createHash('sha256').update(`${ENCRYPTION_KEY}:auth-ephemeral:v1`).digest();
  }

  private encrypt<T>(namespace: string, keyHash: string, value: T): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(JSON.stringify([namespace, keyHash])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private decrypt<T>(namespace: string, keyHash: string, value: string): T {
    const blob = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([namespace, keyHash])));
    decipher.setAuthTag(blob.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')) as T;
  }

  put<T>(namespace: string, key: string, value: T, expiresAt: number): void {
    this.sweep(Date.now());
    const keyHash = this.hash(namespace, key);
    this.db.run(`INSERT INTO auth_ephemeral_state (namespace, key_hash, value, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(namespace, key_hash) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    namespace, keyHash, this.encrypt(namespace, keyHash, value), expiresAt);
  }

  read<T>(namespace: string, key: string, now = Date.now()): SharedAuthState<T> | null {
    const keyHash = this.hash(namespace, key);
    const row = this.db.get<StateRow>(`SELECT value, expires_at FROM auth_ephemeral_state
      WHERE namespace = ? AND key_hash = ? AND expires_at > ?`, namespace, keyHash, now);
    return row ? { value: this.decrypt<T>(namespace, keyHash, row.value), revision: row.value } : null;
  }

  /** Deletion wins atomically across workers, including for expired or wrongly bound codes. */
  consume<T>(namespace: string, key: string, now = Date.now()): ConsumedState<T> | null {
    const keyHash = this.hash(namespace, key);
    const row = this.db.get<StateRow>(`DELETE FROM auth_ephemeral_state
      WHERE namespace = ? AND key_hash = ? RETURNING value, expires_at`, namespace, keyHash);
    if (!row) return null;
    if (row.expires_at <= now) return { expired: true };
    return { expired: false, value: this.decrypt<T>(namespace, keyHash, row.value) };
  }

  /** Consume only the setup that was verified, never a concurrently replaced setup. */
  compareAndDelete(namespace: string, key: string, revision: string, now = Date.now()): boolean {
    return !!this.db.get<{ key_hash: string }>(`DELETE FROM auth_ephemeral_state
      WHERE namespace = ? AND key_hash = ? AND value = ? AND expires_at > ? RETURNING key_hash`,
    namespace, this.hash(namespace, key), revision, now);
  }

  delete(namespace: string, key: string): void {
    this.db.run('DELETE FROM auth_ephemeral_state WHERE namespace = ? AND key_hash = ?', namespace, this.hash(namespace, key));
  }

  /** Atomic fixed-window increment; rejected attempts cannot grow the counter past max. */
  checkRateLimit(namespace: string, key: string, max: number, windowMs: number, now: number): boolean {
    if (max <= 0 || windowMs <= 0) return false;
    this.sweep(now);
    return !!this.db.get<{ count: number }>(`INSERT INTO auth_rate_limits (key_hash, count, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key_hash) DO UPDATE SET
        count = CASE WHEN auth_rate_limits.expires_at <= ? THEN 1 ELSE auth_rate_limits.count + 1 END,
        expires_at = CASE WHEN auth_rate_limits.expires_at <= ? THEN excluded.expires_at ELSE auth_rate_limits.expires_at END
      WHERE auth_rate_limits.expires_at <= ? OR auth_rate_limits.count < ?
      RETURNING count`, this.hash(namespace, key), now + windowMs, now, now, now, max);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 5 * 60 * 1000) return;
    this.db.transaction(() => {
      this.db.run('DELETE FROM auth_ephemeral_state WHERE expires_at <= ?', now);
      this.db.run('DELETE FROM auth_rate_limits WHERE expires_at <= ?', now);
    });
    this.lastSweep = now;
  }
}
