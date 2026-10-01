import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { isVercelRuntime } from '../../runtime';
import { DatabaseService } from '../database/database.service';
import { StorageService } from './storage.service';
import { isValidKey } from './storage-keys';

const GRACE_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_INTENTS = 5;
const MAX_OBJECTS = 2;
const filename = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[^/\\]+)?$/i).refine(isValidKey);
const gcFilesSchema = z.array(z.object({
  category: z.enum(['files', 'journey']), filename, pathname: z.string(),
}).passthrough()).max(100);
type GcFile = z.infer<typeof gcFilesSchema>[number];
type Candidate = { id: string; kind: 'files' | 'staged' };
interface Claimed extends Candidate { files: GcFile[] }
const JOURNEY_SCOPES = new Set([
  'journey-entry-photos', 'journey-entry-video', 'journey-gallery-photos',
  'journey-gallery-video', 'journey-cover',
]);

/** Awaited, bounded cleanup; never relies on an invocation surviving its response. */
@Injectable()
export class UploadIntentGcService {
  private readonly logger = new Logger(UploadIntentGcService.name);
  private lastSweep = 0;
  private active = false;

  constructor(private readonly db: DatabaseService,
    @Inject(StorageService) private readonly storage: Pick<StorageService, 'delete' | 'directUploadPath'>) {}

  async collect(): Promise<void> {
    const now = Date.now();
    if (!isVercelRuntime() || this.active || now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.active = true;
    this.lastSweep = now;
    const deadline = now + 5_000;
    let budget = MAX_OBJECTS;
    try {
      const candidates = this.db.all<Candidate>(`
        SELECT id, 'files' AS kind, expires_at FROM upload_intents
        WHERE completed_at IS NULL AND expires_at <= ?
        UNION ALL
        SELECT id, 'staged' AS kind, expires_at FROM staged_upload_intents
        WHERE completed_at IS NULL AND expires_at <= ?
        ORDER BY expires_at LIMIT ?`, now - GRACE_MS, now - GRACE_MS, MAX_INTENTS);
      for (const candidate of candidates) {
        if (budget <= 0 || Date.now() >= deadline) break;
        try {
          const intent = this.claim(candidate, now - GRACE_MS);
          if (!intent) continue;
          let remaining = intent.files;
          for (const file of intent.files) {
            if (budget <= 0 || Date.now() >= deadline) break;
            budget--;
            await this.storage.delete(file.category, file.filename);
            remaining = remaining.filter(item => item.filename !== file.filename);
            if (intent.kind === 'staged') {
              // Persist progress only AFTER a successful deletion. A failed
              // delete or metadata write leaves enough information to retry.
              this.db.run(`UPDATE staged_upload_intents SET files_json = ?
                WHERE id = ? AND completed_at IS NULL AND expires_at = 0`, JSON.stringify(remaining), intent.id);
            }
          }
          if (remaining.length === 0) this.remove(intent);
        } catch {
          // Do not log filenames, upload metadata, credentials or provider errors.
          this.logger.warn('Expired upload cleanup was deferred; retry metadata retained');
          break;
        }
      }
    } catch {
      this.logger.warn('Expired upload cleanup is temporarily unavailable');
    } finally {
      this.active = false;
    }
  }

  private claim(candidate: Candidate, cutoff: number): Claimed | null {
    return this.db.transaction(() => {
      let files: GcFile[];
      if (candidate.kind === 'files') {
        const row = this.db.get<{ filename: string; file_id: number | null; completed_at: number | null }>(`
          UPDATE upload_intents SET expires_at = 0
          WHERE id = ? AND completed_at IS NULL AND expires_at <= ? RETURNING filename, file_id, completed_at`, candidate.id, cutoff);
        if (!row || row.completed_at !== null || row.file_id !== null) return null;
        const name = filename.parse(row.filename);
        if (!name.startsWith(candidate.id)) throw new Error('Upload key does not belong to intent');
        files = [{ category: 'files', filename: name, pathname: this.storage.directUploadPath('files', name) }];
      } else {
        const row = this.db.get<{ files_json: string; scope: string; completed_at: number | null }>(`
          UPDATE staged_upload_intents SET expires_at = 0
          WHERE id = ? AND completed_at IS NULL AND expires_at <= ? RETURNING files_json, scope, completed_at`, candidate.id, cutoff);
        if (!row || row.completed_at !== null) return null;
        files = gcFilesSchema.parse(JSON.parse(row.files_json));
        const category = JOURNEY_SCOPES.has(row.scope) ? 'journey'
          : ['collab-note-file', 'collab-chat-images'].includes(row.scope) ? 'files' : null;
        if (!category || files.some(file => file.category !== category)) throw new Error('Unknown upload scope');
        for (const file of files) {
          if (file.pathname !== this.storage.directUploadPath(file.category, file.filename)) throw new Error('Upload key mismatch');
        }
      }
      // Acquiring the write lock before this check serializes with finalization.
      // expires_at=0 is a durable tombstone: find()/get() reject it before a
      // caller can finalize, including while asynchronous byte deletion runs.
      if (this.referenced(files)) return null;
      return { ...candidate, files };
    });
  }

  private referenced(files: GcFile[]): boolean {
    const docs = files.filter(file => file.category === 'files').flatMap(file => [file.filename, `files/${file.filename}`]);
    const media = files.filter(file => file.category === 'journey').flatMap(file => [`journey/${file.filename}`, `/uploads/journey/${file.filename}`]);
    const placeholders = (values: string[]) => values.map(() => '?').join(',');
    if (docs.length && this.db.get(`SELECT 1 FROM trip_files WHERE filename IN (${placeholders(docs)}) LIMIT 1`, ...docs)) return true;
    if (media.length) {
      const slots = placeholders(media);
      if (this.db.get(`SELECT 1 FROM trek_photos WHERE file_path IN (${slots}) OR thumbnail_path IN (${slots}) LIMIT 1`, ...media, ...media)) return true;
      if (this.db.get(`SELECT 1 FROM journeys WHERE cover_image IN (${slots}) LIMIT 1`, ...media)) return true;
    }
    return false;
  }

  private remove(intent: Claimed): void {
    if (intent.kind === 'files') {
      this.db.run('DELETE FROM upload_intents WHERE id = ? AND completed_at IS NULL AND expires_at = 0', intent.id);
    } else {
      this.db.run('DELETE FROM staged_upload_intents WHERE id = ? AND completed_at IS NULL AND expires_at = 0', intent.id);
    }
  }
}
