import type { DbConnection } from './adapter';
import { expectedSchemaVersion, runMigrations } from './migrations';
import { createTables } from './schema';
import { prepareSecureSeeds, runSeeds, validateSecureAdminBootstrap } from './seeds';

/** Cold starts are read-only: one release operator migrates before deploying. */
export function assertRemoteDatabaseReady(db: DbConnection, migrationOwner = false): void {
  if (!migrationOwner && db.prepare('SELECT id FROM trek_migration_lock WHERE id = 1').get()) {
    throw new Error('Remote database migration is in progress or requires operator recovery');
  }
  assertRemoteSchemaReady(db);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!admin) throw new Error('Remote database owner is not configured; complete secure setup before serving requests');
}

function assertRemoteSchemaReady(db: DbConnection): void {
  const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
  if (rows.length !== 1 || rows[0].version !== expectedSchemaVersion(db)) {
    throw new Error('Remote database schema does not match this release; run the database migration first');
  }
  const violations = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (violations?.foreign_keys !== 1) throw new Error('Remote database foreign key enforcement must be enabled');
}

function assertForeignKeyIntegrity(db: DbConnection): void {
  if (db.prepare('PRAGMA foreign_key_check').all().length) {
    throw new Error('Remote migration failed foreign key validation');
  }
}

function preflightOwnerSetup(db: DbConnection): void {
  const usersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!usersTable || !db.prepare('SELECT id FROM users LIMIT 1').get()) validateSecureAdminBootstrap();
}

/**
 * An explicit release operation, never called by request startup. The durable
 * singleton lock refuses overlapping runs, including after a crashed migration;
 * an operator must inspect and recover that run before removing its lock.
 */
export function migrateRemoteDatabase(db: DbConnection, options: { initializeOwner?: boolean } = {}): void {
  if (options.initializeOwner !== false) preflightOwnerSetup(db);
  db.exec(`CREATE TABLE IF NOT EXISTS trek_migration_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.prepare('INSERT INTO trek_migration_lock (id) VALUES (1)').run();
  // Deliberately retain the lock on error: raw legacy migrations cannot all be
  // wrapped in one transaction (one temporarily changes foreign_keys).
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  runMigrations(db);
  runSeeds(db, { secureBootstrap: true, initializeAdmin: options.initializeOwner !== false });
  assertForeignKeyIntegrity(db);
  if (options.initializeOwner === false) assertRemoteSchemaReady(db);
  else assertRemoteDatabaseReady(db, true);
  db.prepare('DELETE FROM trek_migration_lock WHERE id = 1').run();
}

interface MigrationLock { id: number; started_at: string }

function initialOwnerRecoveryLock(db: DbConnection): MigrationLock {
  // Deliberately restricted to the known initial release. Future schema changes
  // need their own reviewed recovery, not a generic stale-lock escape hatch.
  assertRemoteSchemaReady(db);
  if (expectedSchemaVersion(db) !== 250) throw new Error('Initial-owner recovery requires schema version 250');
  const locks = db.prepare('SELECT id, started_at FROM trek_migration_lock').all() as MigrationLock[];
  if (locks.length !== 1 || locks[0].id !== 1
    || typeof locks[0].started_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(locks[0].started_at)) {
    throw new Error('Initial-owner recovery requires the existing singleton migration lock');
  }
  if (db.prepare('SELECT id FROM users LIMIT 1').get()) {
    throw new Error('Initial-owner recovery refuses a database with existing users');
  }
  return locks[0];
}

/**
 * Explicit operator recovery after a terminal initial deployment failure. The
 * operator must verify that the prior release stopped and no release overlaps.
 * No schema migration is replayed, and the durable lock is never cleared first.
 */
export function recoverRemoteInitialOwner(db: DbConnection): void {
  validateSecureAdminBootstrap();
  const expectedLock = initialOwnerRecoveryLock(db);
  assertForeignKeyIntegrity(db);
  const seed = prepareSecureSeeds(db);
  db.transaction(() => {
    // IMMEDIATE serializes competing recoveries before checking their state;
    // normal migration attempts still encounter the durable singleton lock.
    const lock = initialOwnerRecoveryLock(db);
    if (lock.started_at !== expectedLock.started_at) {
      throw new Error('Initial-owner recovery migration lock changed; inspect the stopped release');
    }
    seed();
    assertForeignKeyIntegrity(db);
    assertRemoteDatabaseReady(db, true);
    const removed = db.prepare('DELETE FROM trek_migration_lock WHERE id = 1 AND started_at = ?').run(lock.started_at);
    if (removed.changes !== 1) throw new Error('Initial-owner recovery lost its migration lock');
  }).immediate();
}
