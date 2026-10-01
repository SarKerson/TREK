// Compiled-node HTTP regression, with no Vitest transforms or service mocks.
// Copies only build artifacts into a disposable directory. Never load .env,
// deployment credentials, the repository's data directory, or production data.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const fixtureEmail = 'compiled-smoke@example.invalid';
const fixturePassword = 'Compiled-Fixture-Only-123!';
const nextPassword = 'Changed-Fixture-Only-456!';

async function childMain(root) {
  process.chdir(root);
  require('reflect-metadata');
  // Open the normal compiled DB module against the explicit fixture file before
  // selecting test lifecycle semantics (which only suppress background jobs).
  // SQLite and the storage driver stay real; no module/DI/loader replacements.
  process.env.NODE_ENV = 'development';
  const database = require(path.join(root, 'server/dist/db/database.js'));
  process.env.NODE_ENV = 'test';
  const { buildApp, getHttpServer } = require(path.join(root, 'server/dist/bootstrap.js'));
  const app = await buildApp();
  const server = getHttpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.send({ port: server.address().port });
  process.on('message', async (message) => {
    if (message !== 'stop') return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
    database.closeDb();
    process.exit(0);
  });
}

function request(origin, route, { method = 'GET', cookie, json, bytes, headers = {} } = {}) {
  if (json !== undefined) {
    bytes = Buffer.from(JSON.stringify(json));
    headers = { 'Content-Type': 'application/json', ...headers };
  }
  if (bytes) headers = { 'Content-Length': bytes.length, ...headers };
  if (cookie) headers.Cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, origin), {
      method, headers, signal: AbortSignal.timeout(20_000),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let parsed;
        if (res.headers['content-type']?.includes('application/json')) parsed = JSON.parse(body.toString());
        resolve({ status: res.statusCode, headers: res.headers, bytes: body, json: parsed });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

function status(response, expected, label) {
  assert.equal(response.status, expected, `${label}: expected ${expected}, got ${response.status}; ${JSON.stringify(response.json)}`);
  return response;
}

function session(response) {
  const raw = response.headers['set-cookie']?.find((cookie) => cookie.startsWith('trek_session='));
  assert.ok(raw, 'HTTP authentication did not set a session cookie');
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  return raw.split(';')[0];
}

function multipart(filename, content, contentType = 'text/plain') {
  const boundary = 'trek-compiled-smoke-boundary';
  return {
    method: 'POST',
    bytes: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nDisposable regression fixture\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      content, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function main() {
  const repo = path.resolve(__dirname, '../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-compiled-flows-'));
  const children = new Set();
  const start = () => new Promise((resolve, reject) => {
    const child = fork(__filename, ['--child', root], {
      cwd: root, silent: true,
      env: {
        NODE_ENV: 'development', LOG_LEVEL: 'error', COOKIE_SECURE: 'false', TZ: 'UTC',
        TREK_DB_FILE: path.join(root, 'server/data/fixture.db'),
        ENCRYPTION_KEY: 'compiled-fixture-encryption-key-not-a-real-secret',
        ADMIN_EMAIL: fixtureEmail, ADMIN_PASSWORD: fixturePassword,
      },
    });
    children.add(child);
    let logs = '';
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Compiled app did not start within 45 seconds\n${logs.slice(-8000)}`));
    }, 45_000);
    child.once('message', ({ port }) => {
      clearTimeout(timer);
      resolve({ child, origin: `http://127.0.0.1:${port}` });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (code) reject(new Error(`Compiled app exited (${code})\n${logs.slice(-8000)}`));
    });
    child.once('error', reject);
  });
  const stop = async ({ child }) => {
    const exit = once(child, 'exit');
    child.send('stop');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { assert.equal((await exit)[0], 0, 'Compiled app did not stop cleanly'); }
    finally { clearTimeout(timer); }
  };
  try {
    fs.mkdirSync(path.join(root, 'server/data'), { recursive: true });
    fs.cpSync(path.join(repo, 'server/dist'), path.join(root, 'server/dist'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'server/package.json'), path.join(root, 'server/package.json'));
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    if (fs.existsSync(path.join(repo, 'server/node_modules'))) {
      fs.symlinkSync(path.join(repo, 'server/node_modules'), path.join(root, 'server/node_modules'), 'dir');
    }
    fs.writeFileSync(path.join(root, 'server/data/.jwt_secret'), 'compiled-session-fixture-not-a-real-secret', { mode: 0o600 });

    const a = await start();
    status(await request(a.origin, '/api/health'), 200, 'health');
    status(await request(a.origin, '/api/trips'), 401, 'unauthenticated trips');
    status(await request(a.origin, '/api/auth/login', { method: 'POST', json: { email: fixtureEmail, password: 'Wrong-Fixture-Only' } }), 401, 'wrong password');
    const login = status(await request(a.origin, '/api/auth/login', {
      method: 'POST', json: { email: fixtureEmail, password: fixturePassword, remember: true },
    }), 200, 'fixture login');
    assert.equal(login.json.user.must_change_password, true);
    assert.equal(login.json.user.password_hash, undefined);
    const previousCookie = session(login);
    const beforeChange = await request(a.origin, '/api/trips', { cookie: previousCookie });
    // Current policy is UI-driven, not a server-side forced-change guard.
    status(beforeChange, 200, 'current pre-password-change API policy');
    console.log('[compiled flows] Login, HttpOnly session, unauthorized denial passed; forced-change is a returned UI flag (API remains accessible)');
    const changed = status(await request(a.origin, '/api/auth/me/password', {
      method: 'PUT', cookie: previousCookie,
      json: { current_password: fixturePassword, new_password: nextPassword },
    }), 200, 'password change');
    const cookie = session(changed);
    assert.notEqual(cookie, previousCookie);
    status(await request(a.origin, '/api/auth/me', { cookie: previousCookie }), 401, 'old session after password change');
    const me = status(await request(a.origin, '/api/auth/me', { cookie }), 200, 'current session');
    assert.ok(!me.json.user.must_change_password);
    status(await request(a.origin, '/api/trips', { method: 'POST', cookie, json: {} }), 400, 'invalid trip rejected');
    const createBody = { title: 'Compiled fixture trip', description: 'Disposable local fixture', start_date: '2027-02-01', end_date: '2027-02-03' };
    const createOptions = { method: 'POST', cookie, json: createBody, headers: { 'X-Idempotency-Key': 'compiled-fixture-trip-create' } };
    const created = status(await request(a.origin, '/api/trips', createOptions), 201, 'trip create');
    const tripId = created.json.trip.id;
    assert.ok(Number.isSafeInteger(tripId));
    const replay = status(await request(a.origin, '/api/trips', createOptions), 201, 'idempotent trip replay');
    assert.equal(replay.json.trip.id, tripId);
    const b = await start();
    const outsider = status(await request(b.origin, '/api/auth/register', {
      method: 'POST', json: {
        username: 'compiled-outsider', email: 'compiled-outsider@example.invalid',
        password: 'Isolated-Outsider-Fixture-789!',
      },
    }), 201, 'disposable local second-user fixture');
    assert.equal(outsider.json.user.role, 'user');
    const outsiderCookie = session(outsider);
    status(await request(b.origin, `/api/trips/${tripId}`, { cookie: outsiderCookie }), 404, 'cross-owner trip read');
    status(await request(b.origin, `/api/trips/${tripId}`, { method: 'PUT', cookie: outsiderCookie, json: { title: 'Forbidden change' } }), 404, 'cross-owner trip write');
    const persisted = status(await request(b.origin, `/api/trips/${tripId}`, { cookie }), 200, 'cross-process trip read');
    assert.equal(persisted.json.trip.title, createBody.title);
    const replayOther = status(await request(b.origin, '/api/trips', createOptions), 201, 'cross-process replay');
    assert.equal(replayOther.json.trip.id, tripId);
    status(await request(b.origin, `/api/trips/${tripId}`, { method: 'PUT', cookie, json: { title: 'Updated from independent process' } }), 200, 'cross-process update');
    assert.equal(status(await request(a.origin, `/api/trips/${tripId}`, { cookie }), 200, 'original process refresh').json.trip.title, 'Updated from independent process');
    console.log('[compiled flows] Password rotation, prior-session revocation, validation, trip create/read/update, and replay across independent processes passed');

    const fixtureBytes = Buffer.from('TREK real compiled upload fixture\n0123456789abcdef\n');
    const upload = status(await request(a.origin, `/api/trips/${tripId}/files`, { ...multipart('fixture.txt', fixtureBytes), cookie }), 201, 'file upload');
    const file = upload.json.file;
    assert.ok(file.id);
    const download = `/api/trips/${tripId}/files/${file.id}/download`;
    status(await request(b.origin, download), 401, 'private file anonymous denial');
    status(await request(b.origin, download, { cookie: outsiderCookie }), 404, 'cross-owner file denial');
    status(await request(b.origin, `/api/trips/${tripId}/files`, { ...multipart('forbidden.txt', fixtureBytes), cookie: outsiderCookie }), 404, 'cross-owner upload denial');
    const readFile = status(await request(b.origin, download, { cookie }), 200, 'cross-process file download');
    assert.deepEqual(readFile.bytes, fixtureBytes);
    const range = status(await request(b.origin, download, { cookie, headers: { Range: 'bytes=5-18' } }), 206, 'file range');
    assert.deepEqual(range.bytes, fixtureBytes.subarray(5, 19));
    assert.equal(range.headers['content-range'], `bytes 5-18/${fixtureBytes.length}`);
    status(await request(b.origin, download, { cookie, headers: { Range: 'bytes=9999-' } }), 416, 'unsatisfiable range');
    const head = status(await request(b.origin, download, { method: 'HEAD', cookie }), 200, 'file HEAD');
    assert.equal(Number(head.headers['content-length']), fixtureBytes.length);
    assert.equal(head.bytes.length, 0);
    const conditional = status(await request(b.origin, download, { cookie, headers: { 'If-None-Match': readFile.headers.etag } }), 304, 'conditional file request');
    assert.equal(conditional.bytes.length, 0);
    status(await request(a.origin, `/api/trips/${tripId}/files`, { ...multipart('blocked.svg', Buffer.from('<svg></svg>'), 'image/svg+xml'), cookie }), 400, 'blocked upload type');
    const token = status(await request(a.origin, '/api/auth/resource-token', { method: 'POST', cookie, json: { purpose: 'download' } }), 200, 'one-use download grant');
    const tokenRoute = `${download}?token=${encodeURIComponent(token.json.token)}`;
    assert.deepEqual(status(await request(a.origin, tokenRoute), 200, 'one-use token download').bytes, fixtureBytes);
    status(await request(a.origin, tokenRoute), 401, 'reused download token');
    console.log('[compiled flows] Multipart upload, byte-perfect cross-process download, Range/HEAD/ETag, anonymous/cross-owner denial, blocked type, and single-use download token passed');

    await stop(a);
    await stop(b);
    const c = await start();
    assert.equal(status(await request(c.origin, `/api/trips/${tripId}`, { cookie }), 200, 'restart trip read').json.trip.title, 'Updated from independent process');
    assert.deepEqual(status(await request(c.origin, download, { cookie }), 200, 'restart file read').bytes, fixtureBytes);
    const relogin = status(await request(c.origin, '/api/auth/login', { method: 'POST', json: { email: fixtureEmail, password: nextPassword } }), 200, 'changed-password login after restart');
    assert.ok(!relogin.json.user.must_change_password);
    status(await request(c.origin, '/api/auth/login', { method: 'POST', json: { email: fixtureEmail, password: fixturePassword } }), 401, 'old password after restart');
    await stop(c);
    console.log('[compiled flows] Trip, file, existing session, and changed password persisted after all original processes stopped');
    console.log('[compiled flows] PASS: local compiled application only; Turso, Blob OIDC/direct upload, Vercel routing, and browser UI require separate verification');
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map((child) => once(child, 'exit').catch(() => {})));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(process.argv[2] === '--child' ? childMain(process.argv[3]) : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
