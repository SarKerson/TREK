// Run the compiled public entry with Node's real loader, outside Vitest's
// transforms/aliases. Use only isolated fixtures, never deployment credentials.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Server, get } = require('node:http');
// Use Node's HTTP client so the smoke exercises the same request listener as
// the Function without a test runner or a fetch adapter.
function request(url) {
  return new Promise((resolve, reject) => {
    get(url, { signal: AbortSignal.timeout(20_000) }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

process.env = {
  NODE_ENV: 'test',
  VERCEL: '1',
  LOG_LEVEL: 'error',
  COOKIE_SECURE: 'false',
  JWT_SECRET: 'runtime-smoke-signing-fixture-not-a-secret',
  ENCRYPTION_KEY: 'runtime-smoke-encryption-fixture-not-a-secret',
  ADMIN_EMAIL: 'runtime-smoke@example.invalid',
  ADMIN_PASSWORD: 'Runtime-Smoke-Fixture-Only-123!',
  BLOB_STORE_ID: 'store_runtime_smoke',
};

async function main() {
  assert.equal(process.features.require_module, true, 'Set NODE_OPTIONS=--experimental-require-module');
  const { sanitizeInlineHtml, sanitizeRichTextHtml } = require('@trek/shared');
  assert.equal(sanitizeInlineHtml('<b onclick="alert(1)">safe</b><script>alert(1)</script>'), '<b>safe</b>');
  assert.equal(sanitizeRichTextHtml('<a href="javascript:alert(1)">safe</a>'), '<a>safe</a>');

  // NODE_ENV=test creates an in-memory database; VERCEL=1 exercises the actual
  // serverless module graph, Blob registry, capability gates, and HTTP export.
  const server = require('../../api/index.js');
  assert.ok(server instanceof Server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await request(`${origin}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
    const protectedResponse = await request(`${origin}/api/trips`);
    assert.equal(protectedResponse.status, 401);
    process.stdout.write('[runtime smoke] Compiled Vercel entry, sanitizer, health and auth guard passed\n');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(
  // This standalone smoke process owns the app's lifecycle and background handles.
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
