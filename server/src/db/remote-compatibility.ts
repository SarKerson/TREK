import { randomUUID } from 'node:crypto';
import type { DbConnection } from './adapter';

/** Release-time probe using rollback-only test data, never real user records. */
export function verifyRemoteDatabaseCompatibility(db: DbConnection): void {
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (foreignKeys?.foreign_keys !== 1) throw new Error('Remote connections must enforce foreign keys by default');
  const named = db.prepare('SELECT :id AS id, @id AS at_id, $label AS label, :id AS repeated')
    .get({ id: 1, label: 'trek-release' }) as { id: number; at_id: number; label: string; repeated: number } | undefined;
  if (named?.id !== 1 || named.at_id !== 1 || named.label !== 'trek-release' || named.repeated !== 1) {
    throw new Error('Remote named SQL binding compatibility failed');
  }
  const namespace = 'trek:release-probe';
  const key = randomUUID();
  const rolledBack = new Error('Successful rollback-only compatibility probe');
  const read = () => db.prepare(
    'SELECT value FROM auth_ephemeral_state WHERE namespace = ? AND key_hash = ?',
  ).get(namespace, key) as { value: string } | undefined;
  const write = (value: string) => db.prepare(
    'UPDATE auth_ephemeral_state SET value = ? WHERE namespace = ? AND key_hash = ?',
  ).run(value, namespace, key);
  try {
    db.transaction(() => {
      const inserted = db.prepare(
        'INSERT INTO auth_ephemeral_state(namespace, key_hash, value, expires_at) VALUES (:namespace, :key, :value, :expires)',
      ).run({ namespace, key, value: 'initial', expires: Date.now() + 60_000 });
      const insertedRow = db.prepare(
        'SELECT value FROM auth_ephemeral_state WHERE rowid = :id AND namespace = :namespace AND key_hash = :key',
      ).get({ id: inserted.lastInsertRowid, namespace, key }) as { value: string } | undefined;
      if (inserted.changes !== 1 || !Number.isSafeInteger(inserted.lastInsertRowid)
        || Number(inserted.lastInsertRowid) < 1 || insertedRow?.value !== 'initial') {
        throw new Error('Remote generated row ID and named SQL round-trip compatibility failed');
      }
      db.transaction(() => write('nested'))();
      const innerRollback = new Error('Inner rollback');
      try {
        db.transaction(() => { write('discard'); throw innerRollback; })();
      } catch (error) {
        if (error !== innerRollback) throw error;
      }
      if (read()?.value !== 'nested') throw new Error('Remote nested transaction compatibility failed');
      const claim = () => db.prepare(
        'DELETE FROM auth_ephemeral_state WHERE namespace = ? AND key_hash = ? RETURNING value',
      ).get(namespace, key) as { value: string } | undefined;
      if (claim()?.value !== 'nested' || claim() !== undefined) {
        throw new Error('Remote atomic token claim compatibility failed');
      }
      // Leave one record in the outer transaction to prove rollback removes it.
      db.prepare(
        'INSERT INTO auth_ephemeral_state(namespace, key_hash, value, expires_at) VALUES (?, ?, ?, ?)',
      ).run(namespace, key, 'rollback', Date.now() + 60_000);
      throw rolledBack;
    }).immediate();
  } catch (error) {
    if (error !== rolledBack) throw error;
  }
  if (db.inTransaction || read() !== undefined) throw new Error('Remote transaction rollback compatibility failed');
}
