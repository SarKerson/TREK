import type { UploadIntentGcService } from '../../../src/nest/storage/upload-intent-gc.service';
import { isVercelRuntime } from '../../../src/runtime';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Request } from 'express';
import { DatabaseService } from '../../../src/nest/database/database.service';
import type { DbConnection } from '../../../src/db/adapter';
import type { User } from '../../../src/types';
import type { StorageService } from '../../../src/nest/storage/storage.service';
import type { FilesService } from '../../../src/nest/files/files.service';
import type { AllowedFileTypesService } from '../../../src/nest/files/allowed-file-types.service';
import { RuntimeEnvService } from '../../../src/nest/app-config/runtime-env.service';
import { FilesDirectUploadService } from '../../../src/nest/files/files-direct-upload.service';
vi.mock('../../../src/runtime', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/runtime')>(), isVercelRuntime: vi.fn(() => false), vercelSecrets: () => null }));
let conn: Database.Database; let service: FilesDirectUploadService;
const user = { id: 1, email: 'family@example.test', role: 'user' } as User;
const access = vi.fn(); const can = vi.fn(); const foreign = vi.fn(); const createFile = vi.fn(); const broadcast = vi.fn(); const stat = vi.fn(); const grant = vi.fn();
const payload = { originalName: 'ticket.pdf', contentType: 'application/pdf', size: 10, metadata: { description: 'Flight' } };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVercelRuntime).mockReturnValue(true);
  conn = new Database(':memory:');
  conn.exec('CREATE TABLE upload_intents(id TEXT PRIMARY KEY, user_id INTEGER, trip_id INTEGER, filename TEXT, original_name TEXT, mime_type TEXT, file_size INTEGER, metadata_json TEXT, expires_at INTEGER, file_id INTEGER, completed_at INTEGER)');
  access.mockReturnValue({ id: 2, user_id: 1 }); can.mockReturnValue(true); foreign.mockReturnValue(null);
  createFile.mockReturnValue({ id: 42, trip_id: 2, original_name: 'ticket.pdf' });
  stat.mockResolvedValue({ size: 10, contentType: 'application/pdf' });
  service = new FilesDirectUploadService(new DatabaseService(conn as unknown as DbConnection), {
    verifyTripAccess: access, can, findForeignLinkTarget: foreign, createFile, broadcast,
    getFileById: () => ({ id: 42, trip_id: 2 }),
  } as unknown as FilesService, { get: () => 'pdf,jpg,png' } as AllowedFileTypesService, {
    directUploadPath: (_category: string, name: string) => `files/${name}`, stat, createDirectUploadGrant: grant,
  } as unknown as StorageService, new RuntimeEnvService(), { collect: vi.fn().mockResolvedValue(undefined) } as unknown as UploadIntentGcService);
});
afterEach(() => conn.close());
describe('trip-file direct upload security', () => {
  it('authorizes before creating any intent and retains original cap/type/link policy', async () => {
    access.mockReturnValueOnce(null); await expect(service.create('2', user, payload)).rejects.toThrow();
    can.mockReturnValueOnce(false); await expect(service.create('2', user, payload)).rejects.toThrow();
    foreign.mockReturnValueOnce('place_id'); await expect(service.create('2', user, payload)).rejects.toThrow();
    await expect(service.create('2', user, { ...payload, size: 51 * 1024 * 1024 })).rejects.toThrow();
    await expect(service.create('2', user, { ...payload, originalName: 'bad.html' })).rejects.toThrow();
    expect(conn.prepare('SELECT count(*) AS n FROM upload_intents').get()).toEqual({ n: 0 });
  });
  it('accepts video extensions at their original500MB cap even outside doc allowlist', async () => {
    const intent = await service.create('2', user, { ...payload, originalName: 'clip.MOV', contentType: 'video/quicktime', size: 500 * 1024 * 1024 });
    expect(intent.pathname).toMatch(/^files\/[a-f0-9-]+\.mov$/);
  });
  it('never grants another actor, trip or arbitrary key', async () => {
    const intent = await service.create('2', user, payload);
    const body = { type: 'blob.generate-presigned-url' as const, payload: { pathname: intent.pathname, clientPayload: intent.id, multipart: false } };
    await expect(service.grant('2', { ...user, id: 9 }, body, {} as Request)).rejects.toThrow();
    await expect(service.grant('3', user, body, {} as Request)).rejects.toThrow();
    await expect(service.grant('2', user, { ...body, payload: { ...body.payload, pathname: 'files/foreign.pdf' } }, {} as Request)).rejects.toThrow();
    expect(grant).not.toHaveBeenCalled();
  });
  it('rejects revoked permission at grant and after object metadata retrieval', async () => {
    const intent = await service.create('2', user, payload);
    can.mockReturnValueOnce(false);
    await expect(service.grant('2', user, { type: 'blob.generate-presigned-url', payload: { pathname: intent.pathname, clientPayload: intent.id, multipart: false } }, {} as Request)).rejects.toThrow();
    stat.mockImplementationOnce(async () => { can.mockReturnValue(false); return { size: 10, contentType: 'application/pdf' }; });
    await expect(service.complete('2', user, intent.id)).rejects.toThrow();
    expect(createFile).not.toHaveBeenCalled();
  });
  it('verifies bytes before attaching and finalizes once on retry', async () => {
    const intent = await service.create('2', user, payload);
    stat.mockResolvedValueOnce({ size: 9, contentType: 'application/pdf' });
    await expect(service.complete('2', user, intent.id)).rejects.toThrow();
    stat.mockResolvedValueOnce({ size: 10, contentType: 'image/png' });
    await expect(service.complete('2', user, intent.id)).rejects.toThrow();
    await service.complete('2', user, intent.id, 'socket');
    await service.complete('2', user, intent.id, 'socket');
    expect(createFile).toHaveBeenCalledTimes(1); expect(broadcast).toHaveBeenCalledTimes(1);
    expect(createFile).toHaveBeenCalledWith('2', expect.objectContaining({ originalname: 'ticket.pdf', size: 10, mimetype: 'application/pdf' }), 1, { description: 'Flight' });
  });
  it('refuses expired uploads without creating an attachment', async () => {
    const intent = await service.create('2', user, payload);
    conn.prepare('UPDATE upload_intents SET expires_at = 0 WHERE id = ?').run(intent.id);
    await expect(service.complete('2', user, intent.id)).rejects.toThrow(); expect(createFile).not.toHaveBeenCalled();
  });
});
