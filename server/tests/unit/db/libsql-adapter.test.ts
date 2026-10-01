import { afterEach, describe, expect, it } from 'vitest';
import { LibsqlConnection } from '../../../src/db/adapter';
import { createTables } from '../../../src/db/schema';
import { runMigrations, expectedSchemaVersion } from '../../../src/db/migrations';

const connections: LibsqlConnection[] = [];
function connect() {
  const db = new LibsqlConnection(':memory:');
  connections.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT, data BLOB)');
  return db;
}
afterEach(() => { connections.splice(0).forEach(db => db.close()); });

describe('published libsql synchronous adapter compatibility', () => {
  it('binds positional, array, named, null, binary and numeric values without leaking metadata', () => {
    const db = connect();
    expect(db.prepare('SELECT ? AS value').get(null)).toEqual({ value: null });
    expect(db.prepare('SELECT ? AS value').get(Buffer.from('single'))).toEqual({ value: Buffer.from('single') });
    expect(db.prepare('INSERT INTO sample VALUES (?, ?, ?)').run(1, 'first', Buffer.from('bytes'))).toEqual({ changes: 1, lastInsertRowid: 1 });
    db.prepare('INSERT INTO sample VALUES (?, ?, ?)').run([2, null, null]);
    expect(db.prepare('SELECT id, value FROM sample WHERE id = @id').get({ id: 1 })).toEqual({ id: 1, value: 'first' });
    expect(db.prepare('SELECT * FROM sample WHERE id = ?').get(2)).toEqual({ id: 2, value: null, data: null });
    expect(db.prepare('SELECT * FROM sample WHERE id = ?').get(99)).toBeUndefined();
    expect(db.prepare('SELECT data FROM sample WHERE id = ?').get(1)).toEqual({ data: Buffer.from('bytes') });
    expect(db.prepare('SELECT id FROM sample ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
  });
  it('commits and rolls back transactions and preserves return values', () => {
    const db = connect();
    expect(db.transaction((id: number) => db.prepare('INSERT INTO sample(id) VALUES (?)').run(id).changes)(1)).toBe(1);
    expect(() => db.transaction(() => { db.prepare('INSERT INTO sample(id) VALUES (?)').run(2); throw new Error('abort'); })()).toThrow('abort');
    expect(db.prepare('SELECT id FROM sample').all()).toEqual([{ id: 1 }]);
    expect(db.inTransaction).toBe(false);
  });
  it('uses nested savepoints, allowing inner rollback and outer commit', () => {
    const db = connect();
    db.transaction(() => {
      db.prepare('INSERT INTO sample(id) VALUES (?)').run(1);
      expect(() => db.transaction(() => { db.prepare('INSERT INTO sample(id) VALUES (?)').run(2); throw new Error('inner'); })()).toThrow('inner');
      db.transaction(() => db.prepare('INSERT INTO sample(id) VALUES (?)').run(3))();
    }).immediate();
    expect(db.prepare('SELECT id FROM sample ORDER BY id').all()).toEqual([{ id: 1 }, { id: 3 }]);
  });
  it('rolls back nested successful writes when the outer transaction fails', () => {
    const db = connect();
    expect(() => db.transaction(() => { db.transaction(() => db.prepare('INSERT INTO sample(id) VALUES (1)').run())(); throw new Error('outer'); }).exclusive()).toThrow('outer');
    expect(db.prepare('SELECT id FROM sample').all()).toEqual([]);
  });
  it('rejects asynchronous callbacks and enforces foreign keys', () => {
    const db = connect();
    expect(() => db.transaction(() => Promise.resolve())()).toThrow('must be synchronous');
    db.exec('CREATE TABLE child (parent INTEGER REFERENCES sample(id))');
    expect(() => db.prepare('INSERT INTO child VALUES (999)').run()).toThrow();
  });
  it('runs the complete original schema and append-only migrations on libsql', () => {
    const db = connect();
    createTables(db);
    runMigrations(db);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: expectedSchemaVersion(db) });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    runMigrations(db);
  });
  it('migrates an initialized zero-version row without duplicating the version', () => {
    const db = connect();
    createTables(db);
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES (0)');
    runMigrations(db);
    expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: expectedSchemaVersion(db) }]);
  });
  it('refuses unsupported schema versions without running migrations', () => {
    const db = connect();
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES (-1)');
    expect(() => runMigrations(db)).toThrow('schema version is not supported');
    db.prepare('UPDATE schema_version SET version = ?').run(expectedSchemaVersion(db) + 1);
    expect(() => runMigrations(db)).toThrow('schema version is not supported');
  });
  it('returns and deletes a one-time row atomically', () => {
    const db = connect();
    db.prepare('INSERT INTO sample(id, value) VALUES (?, ?)').run(1, 'once');
    expect(db.prepare('DELETE FROM sample WHERE id = ? RETURNING value').get(1)).toEqual({ value: 'once' });
    expect(db.prepare('DELETE FROM sample WHERE id = ? RETURNING value').get(1)).toBeUndefined();
  });
});
