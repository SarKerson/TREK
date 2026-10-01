import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import { STORAGE_CATEGORIES, stagedUploadFileSchema, type StagedUploadFile, type StorageCategory, type FileDirectUploadGrant } from '@trek/shared';
import { isVercelRuntime } from '../../runtime';
import type { User } from '../../types';
import { DatabaseService } from '../database/database.service';
import { StorageService } from './storage.service';
import { UploadIntentGcService } from './upload-intent-gc.service';

export type StagedFileInput = StagedUploadFile & { category: StorageCategory };
const storedFilesSchema = z.array(stagedUploadFileSchema.extend({
  category: z.enum(STORAGE_CATEGORIES), filename: z.string(), pathname: z.string(),
}));
export interface StagedUploadIntent {
  id: string;
  userId: number;
  scope: string;
  targetId: string;
  metadata: unknown;
  files: z.infer<typeof storedFilesSchema>;
  expiresAt: number;
  completedAt: number | null;
  result: unknown;
}
interface IntentRow {
  id: string; user_id: number; scope: string; target_id: string;
  files_json: string; metadata_json: string; expires_at: number;
  completed_at: number | null; result_json: string | null;
}

/** Bytes and one-use control plane only. Owning domains must authorize and validate before create and complete. */
@Injectable()
export class StagedUploadsService {
  private readonly authorizers = new Map<string, (intent: StagedUploadIntent, user: User) => void>();
  constructor(private readonly db: DatabaseService, private readonly storage: StorageService, private readonly gc: UploadIntentGcService) {}

  registerAuthorizer(scope: string, authorize: (intent: StagedUploadIntent, user: User) => void): void {
    if (this.authorizers.has(scope)) throw new Error(`Duplicate staged-upload scope: ${scope}`);
    this.authorizers.set(scope, authorize);
  }

  create(userId: number, scope: string, targetId: string, metadata: unknown, descriptors: StagedFileInput[]): StagedUploadIntent {
    if (!isVercelRuntime()) throw new HttpException({ error: 'Direct uploads are unavailable on this deployment' }, 404);
    const id = randomUUID();
    const files = descriptors.map(file => {
      const filename = `${randomUUID()}${path.extname(file.originalName).toLowerCase()}`;
      return { ...file, filename, pathname: this.storage.directUploadPath(file.category, filename) };
    });
    const expiresAt = Date.now() + 60 * 60 * 1000;
    this.db.run(`INSERT INTO staged_upload_intents
      (id, user_id, scope, target_id, files_json, metadata_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, id, userId, scope, targetId, JSON.stringify(files), JSON.stringify(metadata), expiresAt);
    return { id, userId, scope, targetId, metadata, files, expiresAt, completedAt: null, result: null };
  }

  private find(id: string, userId: number): StagedUploadIntent {
    const row = this.db.get<IntentRow>('SELECT * FROM staged_upload_intents WHERE id = ? AND user_id = ?', id, userId);
    if (!row) throw new HttpException({ error: 'Upload not found' }, 404);
    if (row.completed_at === null && row.expires_at <= Date.now()) throw new HttpException({ error: 'Upload expired; choose the files again' }, 410);
    return { id: row.id, userId: row.user_id, scope: row.scope, targetId: row.target_id,
      files: storedFilesSchema.parse(JSON.parse(row.files_json)), metadata: JSON.parse(row.metadata_json),
      expiresAt: row.expires_at, completedAt: row.completed_at,
      result: row.result_json === null ? null : JSON.parse(row.result_json) };
  }

  get(id: string, userId: number, scope: string, targetId: string): StagedUploadIntent {
    const intent = this.find(id, userId);
    if (intent.scope !== scope || intent.targetId !== targetId) throw new HttpException({ error: 'Upload not found' }, 404);
    return intent;
  }

  async grant(user: User, body: FileDirectUploadGrant, request: Request) {
    const intent = this.find(body.payload.clientPayload, user.id);
    const authorize = this.authorizers.get(intent.scope);
    if (!authorize) throw new HttpException({ error: 'Upload scope is unavailable' }, 403);
    authorize(intent, user);
    await this.gc.collect();
    authorize(intent, user);
    if (intent.completedAt !== null) throw new HttpException({ error: 'Upload already completed' }, 409);
    const file = intent.files.find(item => item.pathname === body.payload.pathname);
    if (!file) throw new HttpException({ error: 'Upload path does not match its grant' }, 400);
    return this.storage.createDirectUploadGrant(file.category, file.filename, file.size,
      file.contentType, intent.expiresAt, body.payload.multipart, request);
  }

  async verify(intent: StagedUploadIntent): Promise<void> {
    if (intent.completedAt !== null) return;
    for (const file of intent.files) {
      const stat = await this.storage.stat(file.category, file.filename);
      if (!stat) throw new HttpException({ error: 'Upload has not finished' }, 409);
      if (stat.size !== file.size || stat.contentType?.split(';')[0]?.trim().toLowerCase() !== file.contentType) {
        throw new HttpException({ error: 'Uploaded file does not match its upload grant' }, 400);
      }
    }
  }

  complete(intent: StagedUploadIntent, create: () => unknown): { result: unknown; created: boolean } {
    return this.db.transaction(() => {
      const current = this.get(intent.id, intent.userId, intent.scope, intent.targetId);
      if (current.completedAt !== null) return { result: current.result, created: false };
      const result = create();
      if (result instanceof Promise) throw new Error('Staged finalization must use a synchronous database transaction');
      this.db.run('UPDATE staged_upload_intents SET completed_at = ?, result_json = ? WHERE id = ?',
        Date.now(), JSON.stringify(result), intent.id);
      return { result, created: true };
    });
  }
}
