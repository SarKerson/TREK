import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ImportJobsService } from '../../../../src/nest/booking-import/import-jobs.service';
import { ImportJobsRepository, IMPORT_JOB_BUDGET_MS, IMPORT_JOB_TIMEOUT, type DurableImportJob } from '../../../../src/nest/booking-import/import-jobs.repository';
import { DatabaseService } from '../../../../src/nest/database/database.service';

const realtime = { broadcastToUser: vi.fn() };
let db: Database.Database;
let repository: ImportJobsRepository;
const files = [{ originalname: 'booking.pdf' }] as Express.Multer.File[];
const result = { items: [], warnings: ['Review before saving'] };
const make = (preview = vi.fn().mockResolvedValue(result)) => new ImportJobsService({ preview } as never, realtime as never, repository);
const job = (): DurableImportJob => ({ id: 'job-1', tripId: '7', userId: 42, status: 'running', done: 0, total: 1, createdAt: Date.now() });
beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.exec(`CREATE TABLE trek_import_jobs (
    id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, result TEXT, error TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  repository = new ImportJobsRepository(new DatabaseService(db));
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('serverless booking job persistence', () => {
  it('awaits completion and recovers the result from another service instance', async () => {
    const id = await make().startInRequest('7', files, 'no-ai', 42);
    expect(make().get(id, 42)).toMatchObject({ status: 'done', result });
    expect(make().get(id, 43)).toBeUndefined();
    expect(make().get('absent', 42)).toBeUndefined();
  });
  it('persists progress and a terminal provider failure', async () => {
    const preview = vi.fn(async (_files, _mode, _user, progress) => {
      progress(1, 1, 'booking.pdf');
      throw new Error('Provider unavailable');
    });
    const id = await make(preview).startInRequest('7', files, 'force-ai', 42);
    expect(repository.get(id, 42)).toMatchObject({ done: 1, status: 'error', error: 'Provider unavailable' });
  });
  it('aborts after 240 seconds and never replaces timeout with a late success', async () => {
    vi.useFakeTimers();
    let finish: (value: typeof result) => void = () => {};
    let signal: AbortSignal | undefined;
    const preview = vi.fn((_files, _mode, _user, _progress, abort: AbortSignal) => {
      signal = abort;
      return new Promise<typeof result>(resolve => { finish = resolve; });
    });
    const pending = make(preview).startInRequest('7', files, 'no-ai', 42);
    await vi.advanceTimersByTimeAsync(IMPORT_JOB_BUDGET_MS);
    const id = await pending;
    expect(signal?.aborted).toBe(true);
    expect(repository.get(id, 42)).toMatchObject({ status: 'error', error: IMPORT_JOB_TIMEOUT });
    finish(result);
    await Promise.resolve();
    expect(repository.get(id, 42)?.status).toBe('error');
  });
  it('turns a killed invocation into a timeout on reads and refuses late completion', () => {
    const killed = job();
    expect(repository.create(killed)).toBe(true);
    db.prepare('UPDATE trek_import_jobs SET created_at = ? WHERE id = ?').run(Date.now() - IMPORT_JOB_BUDGET_MS - 1, killed.id);
    expect(repository.get(killed.id, 42)).toMatchObject({ status: 'error', error: IMPORT_JOB_TIMEOUT });
    expect(repository.finish({ ...killed, status: 'done', result })).toBe(false);
  });
  it('allows only one running job per owner and removes expired results', async () => {
    expect(repository.create(job())).toBe(true);
    await expect(make().startInRequest('7', files, 'no-ai', 42)).rejects.toMatchObject({ status: 409, response: { error: expect.stringContaining('An import is already running') } });
    expect(repository.create({ ...job(), id: 'job-2', userId: 99 })).toBe(true);
    db.prepare('UPDATE trek_import_jobs SET expires_at = ?').run(Date.now() - 1);
    expect(repository.get('job-1', 42)).toBeUndefined();
  });
});
