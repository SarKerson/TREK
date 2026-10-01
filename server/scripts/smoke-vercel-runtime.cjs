// Run the compiled public entry with Node's real loader, outside Vitest's
// transforms/aliases. Use only isolated fixtures, never deployment credentials.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Server, get } = require('node:http');
const Module = require('node:module');

const withoutCanvas = process.argv.includes('--without-canvas');
if (withoutCanvas) {
  const originalLoad = Module._load;
  Module._load = function (specifier, ...args) {
    if (specifier === '@napi-rs/canvas' || specifier.startsWith('@napi-rs/canvas-')) {
      const error = new Error('Simulated missing canvas binding');
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return originalLoad.call(this, specifier, ...args);
  };
}

function pdfFixture() {
  const text = 'Runtime PDF extraction works';
  const content = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

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
    const { extractText } = require('../dist/nest/llm-parse/text-extract.js');
    assert.equal(await extractText(Buffer.from('plain text still works'), 'booking.txt'), 'plain text still works');
    if (withoutCanvas) {
      await assert.rejects(extractText(pdfFixture(), 'booking.pdf'), {
        message: 'PDF text extraction is unavailable on this server',
      });
    } else {
      assert.equal(await extractText(pdfFixture(), 'booking.pdf'), 'Runtime PDF extraction works');
    }
    process.stdout.write(
      `[runtime smoke] Health, auth, sanitizer and PDF ${withoutCanvas ? 'isolation' : 'extraction'} passed\n`,
    );
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
