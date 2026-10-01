import fs from 'node:fs';
import { Readable } from 'node:stream';
import { BlobNotFoundError, del, get, head, list, put, issueSignedToken } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import type { Request } from 'express';
import { assertValidKey, assertValidPrefix } from '../storage-keys';
import {
  StorageBackendError, StorageNotFoundError, isLocalTempFile,
  type ByteRange, type LocalTempFile, type ObjectStat, type PutOptions, type StorageDriver,
} from '../storage.types';

/** Private objects only. Callers retain their existing authenticated serving routes. */
export class VercelBlobDriver implements StorageDriver {
  constructor(readonly id: string, private readonly auth: { storeId?: string; token?: string }) {
    if (!auth.storeId && !auth.token) throw new StorageBackendError('Private Blob storage credentials are required');
  }

  private options(timeoutMs = 30_000) {
    return { ...this.auth, abortSignal: AbortSignal.timeout(timeoutMs) };
  }

  /** Exact, immutable object grant. Never return the store-wide read/write token. */
  async createUploadGrant(key: string, size: number, contentType: string, expiresAt: number, multipart: boolean, request: Request) {
    assertValidKey(key);
    return handleUploadPresigned({
      request,
      body: { type: 'blob.generate-presigned-url', payload: { pathname: key, clientPayload: null, multipart } },
      getSignedToken: async () => ({
        token: await issueSignedToken({ ...this.options(), pathname: key, maximumSizeInBytes: size,
          allowedContentTypes: [contentType], validUntil: expiresAt, operations: ['put'] }),
        urlOptions: { maximumSizeInBytes: size, allowedContentTypes: [contentType], validUntil: expiresAt,
          addRandomSuffix: false, allowOverwrite: false },
      }),
    });
  }

  async put(key: string, source: Readable | LocalTempFile, opts?: PutOptions): Promise<void> {
    assertValidKey(key);
    const temporary = isLocalTempFile(source);
    const stream = temporary ? fs.createReadStream(source.tmpPath) : source;
    try {
      await put(key, stream, {
        ...this.options(270_000), access: 'private', addRandomSuffix: false,
        allowOverwrite: true, multipart: true, contentType: opts?.contentType,
      });
      if (temporary) await fs.promises.unlink(source.tmpPath);
    } catch (cause) {
      throw new StorageBackendError(`private blob put failed for '${key}'`, cause);
    } finally {
      stream.destroy();
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertValidKey(key);
    try {
      const blob = await head(key, this.options());
      return { key, size: blob.size, mtimeMs: blob.uploadedAt.getTime(), etag: quotedEtag(blob.etag), contentType: blob.contentType };
    } catch (cause) {
      if (cause instanceof BlobNotFoundError) return null;
      throw new StorageBackendError(`private blob stat failed for '${key}'`, cause);
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<{ stream: Readable; stat: ObjectStat }> {
    assertValidKey(key);
    if (range && (!Number.isSafeInteger(range.start) || range.start < 0 ||
      (range.end !== undefined && (!Number.isSafeInteger(range.end) || range.end < range.start)))) {
      throw new StorageBackendError('invalid byte range');
    }
    try {
      const blob = await get(key, {
        ...this.options(270_000), access: 'private', useCache: false,
        ...(range ? { headers: { Range: `bytes=${range.start}-${range.end ?? ''}` } } : {}),
      });
      if (!blob || blob.statusCode !== 200) throw new StorageNotFoundError(key);
      // The SDK normalizes 206 to statusCode 200. Require Content-Range when
      // requesting a range so an upstream ignoring Range cannot corrupt a 206.
      const contentRange = blob.headers.get('content-range');
      const parsed = contentRange ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange) : null;
      if (range && (!parsed || Number(parsed[1]) !== range.start ||
        (range.end !== undefined && Number(parsed[2]) !== Math.min(range.end, Number(parsed[3]) - 1)))) {
        await blob.stream.cancel();
        throw new StorageBackendError('private blob returned an invalid byte range');
      }
      return {
        stream: Readable.fromWeb(blob.stream),
        stat: { key, size: parsed ? Number(parsed[3]) : blob.blob.size,
          mtimeMs: blob.blob.uploadedAt.getTime(), etag: quotedEtag(blob.blob.etag), contentType: blob.blob.contentType },
      };
    } catch (cause) {
      if (cause instanceof StorageNotFoundError || cause instanceof StorageBackendError) throw cause;
      if (cause instanceof BlobNotFoundError) throw new StorageNotFoundError(key);
      throw new StorageBackendError(`private blob read failed for '${key}'`, cause);
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try { await del(key, this.options()); }
    catch (cause) {
      if (!(cause instanceof BlobNotFoundError)) throw new StorageBackendError(`private blob delete failed for '${key}'`, cause);
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    assertValidPrefix(prefix);
    let cursor: string | undefined;
    do {
      const page = await list({ ...this.options(), prefix, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        assertValidKey(blob.pathname);
        if (!blob.pathname.startsWith(prefix)) throw new StorageBackendError('private blob list escaped its prefix');
        yield { key: blob.pathname, size: blob.size, mtimeMs: blob.uploadedAt.getTime() };
      }
      if (!page.hasMore) break;
      if (!page.cursor || page.cursor === cursor) throw new StorageBackendError('private blob list failed to advance');
      cursor = page.cursor;
    } while (cursor);
  }
}

function quotedEtag(etag: string): string {
  return etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`;
}
