import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Request } from 'express';
import { fileUploadRequestSchema, type FileDirectUploadRequest, type FileDirectUploadGrant, type FileDirectUploadIntent } from '@trek/shared';
import { isVercelRuntime } from '../../runtime';
import type { User } from '../../types';
import { DatabaseService } from '../database/database.service';
import { RuntimeEnvService } from '../app-config/runtime-env.service';
import { DEMO_WRITE_ERROR, isDemoWriteBlocked } from '../common/demo-write';
import { StorageService } from '../storage/storage.service';
import { UploadIntentGcService } from '../storage/upload-intent-gc.service';
import { FilesService } from './files.service';
import { AllowedFileTypesService } from './allowed-file-types.service';
import { MAX_FILE_SIZE, MAX_VIDEO_SIZE, isVideoExtension } from './files.constants';
import { isAllowedFileType } from './files-upload-policy';

interface UploadIntent {
  id: string;
  user_id: number;
  trip_id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  metadata_json: string;
  expires_at: number;
  file_id: number | null;
  completed_at: number | null;
}

const UPLOAD_LIFETIME_MS = 60 * 60 * 1000;

@Injectable()
export class FilesDirectUploadService {
  constructor(private readonly db: DatabaseService, private readonly files: FilesService,
    private readonly allowedTypes: AllowedFileTypesService, private readonly storage: StorageService,
    private readonly env: RuntimeEnvService, private readonly gc: UploadIntentGcService) {}

  private authorize(tripId: string, user: User): void {
    const trip = this.files.verifyTripAccess(tripId, user.id);
    if (!trip) throw new HttpException({ error: 'Trip not found' }, 404);
    if (isDemoWriteBlocked(this.env, user.email)) throw new HttpException(DEMO_WRITE_ERROR, 403);
    if (!this.files.can('file_upload', trip, user)) throw new HttpException({ error: 'No permission to upload files' }, 403);
    if (!isVercelRuntime()) throw new HttpException({ error: 'Direct uploads are unavailable on this deployment' }, 404);
  }

  private validateFile(originalName: string, contentType: string, size: number): void {
    if (!isAllowedFileType(originalName, contentType, this.allowedTypes.get())) {
      throw new HttpException({ error: 'files.uploadErrorType' }, 400);
    }
    const max = isVideoExtension(path.extname(originalName)) ? MAX_VIDEO_SIZE : MAX_FILE_SIZE;
    if (size > max) throw new HttpException({ error: 'File is too large' }, 400);
  }

  private validateLinks(tripId: string, metadata: FileDirectUploadRequest['metadata']): void {
    if (this.files.findForeignLinkTarget(tripId, metadata)) {
      throw new HttpException({ error: 'Linked item does not belong to this trip' }, 400);
    }
  }

  async create(tripId: string, user: User, body: FileDirectUploadRequest): Promise<FileDirectUploadIntent> {
    this.authorize(tripId, user);
    this.validateFile(body.originalName, body.contentType, body.size);
    this.validateLinks(tripId, body.metadata);
    const id = randomUUID();
    const filename = `${id}${path.extname(body.originalName).toLowerCase()}`;
    const expiresAt = Date.now() + UPLOAD_LIFETIME_MS;
    const pathname = this.storage.directUploadPath('files', filename);
    this.db.run(`INSERT INTO upload_intents
      (id, user_id, trip_id, filename, original_name, mime_type, file_size, metadata_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, user.id, tripId, filename, body.originalName, body.contentType, body.size, JSON.stringify(body.metadata), expiresAt);
    return { id, pathname, expiresAt, contentType: body.contentType };
  }

  async grant(tripId: string, user: User, body: FileDirectUploadGrant, request: Request) {
    this.authorize(tripId, user);
    await this.gc.collect();
    this.authorize(tripId, user);
    const intent = this.findIntent(body.payload.clientPayload, tripId, user.id);
    if (intent.completed_at !== null) throw new HttpException({ error: 'Upload already completed' }, 409);
    if (body.payload.pathname !== this.storage.directUploadPath('files', intent.filename)) {
      throw new HttpException({ error: 'Upload path does not match its grant' }, 400);
    }
    this.validateFile(intent.original_name, intent.mime_type, intent.file_size);
    return this.storage.createDirectUploadGrant('files', intent.filename, intent.file_size,
      intent.mime_type, intent.expires_at, body.payload.multipart, request);
  }

  private findIntent(id: string, tripId: string, userId: number): UploadIntent {
    const intent = this.db.get<UploadIntent>('SELECT * FROM upload_intents WHERE id = ? AND trip_id = ? AND user_id = ?', id, tripId, userId);
    if (!intent) throw new HttpException({ error: 'Upload not found' }, 404);
    if (intent.completed_at === null && intent.expires_at < Date.now()) throw new HttpException({ error: 'Upload expired; choose the file again' }, 410);
    return intent;
  }

  private completedFile(intent: UploadIntent, tripId: string) {
    const file = intent.file_id ? this.files.getFileById(intent.file_id, tripId) : undefined;
    if (!file || file.deleted_at) throw new HttpException({ error: 'File not found' }, 404);
    return { ...file, url: `/api/trips/${tripId}/files/${file.id}/download` };
  }

  async complete(tripId: string, user: User, id: string, socketId?: string) {
    this.authorize(tripId, user);
    const intent = this.findIntent(id, tripId, user.id);
    if (intent.completed_at !== null) return { file: this.completedFile(intent, tripId) };
    this.validateFile(intent.original_name, intent.mime_type, intent.file_size);
    const metadata = fileUploadRequestSchema.parse(JSON.parse(intent.metadata_json));
    this.validateLinks(tripId, metadata);
    // Only the server-chosen key is read. A URL/pathname from a client can never
    // attach someone else's private object. Immutable grants prevent post-stat replacement.
    const stat = await this.storage.stat('files', intent.filename);
    if (!stat) throw new HttpException({ error: 'Upload has not finished' }, 409);
    if (stat.size !== intent.file_size || stat.contentType?.split(';')[0]?.trim().toLowerCase() !== intent.mime_type) {
      throw new HttpException({ error: 'Uploaded file does not match its upload grant' }, 400);
    }
    const result = this.db.transaction(() => {
      this.authorize(tripId, user);
      const latest = this.findIntent(id, tripId, user.id);
      if (latest.completed_at !== null) return { file: this.completedFile(latest, tripId), created: false };
      this.validateLinks(tripId, metadata);
      const file = this.files.createFile(tripId, { filename: latest.filename, originalname: latest.original_name,
        size: latest.file_size, mimetype: latest.mime_type }, user.id, metadata);
      this.db.run('UPDATE upload_intents SET file_id = ?, completed_at = ? WHERE id = ?', file.id, Date.now(), id);
      return { file, created: true };
    });
    if (result.created) this.files.broadcast(tripId, 'file:created', { file: result.file }, socketId);
    return { file: result.file };
  }
}
