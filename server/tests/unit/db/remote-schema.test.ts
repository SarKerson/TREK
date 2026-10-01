import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { LibsqlConnection } from '../../../src/db/adapter';
import { migrateRemoteDatabase, assertRemoteDatabaseReady, recoverRemoteInitialOwner } from '../../../src/db/remote-schema';
import { verifyRemoteDatabaseCompatibility } from '../../../src/db/remote-compatibility';

let db: LibsqlConnection;
beforeEach(() => {
  db = new LibsqlConnection(':memory:');
  vi.stubEnv('ADMIN_EMAIL', 'owner@example.com');
  vi.stubEnv('ADMIN_PASSWORD', 'Local-Test-Password-123!');
  vi.stubEnv('DEMO_MODE', 'false');
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('explicit remote release migration', () => {
  it('migrates once, seeds an owner, validates without writes and supports reruns', () => {
    migrateRemoteDatabase(db);
    expect(db.prepare('SELECT id FROM trek_migration_lock').all()).toEqual([]);
    const exec = vi.spyOn(db, 'exec');
    assertRemoteDatabaseReady(db);
    expect(exec).not.toHaveBeenCalled();
    exec.mockRestore();
    migrateRemoteDatabase(db);
    expect(db.prepare('SELECT count(*) AS total FROM users').get()).toEqual({ total: 1 });
    expect(db.prepare('SELECT count(*) AS total FROM schema_version').get()).toEqual({ total: 1 });
  });
  it('refuses concurrent runs and prevents serving a locked or stale schema', () => {
    migrateRemoteDatabase(db);
    db.prepare('INSERT INTO trek_migration_lock(id) VALUES (1)').run();
    expect(() => migrateRemoteDatabase(db)).toThrow();
    expect(() => assertRemoteDatabaseReady(db)).toThrow('migration is in progress');
    db.prepare('DELETE FROM trek_migration_lock').run();
    db.prepare('UPDATE schema_version SET version = -1').run();
    expect(() => assertRemoteDatabaseReady(db)).toThrow('schema does not match');
  });
  it('rejects invalid bootstrap credentials before acquiring a new lock', () => {
    migrateRemoteDatabase(db);
    db.prepare('DELETE FROM users').run();
    expect(() => assertRemoteDatabaseReady(db)).toThrow('owner is not configured');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('ADMIN_PASSWORD', '');
    expect(() => migrateRemoteDatabase(db)).toThrow('requires ADMIN_EMAIL');
    expect(db.prepare('SELECT id FROM trek_migration_lock').get()).toBeUndefined();
  });
  it('requires explicit owner credentials even when the release operator is not on Vercel', () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('ADMIN_PASSWORD', '');
    expect(() => migrateRemoteDatabase(db)).toThrow('requires ADMIN_EMAIL and ADMIN_PASSWORD');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });
  it('fails closed when FK enforcement is off or version rows are ambiguous', () => {
    migrateRemoteDatabase(db);
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => assertRemoteDatabaseReady(db)).toThrow('foreign key enforcement');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('INSERT INTO schema_version (version) SELECT version FROM schema_version');
    expect(() => assertRemoteDatabaseReady(db)).toThrow('schema does not match');
    expect(() => migrateRemoteDatabase(db)).toThrow('multiple schema versions');
  });
  it('rolls back all secure seed changes if a later seed fails', () => {
    migrateRemoteDatabase(db);
    db.exec('DELETE FROM users; DELETE FROM categories');
    db.exec("CREATE TRIGGER reject_category_seed BEFORE INSERT ON categories BEGIN SELECT RAISE(ABORT, 'seed failed'); END");
    expect(() => migrateRemoteDatabase(db)).toThrow('seed failed');
    expect(db.prepare('SELECT id FROM users').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM trek_migration_lock').get()).toEqual({ id: 1 });
  });
  it('can prepare the schema separately without allowing ownerless request startup', () => {
    vi.stubEnv('ADMIN_EMAIL', '');
    vi.stubEnv('ADMIN_PASSWORD', '');
    migrateRemoteDatabase(db, { initializeOwner: false });
    expect(db.prepare('SELECT id FROM trek_migration_lock').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM users').all()).toEqual([]);
    expect(() => assertRemoteDatabaseReady(db)).toThrow('owner is not configured');
    vi.stubEnv('ADMIN_EMAIL', 'owner@example.com');
    vi.stubEnv('ADMIN_PASSWORD', 'Local-Test-Password-123!');
    migrateRemoteDatabase(db);
    expect(() => assertRemoteDatabaseReady(db)).not.toThrow();
  });
  it('verifies remote transaction primitives without leaving probe data', () => {
    migrateRemoteDatabase(db);
    verifyRemoteDatabaseCompatibility(db);
    expect(db.prepare('SELECT * FROM auth_ephemeral_state').all()).toEqual([]);
  });
});

describe('explicit initial-owner recovery', () => {
  beforeEach(() => {
    migrateRemoteDatabase(db, { initializeOwner: false });
    db.exec('DELETE FROM categories');
    db.prepare("INSERT INTO trek_migration_lock(id, started_at) VALUES (1, '2026-10-01 14:40:00')").run();
  });

  it('seeds and unlocks atomically without replaying schema migrations or hashing inside the transaction', () => {
    const hashSync = bcrypt.hashSync;
    vi.spyOn(bcrypt, 'hashSync').mockImplementation((password, salt) => {
      expect(db.inTransaction).toBe(false);
      return hashSync(password, salt);
    });
    const exec = vi.spyOn(db, 'exec');
    recoverRemoteInitialOwner(db);
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
    expect(db.prepare('SELECT email, role FROM users').all()).toEqual([{ email: 'owner@example.com', role: 'admin' }]);
    expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 250 }]);
    expect(db.prepare('SELECT count(*) AS count FROM categories').get()).toEqual({ count: 10 });
    expect(() => assertRemoteDatabaseReady(db)).not.toThrow();
    expect(() => recoverRemoteInitialOwner(db)).toThrow('existing singleton migration lock');
  });

  it('keeps the failure lock untouched when the new password is invalid', () => {
    vi.stubEnv('ADMIN_PASSWORD', 'not-strong-enough');
    const exec = vi.spyOn(db, 'exec');
    expect(() => recoverRemoteInitialOwner(db)).toThrow('password policy');
    expect(exec).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM trek_migration_lock').all()).toEqual([{ id: 1, started_at: '2026-10-01 14:40:00' }]);
    expect(db.prepare('SELECT id FROM users').all()).toEqual([]);
  });

  it.each(['admin', 'user'])('refuses any existing %s account', (role) => {
    db.prepare('INSERT INTO users(username,email,password_hash,role) VALUES (?,?,?,?)').run('existing', 'existing@example.com', 'unused', role);
    expect(() => recoverRemoteInitialOwner(db)).toThrow('existing users');
    expect(db.prepare('SELECT id FROM trek_migration_lock').get()).toEqual({ id: 1 });
  });

  it.each([249, 251])('refuses schema version %s', (version) => {
    db.prepare('UPDATE schema_version SET version = ?').run(version);
    expect(() => recoverRemoteInitialOwner(db)).toThrow('schema does not match');
    expect(db.prepare('SELECT id FROM users').all()).toEqual([]);
  });

  it('refuses ambiguous versions and a missing, malformed, or nonsingleton lock', () => {
    db.exec('INSERT INTO schema_version(version) VALUES (250)');
    expect(() => recoverRemoteInitialOwner(db)).toThrow('schema does not match');
    db.exec('DELETE FROM schema_version; INSERT INTO schema_version(version) VALUES (250); DELETE FROM trek_migration_lock');
    expect(() => recoverRemoteInitialOwner(db)).toThrow('existing singleton migration lock');
    db.exec("INSERT INTO trek_migration_lock(id, started_at) VALUES (1, 'invalid')");
    expect(() => recoverRemoteInitialOwner(db)).toThrow('existing singleton migration lock');
    db.exec("DROP TABLE trek_migration_lock; CREATE TABLE trek_migration_lock(id INTEGER, started_at TEXT); INSERT INTO trek_migration_lock VALUES (1, '2026-10-01 14:40:00'), (2, '2026-10-01 14:40:00')");
    expect(() => recoverRemoteInitialOwner(db)).toThrow('existing singleton migration lock');
  });

  it('requires FK enforcement and refuses existing integrity violations', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => recoverRemoteInitialOwner(db)).toThrow('foreign key enforcement');
    db.exec("INSERT INTO realtime_presence(socket_id, scope, target_id, user_id, expires_at) VALUES(1, 'trip', 1, 999, 1)");
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => recoverRemoteInitialOwner(db)).toThrow('foreign key validation');
    expect(db.prepare('SELECT id FROM users').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM trek_migration_lock').get()).toEqual({ id: 1 });
  });

  it.each(['seed', 'unlock'])('rolls back all writes if %s fails', (step) => {
    if (step === 'seed') db.exec("CREATE TRIGGER reject_seed BEFORE INSERT ON categories BEGIN SELECT RAISE(ABORT, 'test seed failure'); END");
    else db.exec("CREATE TRIGGER reject_unlock BEFORE DELETE ON trek_migration_lock BEGIN SELECT RAISE(ABORT, 'test unlock failure'); END");
    expect(() => recoverRemoteInitialOwner(db)).toThrow(`test ${step} failure`);
    expect(db.prepare('SELECT id FROM users').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM categories').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM trek_migration_lock').get()).toEqual({ id: 1 });
  });

  it.each(['lock', 'user', 'schema'])('rechecks concurrent %s changes after obtaining the transaction lock', (change) => {
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(fn => {
      if (change === 'lock') db.exec("UPDATE trek_migration_lock SET started_at = '2026-10-01 14:41:00'");
      if (change === 'user') db.exec("INSERT INTO users(username,email,password_hash,role) VALUES ('other', 'other@example.com', 'unused', 'admin')");
      if (change === 'schema') db.exec('UPDATE schema_version SET version = 251');
      return transaction(fn);
    });
    expect(() => recoverRemoteInitialOwner(db)).toThrow();
    expect(db.prepare("SELECT id FROM users WHERE email = 'owner@example.com'").get()).toBeUndefined();
    expect(db.prepare('SELECT id FROM trek_migration_lock').get()).toEqual({ id: 1 });
  });
});
