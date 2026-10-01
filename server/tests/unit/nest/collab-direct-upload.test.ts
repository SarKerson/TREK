import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../src/types';
import type { CollabService } from '../../../src/nest/collab/collab.service';
import { CollabDirectUploadService } from '../../../src/nest/collab/collab-direct-upload.service';
import type { StagedFileInput, StagedUploadIntent, StagedUploadsService } from '../../../src/nest/storage/staged-uploads.service';
const user = { id: 1 } as User;
const id = 'db54f312-2f29-48a4-8ee4-7e381968df27';
const file = { fieldname: 'images', originalName: 'picture.png', contentType: 'image/png', size: 10 };
let service: CollabDirectUploadService;
let intent: StagedUploadIntent;
const access = vi.fn(); const edit = vi.fn(); const permission = vi.fn(); const note = vi.fn();
const create = vi.fn(); const complete = vi.fn(); const verify = vi.fn(); const message = vi.fn(); const addNote = vi.fn(); const broadcast = vi.fn(); const notify = vi.fn();
const authorizers = new Map<string, (intent: StagedUploadIntent, user: User) => void>();
beforeEach(() => {
  vi.clearAllMocks(); authorizers.clear();
  access.mockReturnValue({ user_id: 1 }); edit.mockReturnValue(true); permission.mockReturnValue(true); note.mockReturnValue({ id: 3 });
  message.mockReturnValue({ message: { id: 5 } }); addNote.mockReturnValue({ file: { id: 6 } });
  create.mockImplementation((userId: number, scope: string, targetId: string, metadata: unknown, files: StagedFileInput[]) => {
    intent = { id, userId, scope, targetId, metadata, files: files.map(f => ({ ...f, filename: 'generated.png', pathname: 'files/generated.png' })), expiresAt: Date.now() + 10000, completedAt: null, result: null };
    return intent;
  });
  complete.mockImplementation((_intent, callback: () => unknown) => ({ result: callback(), created: true }));
  service = new CollabDirectUploadService({ verifyTripAccess: access, canEdit: edit, canUploadFiles: permission, getFormattedNoteById: note,
    createMessage: message, addNoteFile: addNote, broadcast, notifyCollab: notify,
  } as unknown as CollabService, { create, get: () => intent, verify, complete,
    registerAuthorizer: (scope: string, fn: (intent: StagedUploadIntent, user: User) => void) => authorizers.set(scope, fn),
  } as unknown as StagedUploadsService);
  service.onModuleInit();
});
describe('collab direct attachments', () => {
  it('authorizes trip membership, edit rights and upload rights before a chat intent', () => {
    access.mockReturnValueOnce(null); expect(() => service.createMessage('2', user, { files: [file], metadata: {} })).toThrow();
    edit.mockReturnValueOnce(false); expect(() => service.createMessage('2', user, { files: [file], metadata: {} })).toThrow();
    permission.mockReturnValueOnce(false); expect(() => service.createMessage('2', user, { files: [file], metadata: {} })).toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it.each([{ ...file, originalName: 'attack.html' }, { ...file, contentType: 'image/svg+xml' }, { ...file, size: 11 * 1024 * 1024 }, { ...file, fieldname: 'file' }])('retains chat file validation', invalid => {
    expect(() => service.createMessage('2', user, { files: [invalid], metadata: {} })).toThrow();
  });
  it('rechecks revoked chat membership before issuing a fresh grant', () => {
    service.createMessage('2', user, { files: [file], metadata: {} }); access.mockReturnValueOnce(null);
    expect(() => authorizers.get('collab-chat-images')!(intent, user)).toThrow();
  });
  it('binds note uploads to the trip and note and rejects missing/unsafe targets', () => {
    const noteFile = { ...file, fieldname: 'file' };
    note.mockReturnValueOnce(null); expect(() => service.createNote('2', '3', user, { files: [noteFile], metadata: {} })).toThrow();
    expect(() => service.createNote('2', '3', user, { files: [{ ...noteFile, originalName: 'bad.svg' }], metadata: {} })).toThrow();
    service.createNote('2', '3', user, { files: [noteFile], metadata: {} });
    expect(create).toHaveBeenCalledWith(1, 'collab-note-file', '2:3', {}, [expect.objectContaining({ category: 'files' })]);
  });
  it('verifies bytes and rechecks permissions during finalization', async () => {
    service.createMessage('2', user, { files: [file], metadata: { text: 'hello', reply_to: '4' } });
    await service.completeMessage('2', user, id, 'socket');
    expect(verify).toHaveBeenCalledWith(intent);
    expect(message).toHaveBeenCalledWith('2', 1, 'hello', 4, [expect.objectContaining({ filename: 'generated.png' })]);
    expect(broadcast).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledTimes(1);
    expect(permission.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('rejects a cross-trip/deleted reply inside the final transaction', async () => {
    service.createMessage('2', user, { files: [file], metadata: { reply_to: '99' } });
    message.mockReturnValueOnce({ error: 'reply_not_found' });
    await expect(service.completeMessage('2', user, id)).rejects.toThrow(); expect(notify).not.toHaveBeenCalled();
  });
  it('replays completed result without notifying or broadcasting twice', async () => {
    service.createMessage('2', user, { files: [file], metadata: {} });
    complete.mockReturnValueOnce({ result: { message: { id: 5 } }, created: false });
    await expect(service.completeMessage('2', user, id)).resolves.toEqual({ message: { id: 5 } });
    expect(broadcast).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
});
