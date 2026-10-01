// Build server/shared first. Supply secrets through the environment, never CLI args.
// VERCEL=1; TURSO_DATABASE_URL; TURSO_AUTH_TOKEN; JWT_SECRET; ENCRYPTION_KEY.
// Full first setup additionally requires ADMIN_EMAIL and ADMIN_PASSWORD.
// --schema-only prepares storage while leaving ownerless request startup blocked.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isVercelRuntime, readRemoteDatabaseConfig, vercelSecrets } = require('../dist/app-config/runtime.js');
if (!isVercelRuntime()) throw new Error('Run remote release migrations with VERCEL=1 and the deployment secrets');
vercelSecrets();
const schemaOnly = process.argv.slice(2).includes('--schema-only');
if (process.argv.slice(2).some(arg => arg !== '--schema-only')) throw new Error('Unknown migration option');
const recoveryFlag = process.env.TREK_RECOVER_INITIAL_OWNER;
if (recoveryFlag && recoveryFlag !== '1') throw new Error('TREK_RECOVER_INITIAL_OWNER must be unset or exactly 1');
const recoverInitialOwner = recoveryFlag === '1';
if (recoverInitialOwner && schemaOnly) throw new Error('Initial-owner recovery cannot run with --schema-only');
const { LibsqlConnection } = require('../dist/db/adapter.js');
const { migrateRemoteDatabase, recoverRemoteInitialOwner } = require('../dist/db/remote-schema.js');
const { validateSecureAdminBootstrap } = require('../dist/db/seeds.js');
const { verifyRemoteDatabaseCompatibility } = require('../dist/db/remote-compatibility.js');
if (recoverInitialOwner) validateSecureAdminBootstrap();
const config = readRemoteDatabaseConfig();
if (!config) throw new Error('Remote database configuration is required');
const db = new LibsqlConnection(config.url, config.authToken);
try {
  if (!recoverInitialOwner) migrateRemoteDatabase(db, { initializeOwner: !schemaOnly });
  // Test a new direct connection too: request startup cannot rely on migration
  // connection-local PRAGMAs or state that is lost after this process exits.
  const fresh = new LibsqlConnection(config.url, config.authToken);
  try {
    verifyRemoteDatabaseCompatibility(fresh);
  } finally {
    fresh.close();
  }
  // The fresh-connection probe must pass while the failed release's lock still
  // exists. Recovery then commits the owner and removes that lock atomically.
  if (recoverInitialOwner) recoverRemoteInitialOwner(db);
  console.log(schemaOnly
    ? 'Remote schema and SQL compatibility verified; request startup still requires a configured owner'
    : 'Remote database and SQL compatibility are ready for this release');
} finally {
  db.close();
}
