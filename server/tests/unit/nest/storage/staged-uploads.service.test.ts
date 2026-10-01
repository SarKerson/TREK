import type { UploadIntentGcService } from '../../../../src/nest/storage/upload-intent-gc.service';
import { isVercelRuntime } from '../../../../src/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Request } from 'express';
import { DatabaseService } from '../../../../src/nest/database/database.service';
import type { DbConnection } from '../../../../src/db/adapter';
import type { User } from '../../../../src/types';
import type { StorageService } from '../../../../src/nest/storage/storage.service';
import { StagedUploadsService } from '../../../../src/nest/storage/staged-uploads.service';
vi.mock('../../../../src/runtime', async (importOriginal) => ({ ...await importOriginal<typeof import('../../../../src/runtime')>(), isVercelRuntime: vi.fn(() => false), vercelSecrets: () => null }));
let conn: Database.Database;
let uploads: StagedUploadsService;
const actor = { id: 7 } as User;
const stat = vi.fn(); const grant = vi.fn(); const authorize = vi.fn();
const input = { fieldname: 'images', originalName: 'private.png', contentType: 'image/png', size: 10, category: 'files' as const };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVercelRuntime).mockReturnValue(true);
  conn = new Database(':memory:');
  conn.exec(`CREATE TABLE staged_upload_intents(id TEXT PRIMARY KEY, user_id INTEGER, scope TEXT, target_id TEXT, files_json TEXT, metadata_json TEXT, expires_at INTEGER, completed_at INTEGER, result_json TEXT); CREATE TABLE writes(id INTEGER);`);
  uploads = new StagedUploadsService(new DatabaseService(conn as unknown as DbConnection), {
    directUploadPath: (category: string, name: string) => `${category}/${name}`, stat, createDirectUploadGrant: grant,
  } as unknown as StorageService, { collect: vi.fn().mockResolvedValue(undefined) } as unknown as UploadIntentGcService);
  uploads.registerAuthorizer('chat', authorize);
  stat.mockResolvedValue({ size: 10, contentType: 'image/png' });
  grant.mockResolvedValue({ type: 'blob.generate-presigned-url' });
});
afterEach(() => conn.close());
const create = () => uploads.create(actor.id, 'chat', 'trip-1', { text: 'hi' }, [input]);
const body = (id: string, pathname: string) => ({ type: 'blob.generate-presigned-url' as const, payload: { clientPayload: id, pathname, multipart: true } });
describe('staged private uploads', () => {
  it('binds actor, scope, target and immutable server-created paths', () => {
    const intent = create();
    expect(intent.files[0].pathname).toMatch(/^files\/[a-f0-9-]+\.png$/);
    expect(uploads.get(intent.id, actor.id, 'chat', 'trip-1').metadata).toEqual({ text: 'hi' });
    expect(() => uploads.get(intent.id, 8, 'chat', 'trip-1')).toThrow();
    expect(() => uploads.get(intent.id, 7, 'note', 'trip-1')).toThrow();
    expect(() => uploads.get(intent.id, 7, 'chat', 'trip-2')).toThrow();
  });
  it('validates actual object size and MIME before attachment', async () => {
    const intent = create(); await uploads.verify(intent);
    stat.mockResolvedValueOnce(null); await expect(uploads.verify(intent)).rejects.toThrow();
    stat.mockResolvedValueOnce({ size: 9, contentType: 'image/png' }); await expect(uploads.verify(intent)).rejects.toThrow();
    stat.mockResolvedValueOnce({ size: 10, contentType: 'image/svg+xml' }); await expect(uploads.verify(intent)).rejects.toThrow();
  });
  it('rejects cross-user grants and foreign keys', async () => {
    const intent = create();
    await expect(uploads.grant({ id: 8 } as User, body(intent.id, intent.files[0].pathname), {} as Request)).rejects.toThrow();
    await expect(uploads.grant(actor, body(intent.id, 'files/foreign.png'), {} as Request)).rejects.toThrow();
    expect(grant).not.toHaveBeenCalled();
  });
  it('rechecks current domain permissions on each grant', async () => {
    const intent = create();
    await uploads.grant(actor, body(intent.id, intent.files[0].pathname), {} as Request);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'trip-1' }), actor);
    authorize.mockImplementationOnce(() => { throw new Error('membership revoked'); });
    await expect(uploads.grant(actor, body(intent.id, intent.files[0].pathname), {} as Request)).rejects.toThrow('membership revoked');
    expect(grant).toHaveBeenCalledTimes(1);
  });
  it('fails closed without a domain authorizer', async () => {
    const intent = uploads.create(actor.id, 'unknown', 'trip-1', {}, [input]);
    await expect(uploads.grant(actor, body(intent.id, intent.files[0].pathname), {} as Request)).rejects.toThrow();
    expect(grant).not.toHaveBeenCalled();
  });
  it('finalizes once across stale callers and replays durable result', () => {
    const intent = create();
    const write = vi.fn(() => { conn.prepare('INSERT INTO writes VALUES (1)').run(); return { id: 42 }; });
    expect(uploads.complete(intent, write)).toEqual({ result: { id: 42 }, created: true });
    expect(uploads.complete(intent, write)).toEqual({ result: { id: 42 }, created: false });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('rolls back row writes and consumption together', () => {
    const intent = create();
    expect(() => uploads.complete(intent, () => { conn.prepare('INSERT INTO writes VALUES (1)').run(); throw new Error('failed'); })).toThrow('failed');
    expect(uploads.get(intent.id, actor.id, 'chat', 'trip-1').completedAt).toBeNull();
    expect(conn.prepare('SELECT count(*) AS count FROM writes').get()).toEqual({ count: 0 });
  });
  it('refuses expired intents and completed grants', async () => {
    const expired = create(); conn.prepare('UPDATE staged_upload_intents SET expires_at = 0 WHERE id = ?').run(expired.id);
    expect(() => uploads.get(expired.id, actor.id, 'chat', 'trip-1')).toThrow();
    const finished = create(); uploads.complete(finished, () => ({ id: 1 }));
    await expect(uploads.grant(actor, body(finished.id, finished.files[0].pathname), {} as Request)).rejects.toThrow();
  });
});
