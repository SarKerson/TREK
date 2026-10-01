# Private family deployment on Vercel

Status: implementation prepared; **not live or deployment-verified yet**. This is
an optional deployment path; persistent-host/Docker use remains supported.

## Services and access

Use Node.js 24 with Fluid Compute. Functions are pinned to Tokyo (`hnd1`), near
the Turso database. Application data stays in Turso and uploaded files in a
**private** Vercel Blob store, behind TREK's authorization checks. Public signup
must stay disabled; the initial owner adds or invites family members.

Current free allowances, checked September 2026:

- Turso Free (the integration's Starter tier): 5 GB storage, 500 million rows
  read and 10 million rows written per month. These count database operations,
  not page views. [Turso pricing](https://turso.tech/pricing)
- Blob on Hobby: 1 GB average storage, 10 GB monthly Blob transfer, 10,000 simple
  operations and 2,000 advanced operations. Private delivery also consumes
  Function/CDN transfer. Hitting Hobby limits can interrupt access until the
  allowance resets; these are not unlimited family-photo backups.
  [Blob usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)

## First-release scope

Approved omissions: persistent plugins, scheduled background autosync, full
instance backup/restore, and MCP. The desktop/mobile admin/settings screens show
these limits. Manual document sync remains supported. Database/storage-provider
recovery is separate from TREK's disabled instance-backup interface.

Core trip files and supported large-media flows use private direct upload
staging. Remaining multipart routes currently have a conservative **4,000,000
byte whole-request limit**, including avatars, covers, place images, GPX/map and
booking imports. The owner accepted this first-release limit on October 1, 2026.
Deployment readiness still requires secure configuration and live verification.

The optional KItinerary native booking parser is not bundled. AI parsing needs a
separately configured provider and is not configured or paid for by deployment.
When used, booking imports run within the request for at most 240 seconds and
persist their progress/results for cross-instance polling and reload recovery.
An interrupted or timed-out job becomes a visible failure, never endless progress.

WebSockets use the same HTTP-server export as the API. They reconnect after the
300-second function lifetime; shared events/auth state live in the database.
[WebSockets on Vercel](https://vercel.com/docs/functions/websockets)

## Configuration

Configure secrets through secure provider dashboards, never committed files or
client-visible `VITE_*` values. Required variable names:

- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- `BLOB_STORE_ID` for the connected store's OIDC access; legacy fallback:
  `BLOB_READ_WRITE_TOKEN`
- `JWT_SECRET`, `ENCRYPTION_KEY`: distinct, stable values, at least 32 characters
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` for secure initial-owner creation
- `APP_URL`, `ALLOWED_ORIGINS` matching the final HTTPS origin
- `NODE_OPTIONS=--experimental-require-module` in each deployed environment

The Node.js 24 Lambda runtime can disable `require(ESM)`, even though local Node
24 enables it by default. TREK's CommonJS server needs this interop for current
DOMPurify/jsdom dependencies. Set the flag before deploying; changing a build
script alone does not enable it in the running Function. Do not downgrade jsdom
or replace HTML sanitization to hide a loader failure.
[Upstream runtime guidance](https://github.com/kkomelin/isomorphic-dompurify/wiki/Workaround:-%60ERR_REQUIRE_ESM%60-on-Vercel---Netlify---AWS-Lambda)

Preserve `ENCRYPTION_KEY`: replacing it makes saved encrypted credentials
unreadable. Change `JWT_SECRET` in deployment configuration to revoke sessions;
in-app rotation is disabled. Keep public registration disabled, and configure
passkey RP/origins only after the final hostname is known. Preview and Production
must use isolated data stores/secrets before family data is added. The initial
integration currently binds the same empty database to Preview and Production.
Do not run a preview migration against that shared binding. Use the intended
Production-scoped database for the first release; enable provider preview
branching or separate the stores before later preview deployments.

Static SPA responses carry CSP, anti-framing, MIME-sniffing and referrer headers
from `vercel.json`; a parity test checks its default CSP against Helmet. Custom
routing-engine origins must also be added to the deployment CSP and verified in
the browser, because static HTML cannot read per-instance database settings.

## Build and migration safety

`vercel.json` compiles shared contracts, typechecks/compiles Nest with decorator
metadata, smoke-tests the compiled HTTP entry with the real Node loader, builds
the client, then runs the remote release migration and SQL
compatibility probe before publication. Request startup only checks readiness.
An unconfigured owner, wrong schema, SQL-probe failure, or active migration lock
must stop startup rather than fall back to local SQLite or default credentials.
The schema check requires an exact release version: a migration can make old
function instances fail readiness, and rolling back code alone may not restore
service. A migration lock also stops fresh instances while a release is running.
Plan a controlled maintenance window for later releases, with a verified recovery
point and compatible rollback plan. The initial setup has no live family users.

Do not run overlapping migrations. A failed migration deliberately retains its
lock. Before recovering it, inspect the deployment error, verify no migration is
still running, inspect the database schema/version and integrity, and establish a
provider snapshot/recovery point. Only remove a stale lock after resolving the
underlying failure and verifying the migration state. Do not blindly delete the
lock, edit migration history, reset the database, or repeatedly retry a failed
release against family data.

### Recovering the first owner after a failed initial build

There is one narrowly scoped recovery for an initial build that completed schema
version 250, then failed before creating any user (for example, a rejected
`ADMIN_PASSWORD`). First confirm that the failed deployment is terminal and that
no other build or release is running against this database. This is an operator
check: the stored timestamp alone cannot prove a previous process has stopped.

Correct `ADMIN_EMAIL` / `ADMIN_PASSWORD` securely in the deployment dashboard.
The password must have at least 12 characters, including an uppercase letter,
lowercase letter, number, and special character, and pass TREK's password policy.
For exactly one build, set `TREK_RECOVER_INITIAL_OWNER=1`, then run the normal
build command. Do not combine recovery with `--schema-only`.

Recovery validates the credentials before writing, checks SQL compatibility on a
fresh connection, and requires exactly schema 250, the existing singleton lock,
zero users, foreign-key enforcement, and valid foreign-key references. It never
replays migrations or removes the lock first. It prepares the password hash
before the database transaction, then holds an immediate write transaction while
rechecking the lock/schema/users, seeding, validating, and removing the same lock.
Any failure rolls back those writes and retains the failed release's lock.

Remove `TREK_RECOVER_INITIAL_OWNER` immediately after a successful build. Leaving
it set deliberately makes the next build fail rather than run ordinary migrations
or reset an existing account. This path cannot recover a partial schema migration,
an existing user database, or a later schema version; those require investigation.
New ordinary initial builds now reject invalid owner credentials before acquiring
a lock or changing schema.

## Verification

Run checks serially on a memory-constrained machine:

```sh
npm run build --workspace=shared
npm run typecheck --workspace=shared
npm run typecheck --workspace=server
npm run typecheck:tests --workspace=server
npm run typecheck --workspace=client
npm run i18n:parity:strict --workspace=shared
npm run test --workspace=server -- --maxWorkers=1
npm run test --workspace=client -- --maxWorkers=1
npm run build --workspace=server
npm run test:runtime --workspace=server
npm run build --workspace=client
```

The runtime smoke test uses an isolated in-memory database and fixed test-only
configuration. It checks sanitizer behavior, a real `/api/health` request, and
unauthenticated rejection without reading deployment credentials or connecting
to Turso/Blob. It also catches SDK subpath imports that test aliases can conceal.
It extracts real text from a small PDF, then repeats startup with the native
canvas package unavailable: health/auth/text must still work and only PDF
extraction may fail with a bounded warning. PDF parsing is lazy-loaded.

Vercel's file tracing does not detect PDF.js's dynamic canvas/worker loads.
`includeFiles` explicitly retains the canvas wrapper, Linux glibc native binding,
and the CJS PDF worker. Keep these entries when updating PDF dependencies;
source-directory smoke tests alone do not validate the final packaged artifact.

A compilation or local mock is not deployed validation. Before family use, verify
owner login and closed public signup, top-level HTML security headers, two-client
trip edits across reconnects, cross-trip/owner isolation, upload/download and
recovery after a cold start. Verify direct uploads use the private store and
check usage dashboards. Recheck Preview and Production separately.
