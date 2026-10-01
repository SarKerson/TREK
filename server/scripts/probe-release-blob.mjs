// Explicitly opt-in release check. Uses the build's existing store-scoped OIDC
// identity, never exported credentials or an HTTP diagnostic endpoint.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { put, head, del, BlobNotFoundError } from '@vercel/blob';

const enabled = process.env.TREK_RELEASE_BLOB_PROBE;
if (!enabled) {
  console.log('[release blob probe] Skipped (opt-in only)');
} else {
  if (enabled !== '1') throw new Error('TREK_RELEASE_BLOB_PROBE must be unset or exactly 1');
  if (process.env.VERCEL !== '1') throw new Error('The Blob release probe requires VERCEL=1');
  const storeId = process.env.BLOB_STORE_ID?.trim();
  if (!storeId || !/^[a-zA-Z0-9_-]+$/.test(storeId)) {
    throw new Error('The Blob release probe requires an existing BLOB_STORE_ID binding');
  }
  const require = createRequire(import.meta.url);
  const { VercelBlobDriver } = require('../dist/nest/storage/drivers/vercel-blob.driver.js');
  // The SDK can otherwise fall back to a legacy store-wide token even when
  // storeId is provided. This child release process must prove OIDC specifically.
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const options = () => ({ storeId, abortSignal: AbortSignal.timeout(30_000) });
  const key = `release-probe/${randomUUID()}.txt`;
  const bytes = Buffer.from(`TREK disposable private storage release probe\n${randomUUID()}\n`);
  const driver = new VercelBlobDriver('release-probe', { storeId });
  let writeAttempted = false;
  let failure;
  let phase = 'private put with the existing OIDC binding';
  try {
    // A lost response can still mean the write committed. Always clean up our
    // uniquely generated probe target after attempting the request.
    writeAttempted = true;
    const uploaded = await put(key, bytes, {
      ...options(), access: 'private', addRandomSuffix: false,
      allowOverwrite: false, contentType: 'text/plain',
    });
    assert.equal(uploaded.pathname, key, 'Blob changed the isolated probe pathname');
    phase = 'private object metadata';
    const metadata = await head(key, options());
    assert.equal(metadata.size, bytes.length, 'Blob size differs from the disposable fixture');
    phase = 'authenticated full read';
    const whole = await driver.getStream(key);
    const chunks = [];
    for await (const chunk of whole.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes, 'Authenticated Blob read differs from the fixture');
    phase = 'authenticated byte-range read';
    const ranged = await driver.getStream(key, { start: 5, end: 18 });
    const rangeChunks = [];
    for await (const chunk of ranged.stream) rangeChunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(rangeChunks), bytes.subarray(5, 19), 'Blob byte range is incorrect');
    assert.equal(ranged.stat.size, bytes.length, 'Blob range lost the full object size');
    phase = 'anonymous access denial';
    // No Authorization header, token, cookies, or query parameters: the private
    // object must not be readable by an anonymous browser with its exact URL.
    const anonymousUrl = new URL(uploaded.url);
    assert.equal(anonymousUrl.protocol, 'https:');
    assert.equal(anonymousUrl.search, '');
    assert.equal(anonymousUrl.username, '');
    assert.equal(anonymousUrl.password, '');
    const anonymous = await fetch(anonymousUrl, {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    await anonymous.body?.cancel();
    assert.ok([401, 403, 404].includes(anonymous.status),
      `Private Blob anonymous access unexpectedly returned HTTP ${anonymous.status}`);
    console.log('[release blob probe] Existing OIDC binding, private put/read, exact bytes, range, and anonymous denial verified');
  } catch (error) {
    // SDK errors may contain URLs or authentication context. Keep build logs
    // capability-only; preserve a failure exit status without printing them.
    failure = error;
    console.error(`[release blob probe] Failed during ${phase}`);
  } finally {
    if (writeAttempted) {
      try {
        await del(key, options());
        let removed = false;
        try { await head(key, options()); }
        catch (error) {
          if (error instanceof BlobNotFoundError) removed = true;
          else throw error;
        }
        assert.equal(removed, true, 'The disposable probe object was not removed');
        console.log('[release blob probe] Disposable target absent; no user objects listed or modified');
      } catch (error) {
        failure ??= error;
        console.error('[release blob probe] Cleanup could not be verified for the newly created disposable object');
      }
    }
  }
  if (failure) {
    console.error('[release blob probe] Failed; remote storage readiness is not verified');
    process.exitCode = 1;
  }
}
