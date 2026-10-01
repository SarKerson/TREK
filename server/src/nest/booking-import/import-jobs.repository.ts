import { Injectable } from '@nestjs/common';
import { bookingImportPreviewResponseSchema, type BookingImportPreviewResponse } from '@trek/shared';
import { DatabaseService } from '../database/database.service';

export const IMPORT_JOB_BUDGET_MS = 240_000;
export const IMPORT_JOB_RETENTION_MS = 10 * 60_000;
export const IMPORT_JOB_TIMEOUT = 'Import exceeded the server time limit. Try fewer or smaller files.';

export interface DurableImportJob {
  id: string;
  tripId: string;
  userId: number;
  status: 'running' | 'done' | 'error';
  done: number;
  total: number;
  result?: BookingImportPreviewResponse;
  error?: string;
  createdAt: number;
}
interface JobRow {
  id: string; trip_id: string; user_id: number;
  status: DurableImportJob['status']; done: number; total: number;
  result: string | null; error: string | null; created_at: number;
}

/** Durable results let another function serve polling and reload recovery. */
@Injectable()
export class ImportJobsRepository {
  constructor(private readonly db: DatabaseService) {}

  create(job: DurableImportJob): boolean {
    const now = Date.now();
    this.expireRunning(now);
    this.db.run('DELETE FROM trek_import_jobs WHERE expires_at <= ?', now);
    // One live parse per user across all function instances, not just one Map.
    return this.db.run(`INSERT INTO trek_import_jobs
      (id, trip_id, user_id, status, done, total, created_at, expires_at)
      SELECT ?, ?, ?, 'running', 0, ?, ?, ? WHERE NOT EXISTS
      (SELECT 1 FROM trek_import_jobs WHERE user_id = ? AND status = 'running')`,
    job.id, job.tripId, job.userId, job.total, job.createdAt,
    now + IMPORT_JOB_BUDGET_MS + IMPORT_JOB_RETENTION_MS, job.userId).changes === 1;
  }

  progress(job: DurableImportJob): void {
    this.db.run("UPDATE trek_import_jobs SET done = ? WHERE id = ? AND user_id = ? AND status = 'running'",
      job.done, job.id, job.userId);
  }

  finish(job: DurableImportJob): boolean {
    return this.db.run(`UPDATE trek_import_jobs SET status = ?, done = ?, result = ?, error = ?, expires_at = ?
      WHERE id = ? AND user_id = ? AND status = 'running'`,
    job.status, job.done, job.result ? JSON.stringify(job.result) : null, job.error ?? null,
    Date.now() + IMPORT_JOB_RETENTION_MS, job.id, job.userId).changes === 1;
  }

  get(id: string, userId: number): DurableImportJob | undefined {
    const now = Date.now();
    // Hard function termination still becomes a terminal error on the next read.
    this.expireRunning(now);
    const row = this.db.get<JobRow>('SELECT * FROM trek_import_jobs WHERE id = ? AND user_id = ? AND expires_at > ?', id, userId, now);
    if (!row) return undefined;
    return {
      id: row.id, tripId: row.trip_id, userId: row.user_id, status: row.status,
      done: row.done, total: row.total, createdAt: row.created_at,
      ...(row.result ? { result: bookingImportPreviewResponseSchema.parse(JSON.parse(row.result)) } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private expireRunning(now: number): void {
    this.db.run(`UPDATE trek_import_jobs SET status = 'error', error = ?, expires_at = ?
      WHERE status = 'running' AND created_at <= ?`,
    IMPORT_JOB_TIMEOUT, now + IMPORT_JOB_RETENTION_MS, now - IMPORT_JOB_BUDGET_MS);
  }
}
