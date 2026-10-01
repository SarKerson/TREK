import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import type { BookPeer, SharedRealtimeEvent } from './ws-state';

interface EventRow {
  id: number;
  scope: SharedRealtimeEvent['scope'];
  target_id: number;
  payload: string;
  exclude_sid: number | null;
  only_user_id: number | null;
}

const EVENT_TTL_MS = 5 * 60_000;
const PRESENCE_TTL_MS = 75_000;

/** Durable cross-instance fan-out. A lost stream is closed and rehydrated via REST. */
export class SharedRealtimeRepository {
  private readonly origin = randomUUID();
  private cursor: number;
  private lastCleanup = 0;

  constructor(private readonly db: DatabaseService) {
    this.cursor = this.latestSequence();
  }

  latestSequence(): number {
    // sqlite_sequence survives expiry of every event, unlike MAX(id).
    return this.db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'realtime_events'")?.seq ?? 0;
  }

  resetCursor(): void {
    this.cursor = this.latestSequence();
  }

  publish(event: SharedRealtimeEvent): void {
    this.db.run(
      'INSERT INTO realtime_events (origin, scope, target_id, payload, exclude_sid, only_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      this.origin, event.scope, event.targetId, JSON.stringify(event.payload), event.excludeSid ?? null,
      event.onlyUserId ?? null, Date.now(),
    );
  }

  /** Preserve global sequence, including local writes. A full page never skips the next. */
  poll(deliver: (event: SharedRealtimeEvent) => void): void {
    const rows = this.db.all<EventRow>(
      'SELECT id, scope, target_id, payload, exclude_sid, only_user_id FROM realtime_events WHERE id > ? ORDER BY id LIMIT 500',
      this.cursor,
    );
    for (const row of rows) {
      if (row.id !== this.cursor + 1) throw new Error('Realtime event history expired; reconnect required');
      const payload: unknown = JSON.parse(row.payload);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Invalid realtime event payload');
      }
      deliver({ sequence: row.id, scope: row.scope, targetId: row.target_id,
        payload: payload as Record<string, unknown>,
        excludeSid: row.exclude_sid ?? undefined, onlyUserId: row.only_user_id ?? undefined });
      this.cursor = row.id;
    }
    if (rows.length === 0 && this.latestSequence() > this.cursor) {
      throw new Error('Realtime event history expired; reconnect required');
    }
  }

  /** Request-driven expiry, safe when an instance is suspended or killed. */
  cleanup(): number[] {
    const now = Date.now();
    if (now - this.lastCleanup < 30_000) return [];
    this.lastCleanup = now;
    const expired = this.db.all<{ scope: string; target_id: number }>(
      "DELETE FROM realtime_presence WHERE expires_at <= ? RETURNING scope, target_id", now,
    );
    this.db.run('DELETE FROM realtime_events WHERE created_at < ?', now - EVENT_TTL_MS);
    return [...new Set(expired.filter(row => row.scope === 'book').map(row => row.target_id))];
  }

  join(socketId: number, userId: number, pv: number, scope: 'user' | 'book', targetId: number): void {
    this.db.run(
      `INSERT INTO realtime_presence (socket_id, scope, target_id, user_id, pv, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(socket_id, scope, target_id) DO UPDATE SET expires_at = excluded.expires_at, pv = excluded.pv`,
      socketId, scope, targetId, userId, pv, Date.now() + PRESENCE_TTL_MS,
    );
  }

  renew(socketId: number): void {
    this.db.run('UPDATE realtime_presence SET expires_at = ? WHERE socket_id = ?', Date.now() + PRESENCE_TTL_MS, socketId);
  }

  leaveBook(socketId: number, journeyId: number): void {
    this.db.run("DELETE FROM realtime_presence WHERE socket_id = ? AND scope = 'book' AND target_id = ?", socketId, journeyId);
  }

  disconnect(socketId: number): void {
    this.db.run('DELETE FROM realtime_presence WHERE socket_id = ?', socketId);
  }

  peers(journeyId: number): BookPeer[] {
    return this.db.all<BookPeer>(
      `SELECT p.socket_id AS socketId, u.id AS userId, u.username, u.avatar
       FROM realtime_presence p JOIN users u ON u.id = p.user_id AND u.password_version = p.pv
       WHERE p.scope = 'book' AND p.target_id = ? AND p.expires_at > ? ORDER BY p.socket_id`,
      journeyId, Date.now(),
    );
  }

  onlineUserIds(): Set<number> {
    return new Set(this.db.all<{ user_id: number }>(
      `SELECT DISTINCT p.user_id FROM realtime_presence p
       JOIN users u ON u.id = p.user_id AND u.password_version = p.pv
       WHERE p.scope = 'user' AND p.expires_at > ?`, Date.now(),
    ).map(row => row.user_id));
  }
}
