import { HttpException, Injectable, type OnModuleInit } from '@nestjs/common';
import { collabMessageCreateRequestSchema, type CollabMessageDirectUpload, type CollabNoteDirectUpload } from '@trek/shared';
import type { User } from '../../types';
import { StagedUploadsService, type StagedUploadIntent } from '../storage/staged-uploads.service';
import { CollabService } from './collab.service';
import { allowsChatImage, allowsNoteFile, MAX_CHAT_IMAGES, MAX_NOTE_FILE_SIZE } from './collab-upload-policy';

@Injectable()
export class CollabDirectUploadService implements OnModuleInit {
  constructor(private readonly collab: CollabService, private readonly uploads: StagedUploadsService) {}

  onModuleInit(): void {
    this.uploads.registerAuthorizer('collab-note-file', (intent, user) => {
      const [tripId, noteId] = intent.targetId.split(':');
      this.authorize(tripId, user, false);
      this.noteExists(tripId, noteId);
    });
    this.uploads.registerAuthorizer('collab-chat-images', (intent, user) => this.authorize(intent.targetId, user, true));
  }

  private authorize(tripId: string, user: User, chat: boolean): void {
    const trip = this.collab.verifyTripAccess(tripId, user.id);
    if (!trip) throw new HttpException({ error: 'Trip not found' }, 404);
    if (chat && !this.collab.canEdit(trip, user)) throw new HttpException({ error: 'No permission' }, 403);
    if (!this.collab.canUploadFiles(trip, user)) throw new HttpException({ error: 'No permission to upload files' }, 403);
  }

  private noteExists(tripId: string, noteId: string): void {
    if (!this.collab.getFormattedNoteById(tripId, noteId)) throw new HttpException({ error: 'Note not found' }, 404);
  }

  createNote(tripId: string, noteId: string, user: User, body: CollabNoteDirectUpload) {
    this.authorize(tripId, user, false);
    this.noteExists(tripId, noteId);
    for (const file of body.files) {
      if (file.fieldname !== 'file' || file.size > MAX_NOTE_FILE_SIZE || !allowsNoteFile(file.originalName, file.contentType)) {
        throw new HttpException({ error: 'File type not allowed or file is too large' }, 400);
      }
    }
    return this.uploads.create(user.id, 'collab-note-file', `${tripId}:${noteId}`, body.metadata,
      body.files.map(file => ({ ...file, category: 'files' })));
  }

  async completeNote(tripId: string, noteId: string, user: User, id: string, socketId?: string) {
    this.authorize(tripId, user, false);
    this.noteExists(tripId, noteId);
    const intent = this.uploads.get(id, user.id, 'collab-note-file', `${tripId}:${noteId}`);
    await this.uploads.verify(intent);
    const result = this.uploads.complete(intent, () => {
      this.authorize(tripId, user, false);
      const file = intent.files[0];
      if (!file) throw new HttpException({ error: 'No file uploaded' }, 400);
      const saved = this.collab.addNoteFile(tripId, noteId, toStoredFile(file));
      if (!saved) throw new HttpException({ error: 'Note not found' }, 404);
      return saved;
    });
    if (result.created) this.collab.broadcast(tripId, 'collab:note:updated', {
      note: this.collab.getFormattedNoteById(tripId, noteId),
    }, socketId);
    return result.result;
  }

  createMessage(tripId: string, user: User, body: CollabMessageDirectUpload) {
    this.authorize(tripId, user, true);
    if (!body.files.length || body.files.length > MAX_CHAT_IMAGES) throw new HttpException({ error: 'Too many images' }, 400);
    for (const file of body.files) {
      if (file.fieldname !== 'images' || file.size > 10 * 1024 * 1024 || !allowsChatImage(file.originalName, file.contentType)) {
        throw new HttpException({ error: 'Only JPEG, PNG, GIF, and WebP images up to 10 MB are allowed' }, 400);
      }
    }
    return this.uploads.create(user.id, 'collab-chat-images', tripId, body.metadata,
      body.files.map(file => ({ ...file, category: 'files' })));
  }

  async completeMessage(tripId: string, user: User, id: string, socketId?: string) {
    this.authorize(tripId, user, true);
    const intent = this.uploads.get(id, user.id, 'collab-chat-images', tripId);
    const body = collabMessageCreateRequestSchema.parse(intent.metadata);
    await this.uploads.verify(intent);
    const text = (body.text || '').trim();
    const replyTo = body.reply_to === undefined || body.reply_to === '' || body.reply_to === null ? null : Number(body.reply_to);
    const result = this.uploads.complete(intent, () => {
      this.authorize(tripId, user, true);
      const saved = this.collab.createMessage(tripId, user.id, text, Number.isFinite(replyTo) ? replyTo : null, intent.files.map(toStoredFile));
      if (saved.error === 'reply_not_found') throw new HttpException({ error: 'Reply target message not found' }, 400);
      this.collab.broadcast(tripId, 'collab:message:created', { message: saved.message }, socketId);
      return { message: saved.message };
    });
    if (result.created) {
      const preview = text || 'sent an image';
      this.collab.notifyCollab(tripId, user, preview.length > 80 ? preview.substring(0, 80) + '...' : preview);
    }
    return result.result;
  }
}

function toStoredFile(file: StagedUploadIntent['files'][number]) {
  return { filename: file.filename, originalname: file.originalName, size: file.size, mimetype: file.contentType };
}
