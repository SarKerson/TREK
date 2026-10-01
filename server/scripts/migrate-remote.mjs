// Build server/shared first. Supply secrets through the environment, never CLI args.
// VERCEL=1; TURSO_DATABASE_URL; TURSO_AUTH_TOKEN; JWT_SECRET; ENCRYPTION_KEY.
// Full first setup additionally requires ADMIN_EMAIL and ADMIN_PASSWORD.
// --schema-only prepares storage while leaving ownerless request startup blocked.
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
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
const { RemoteLibsqlConnection } = require('../dist/db/remote-connection.js');
const { migrateRemoteDatabase, recoverRemoteInitialOwner } = require('../dist/db/remote-schema.js');
const { validateSecureAdminBootstrap } = require('../dist/db/seeds.js');
const { verifyRemoteDatabaseCompatibility } = require('../dist/db/remote-compatibility.js');
if (recoverInitialOwner) validateSecureAdminBootstrap();
const config = readRemoteDatabaseConfig();
if (!config) throw new Error('Remote database configuration is required');
if (!recoverInitialOwner) {
  const db = new LibsqlConnection(config.url, config.authToken);
  try { migrateRemoteDatabase(db, { initializeOwner: !schemaOnly }); } finally { db.close(); }
}
// Test the exact runtime facade: requests cannot rely on migration-local state.
const fresh = new RemoteLibsqlConnection(config.url, config.authToken);
try {
  verifyRemoteDatabaseCompatibility(fresh);
  const read = fresh.prepare('SELECT version FROM schema_version');
  const initialVersion = read.get()?.version;
  if (!Number.isSafeInteger(initialVersion)) throw new Error('Remote runtime idle probe requires a valid schema version');
  console.log('Remote runtime SQL probe passed; verifying idle resume after 65 seconds');
  // No transaction or native stream remains open during either bounded wait.
  await setTimeout(35_000);
  await setTimeout(30_000);
  if (read.get()?.version !== initialVersion) throw new Error('Remote runtime schema changed during idle resume verification');
  verifyRemoteDatabaseCompatibility(fresh);
  console.log('Remote runtime idle resume and transaction compatibility verified');
} finally {
  fresh.close();
}
// The runtime probe must pass while the failed release's lock still exists.
// Recovery then commits the owner and removes that lock atomically.
if (recoverInitialOwner) {
  const recovery = new LibsqlConnection(config.url, config.authToken);
  try { recoverRemoteInitialOwner(recovery); } finally { recovery.close(); }
}
console.log(schemaOnly
  ? 'Remote schema and SQL compatibility verified; request startup still requires a configured owner'
  : 'Remote database and SQL compatibility are ready for this release');
