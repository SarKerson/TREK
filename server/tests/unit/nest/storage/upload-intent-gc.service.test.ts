import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../../../../src/nest/database/database.service';
import { UploadIntentGcService } from '../../../../src/nest/storage/upload-intent-gc.service';

const NOW = 2_000_000_000_000;
const OLD = NOW - 2 * 60 * 60_000;
let db: Database.Database;
let service: UploadIntentGcService;
let deleteObject: ReturnType<typeof vi.fn<(category: string, name: string) => Promise<void>>>;

beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE upload_intents(id TEXT PRIMARY KEY, filename TEXT, file_id INTEGER, completed_at INTEGER, expires_at INTEGER);
    CREATE TABLE staged_upload_intents(id TEXT PRIMARY KEY, scope TEXT, files_json TEXT, completed_at INTEGER, expires_at INTEGER);
    CREATE TABLE trip_files(id INTEGER PRIMARY KEY, filename TEXT);
    CREATE TABLE trek_photos(id INTEGER PRIMARY KEY, file_path TEXT, thumbnail_path TEXT);
    CREATE TABLE journeys(id INTEGER PRIMARY KEY, cover_image TEXT);
  `);
  deleteObject = vi.fn(async () => {});
  service = new UploadIntentGcService(new DatabaseService(db), {
    delete: deleteObject,
    directUploadPath: (category, name) => `${category}/${name}`,
  });
});

afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fileIntent(expiresAt = OLD, completedAt: number | null = null) {
  const id = randomUUID();
  const name = `${id}.pdf`;
  db.prepare('INSERT INTO upload_intents VALUES (?, ?, NULL, ?, ?)').run(id, name, completedAt, expiresAt);
  return { id, name };
}

function stagedIntent(count = 1) {
  const id = randomUUID();
  const files = Array.from({ length: count }, () => {
    const name = `${randomUUID()}.jpg`;
    return { category: 'journey', filename: name, pathname: `journey/${name}`, originalName: 'photo.jpg' };
  });
  db.prepare('INSERT INTO staged_upload_intents VALUES (?, ?, ?, NULL, ?)')
    .run(id, 'journey-entry-photos', JSON.stringify(files), OLD);
  return { id, files };
}

describe('bounded expired upload cleanup', () => {
  it('is inert locally and preserves completed and recently expired intents', async () => {
    fileIntent(OLD, NOW - 10_000);
    fileIntent(NOW - 30_000);
    await service.collect();
    expect(deleteObject).not.toHaveBeenCalled();
    vi.stubEnv('VERCEL', '');
    fileIntent();
    await service.collect();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('durably expires an intent before deleting bytes, then removes its metadata', async () => {
    const { id, name } = fileIntent();
    deleteObject.mockImplementationOnce(async () => {
      expect(db.prepare('SELECT expires_at, completed_at FROM upload_intents WHERE id = ?').get(id))
        .toEqual({ expires_at: 0, completed_at: null });
      // Finalization requires an unexpired intent; it cannot acquire this one.
      expect(db.prepare('SELECT id FROM upload_intents WHERE id = ? AND expires_at > ?').get(id, NOW)).toBeUndefined();
    });
    await service.collect();
    expect(deleteObject).toHaveBeenCalledWith('files', name);
    expect(db.prepare('SELECT * FROM upload_intents').all()).toEqual([]);
  });

  it('retains metadata and stops the batch on a deletion failure', async () => {
    const first = fileIntent();
    fileIntent();
    deleteObject.mockRejectedValueOnce(new Error('provider failure'));
    await service.collect();
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT expires_at FROM upload_intents WHERE id = ?').get(first.id)).toEqual({ expires_at: 0 });
    vi.mocked(Date.now).mockReturnValue(NOW + 61_000);
    await service.collect();
    expect(db.prepare('SELECT * FROM upload_intents').all()).toEqual([]);
  });

  it('persists per-object progress for a partially failed staged cleanup', async () => {
    const { id, files } = stagedIntent(2);
    deleteObject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('provider failure'));
    await service.collect();
    const row = db.prepare('SELECT files_json FROM staged_upload_intents WHERE id = ?').get(id) as { files_json: string };
    expect(JSON.parse(row.files_json)).toEqual([files[1]]);
    vi.mocked(Date.now).mockReturnValue(NOW + 61_000);
    await service.collect();
    expect(deleteObject).toHaveBeenLastCalledWith('journey', files[1].filename);
    expect(db.prepare('SELECT * FROM staged_upload_intents').all()).toEqual([]);
  });

  it('never deletes objects referenced by committed files, photos, posters or covers', async () => {
    const document = fileIntent();
    db.prepare('INSERT INTO trip_files(filename) VALUES (?)').run(document.name);
    const photo = stagedIntent();
    db.prepare('INSERT INTO trek_photos(file_path) VALUES (?)').run(photo.files[0].pathname);
    const poster = stagedIntent();
    db.prepare('INSERT INTO trek_photos(thumbnail_path) VALUES (?)').run(poster.files[0].pathname);
    const cover = stagedIntent();
    db.prepare('INSERT INTO journeys(cover_image) VALUES (?)').run(cover.files[0].pathname);
    await service.collect();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('refuses mismatched or non-server-owned object keys', async () => {
    const { id, files } = stagedIntent();
    files[0].pathname = 'journey/someone-elses.jpg';
    db.prepare('UPDATE staged_upload_intents SET files_json = ? WHERE id = ?').run(JSON.stringify(files), id);
    await service.collect();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(db.prepare('SELECT id FROM staged_upload_intents WHERE id = ?').get(id)).toBeDefined();
  });

  it('bounds object deletions and skips overlapping or too-frequent local sweeps', async () => {
    for (let index = 0; index < 6; index++) fileIntent();
    await service.collect();
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM upload_intents').get()).toEqual({ count: 4 });
    await service.collect();
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  it('checks completion again after selecting an expired candidate', async () => {
    const { id } = fileIntent();
    db.exec(`CREATE TRIGGER complete_before_claim BEFORE UPDATE OF expires_at ON upload_intents
      BEGIN UPDATE upload_intents SET completed_at = 1 WHERE id = NEW.id; END`);
    // The additional reference represents the atomic metadata write made by a
    // winning finalizer; even an inconsistent legacy intent must keep its bytes.
    const row = db.prepare('SELECT filename FROM upload_intents WHERE id = ?').get(id) as { filename: string };
    db.prepare('INSERT INTO trip_files(filename) VALUES (?)').run(row.filename);
    await service.collect();
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
