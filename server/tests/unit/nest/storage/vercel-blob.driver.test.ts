import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import type { HandleUploadPresignedOptions } from '@vercel/blob/client';
import { BlobNotFoundError, get, head, issueSignedToken, list, put } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import { VercelBlobDriver } from '../../../../src/nest/storage/drivers/vercel-blob.driver';
import { StorageBackendError, StorageInvalidKeyError, StorageNotFoundError } from '../../../../src/nest/storage/storage.types';
import { describeStorageDriver } from './storage-driver.contract';

vi.mock('@vercel/blob', () => ({
  BlobNotFoundError: class extends Error {},
  get: vi.fn(), head: vi.fn(), list: vi.fn(), put: vi.fn(), del: vi.fn(), issueSignedToken: vi.fn(),
}));
vi.mock('@vercel/blob/client', () => ({ handleUploadPresigned: vi.fn() }));
const blobs = new Map<string, Buffer>();
const driver = () => new VercelBlobDriver('private', { storeId: 'store_private' });
const metadata = (key: string) => ({ pathname: key, size: blobs.get(key)!.length, uploadedAt: new Date(1000), etag: 'test-etag', contentType: 'application/octet-stream' });

beforeEach(async () => {
  blobs.clear();
  vi.resetAllMocks();
  vi.mocked(put).mockImplementation(async (key, source) => {
    const chunks: Buffer[] = [];
    for await (const chunk of source as Readable) chunks.push(Buffer.from(chunk));
    blobs.set(key, Buffer.concat(chunks));
    return { pathname: key, url: '', downloadUrl: '', contentType: '', contentDisposition: '', etag: '' };
  });
  vi.mocked(head).mockImplementation(async key => {
    if (!blobs.has(key)) throw new BlobNotFoundError();
    return { ...metadata(key), url: '', downloadUrl: '', contentDisposition: '', cacheControl: '' };
  });
  vi.mocked(get).mockImplementation(async (key, opts) => {
    const bytes = blobs.get(key);
    if (!bytes) return null;
    const range = new Headers(opts.headers).get('Range');
    const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    const body = bytes.subarray(start, end + 1);
    return { statusCode: 200, stream: Readable.toWeb(Readable.from(body)),
      headers: new Headers(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      blob: { ...metadata(key), size: body.length, url: '', downloadUrl: '', contentDisposition: '', cacheControl: '' } };
  });
  const { del } = await import('@vercel/blob');
  vi.mocked(del).mockImplementation(async key => { for (const k of Array.isArray(key) ? key : [key]) blobs.delete(k); });
  vi.mocked(list).mockImplementation(async opts => ({
    blobs: [...blobs.keys()].filter(key => key.startsWith(opts?.prefix ?? '')).map(key => ({ ...metadata(key), url: '', downloadUrl: '' })),
    hasMore: false,
  }));
});
afterEach(() => vi.restoreAllMocks());

describeStorageDriver('private Vercel Blob (SDK contract mock)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-blob-test-'));
  let count = 0;
  return { driver: driver(), makeTempFile: async contents => {
    const file = path.join(dir, String(++count)); fs.writeFileSync(file, contents); return file;
  }, cleanup: async () => { fs.rmSync(dir, { recursive: true, force: true }); } };
});

describe('private Vercel Blob safeguards', () => {
  it('fails closed without storage configuration', () => {
    expect(() => new VercelBlobDriver('missing', {})).toThrow(StorageBackendError);
  });
  it('uses private storage and never makes a public URL the application identifier', async () => {
    await driver().put('files/a.pdf', Readable.from('pdf'));
    expect(put).toHaveBeenCalledWith('files/a.pdf', expect.any(Readable), expect.objectContaining({
      access: 'private', addRandomSuffix: false, storeId: 'store_private', multipart: true,
    }));
    expect(await driver().stat('files/a.pdf')).toMatchObject({ etag: '"test-etag"' });
  });
  it('generates only an immutable PUT grant for the exact key, MIME and byte limit', async () => {
    vi.mocked(issueSignedToken).mockResolvedValue({ delegationToken: 'scoped', clientSigningToken: 'scoped-signing', validUntil: 12345 });
    vi.mocked(handleUploadPresigned).mockImplementation(async (opts: HandleUploadPresignedOptions) => {
      const result = await opts.getSignedToken('files/f.pdf', null, true);
      expect(result.urlOptions).toMatchObject({ allowOverwrite: false, addRandomSuffix: false, maximumSizeInBytes: 123, allowedContentTypes: ['application/pdf'], validUntil: 12345 });
      expect(opts.onUploadCompleted).toBeUndefined();
      return { type: 'blob.upload-completed', response: 'ok' };
    });
    await driver().createUploadGrant('files/f.pdf', 123, 'application/pdf', 12345, true, {} as Request);
    expect(issueSignedToken).toHaveBeenCalledWith(expect.objectContaining({ pathname: 'files/f.pdf', operations: ['put'], maximumSizeInBytes: 123, allowedContentTypes: ['application/pdf'], validUntil: 12345 }));
  });
  it('rejects path injection before making any provider request', async () => {
    await expect(driver().createUploadGrant('../x', 1, 'image/png', 12345, false, {} as Request)).rejects.toThrow(StorageInvalidKeyError);
    expect(issueSignedToken).not.toHaveBeenCalled();
  });
  it('rejects invalid or ignored ranges rather than serving corrupt partial data', async () => {
    await expect(driver().getStream('f', { start: -1 })).rejects.toThrow(StorageBackendError);
    blobs.set('f', Buffer.from('abcd'));
    const cancel = vi.fn();
    vi.mocked(get).mockResolvedValueOnce({ statusCode: 200, headers: new Headers(),
      stream: new ReadableStream({ cancel }), blob: { ...metadata('f'), url: '', downloadUrl: '', contentDisposition: '', cacheControl: '' } });
    await expect(driver().getStream('f', { start: 1, end: 2 })).rejects.toThrow(StorageBackendError);
    expect(cancel).toHaveBeenCalled();
  });
  it('maps not-found and provider failures without leaking credentials into the message', async () => {
    vi.mocked(get).mockRejectedValueOnce(new BlobNotFoundError());
    await expect(driver().getStream('missing')).rejects.toThrow(StorageNotFoundError);
    vi.mocked(head).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(driver().stat('f')).rejects.toThrow("private blob stat failed for 'f'");
  });
  it('rejects a stuck list cursor', async () => {
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: true, cursor: 'same' });
    await expect((async () => { for await (const _entry of driver().list('files/')) { /* consume */ } })()).rejects.toThrow('failed to advance');
  });
});
