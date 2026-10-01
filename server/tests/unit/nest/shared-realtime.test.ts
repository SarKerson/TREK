import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { SharedRealtimeRepository } from '../../../src/nest/realtime/shared-realtime.repository';
import {
  bookPeers, broadcast, broadcastToUser, deliverSharedEvent, getOnlineUserIds,
  joinRoom, leaveAllBooks, leaveAllRooms, registerSocket, setServer, setSharedTransport,
  type SharedRealtimeEvent, type TrekWebSocket,
} from '../../../src/nest/realtime/ws-state';
import { RealtimeGateway } from '../../../src/nest/realtime/realtime.gateway';
import { EphemeralTokenService } from '../../../src/nest/auth/ephemeral-token.service';
import type { JourneyDomainService } from '../../../src/nest/journey/journey-domain.service';
import type { User } from '../../../src/types';

const runtime = vi.hoisted(() => ({ vercel: false }));
vi.mock('../../../src/runtime', () => ({ isVercelRuntime: () => runtime.vercel, vercelSecrets: () => null }));
vi.mock('../../../src/plugin-event-sink', () => ({ emitPluginEvent: vi.fn(), pluginEventMeta: vi.fn(() => ({})) }));

let folder: string;
let connections: Sqlite.Database[];
let db: DatabaseService;
let otherDb: DatabaseService;
const sockets: TrekWebSocket[] = [];
const gateways: RealtimeGateway[] = [];

function socket() {
  const ws = {
    readyState: 1, isAlive: true, send: vi.fn(), close: vi.fn(), terminate: vi.fn(), ping: vi.fn(), on: vi.fn(),
  } as unknown as TrekWebSocket;
  sockets.push(ws);
  return ws;
}

beforeEach(() => {
  runtime.vercel = true;
  folder = mkdtempSync(join(tmpdir(), 'trek-shared-'));
  connections = [new Sqlite(join(folder, 'db.sqlite')), new Sqlite(join(folder, 'db.sqlite'))];
  connections[0].exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, email TEXT, role TEXT, avatar TEXT, mfa_enabled INTEGER, password_version INTEGER);
    INSERT INTO users VALUES (1,'one','one@test','user',NULL,0,0),(2,'two','two@test','user',NULL,0,0);
    CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE realtime_events(id INTEGER PRIMARY KEY AUTOINCREMENT,origin TEXT,scope TEXT,target_id INTEGER,payload TEXT,exclude_sid INTEGER,only_user_id INTEGER,created_at INTEGER);
    CREATE TABLE realtime_presence(socket_id INTEGER,scope TEXT,target_id INTEGER,user_id INTEGER,pv INTEGER,expires_at INTEGER,PRIMARY KEY(socket_id,scope,target_id));
    CREATE TABLE ephemeral_tokens(token_hash TEXT PRIMARY KEY,user_id INTEGER,purpose TEXT,expires_at INTEGER,pv INTEGER);
  `);
  db = new DatabaseService(connections[0]);
  otherDb = new DatabaseService(connections[1]);
});

afterEach(() => {
  gateways.splice(0).forEach(gateway => gateway.onModuleDestroy());
  sockets.splice(0).forEach(ws => { leaveAllRooms(ws); leaveAllBooks(ws); });
  setSharedTransport(null);
  setServer(null);
  connections.forEach(connection => connection.close());
  rmSync(folder, { recursive: true, force: true });
  vi.useRealTimers();
  runtime.vercel = false;
});

describe('shared realtime ordered stream', () => {
  it('delivers another connection’s writes in global order and does not skip a full page', () => {
    const reader = new SharedRealtimeRepository(db);
    const writer = new SharedRealtimeRepository(otherDb);
    for (let i = 0; i < 502; i++) writer.publish({ scope: 'trip', targetId: 7, payload: { type: 'trip:updated', i } });
    const events: SharedRealtimeEvent[] = [];
    reader.poll(event => events.push(event));
    expect(events).toHaveLength(500);
    reader.poll(event => events.push(event));
    expect(events).toHaveLength(502);
    expect(events.map(event => event.payload.i)).toEqual(Array.from({ length: 502 }, (_, i) => i));
    reader.poll(event => events.push(event));
    expect(events).toHaveLength(502);
  });

  it('refuses a truncated stream including when every retained row has expired', () => {
    const reader = new SharedRealtimeRepository(db);
    const writer = new SharedRealtimeRepository(otherDb);
    writer.publish({ scope: 'user', targetId: 1, payload: { type: 'x' } });
    db.run('DELETE FROM realtime_events');
    expect(() => reader.poll(vi.fn())).toThrow('history expired');
    reader.resetCursor();
    writer.publish({ scope: 'user', targetId: 1, payload: { type: 'y' } });
    const deliver = vi.fn();
    reader.poll(deliver);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ payload: { type: 'y' } }));
  });

  it('retains origin exclusion and private-user filtering across connections', () => {
    const repo = new SharedRealtimeRepository(db);
    const allowed = vi.fn(() => true);
    setSharedTransport({ publish: event => repo.publish(event), allowed, peers: () => [], onlineUserIds: () => new Set(), latestSequence: () => repo.latestSequence() });
    const mine = socket(); const otherTab = socket(); const stranger = socket();
    const sid = registerSocket(mine, { id: 1 } as User);
    registerSocket(otherTab, { id: 1 } as User); registerSocket(stranger, { id: 2 } as User);
    for (const ws of [mine, otherTab, stranger]) joinRoom(ws, 7);
    setServer({ clients: new Set([mine, otherTab, stranger]) } as never);
    broadcast(7, 'packing:updated', { private: true }, sid, 1);
    repo.poll(deliverSharedEvent);
    expect(mine.send).not.toHaveBeenCalled();
    expect(otherTab.send).toHaveBeenCalledTimes(1);
    expect(stranger.send).not.toHaveBeenCalled();
    broadcastToUser(2, { type: 'trip:invite' });
    repo.poll(deliverSharedEvent);
    expect(stranger.send).toHaveBeenCalledTimes(1);
    expect(Number.isSafeInteger(sid)).toBe(true);
  });

  it('does not replay events published before the socket joined', () => {
    const repo = new SharedRealtimeRepository(db);
    setSharedTransport({ publish: event => repo.publish(event), allowed: () => true, peers: () => [], onlineUserIds: () => new Set(), latestSequence: () => repo.latestSequence() });
    repo.publish({ scope: 'trip', targetId: 7, payload: { type: 'old' } });
    const ws = socket(); registerSocket(ws, { id: 1 } as User); joinRoom(ws, 7);
    repo.publish({ scope: 'trip', targetId: 7, payload: { type: 'new' } });
    repo.poll(deliverSharedEvent);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'new' }));
  });

  it('fails closed at delivery after membership is revoked', () => {
    const repo = new SharedRealtimeRepository(db);
    setSharedTransport({ publish: event => repo.publish(event), allowed: () => false, peers: () => [], onlineUserIds: () => new Set(), latestSequence: () => repo.latestSequence() });
    const ws = socket(); registerSocket(ws, { id: 1 } as User); joinRoom(ws, 7);
    broadcast(7, 'private', { secret: 'private trip' });
    repo.poll(deliverSharedEvent);
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('shared presence and revocation', () => {
  it('shares book peers and online users, and expires abandoned sockets', () => {
    vi.useFakeTimers();
    const first = new SharedRealtimeRepository(db); const second = new SharedRealtimeRepository(otherDb);
    first.join(101, 1, 0, 'user', 1); first.join(101, 1, 0, 'book', 7);
    second.join(202, 2, 0, 'user', 2); second.join(202, 2, 0, 'book', 7);
    expect(second.peers(7).map(peer => peer.userId)).toEqual([1, 2]);
    expect(first.onlineUserIds()).toEqual(new Set([1, 2]));
    vi.advanceTimersByTime(60_000); second.renew(202);
    vi.advanceTimersByTime(16_000);
    expect(first.cleanup()).toEqual([7]);
    expect(second.peers(7).map(peer => peer.userId)).toEqual([2]);
    expect(first.onlineUserIds()).toEqual(new Set([2]));
    second.leaveBook(202, 7); expect(first.peers(7)).toEqual([]);
    second.disconnect(202); expect(first.onlineUserIds()).toEqual(new Set());
  });

  it('hides password-revoked presence immediately', () => {
    const repo = new SharedRealtimeRepository(db);
    repo.join(1, 1, 0, 'book', 7); repo.join(1, 1, 0, 'user', 1);
    otherDb.run('UPDATE users SET password_version = 1 WHERE id = 1');
    expect(repo.peers(7)).toEqual([]); expect(repo.onlineUserIds()).toEqual(new Set());
  });

  it('checks identity at delivery and clears presence on disconnect', () => {
    vi.useFakeTimers();
    vi.spyOn(db, 'canAccessTrip').mockReturnValue({} as never);
    const tokens = new EphemeralTokenService(db);
    const journeys = { canAccessJourney: () => ({ id: 7 }) } as unknown as JourneyDomainService;
    const gateway = new RealtimeGateway(db, tokens, journeys); gateways.push(gateway);
    const ws = socket(); const server = { clients: new Set([ws]) };
    setServer(server as never); gateway.afterInit(server as never);
    gateway.handleConnection(ws, { url: `/ws?token=${tokens.create(1, 'ws', { pv: 0 })}` } as never);
    gateway.handleJoin({ tripId: 7 }, ws);
    gateway.handleBookJoin({ journeyId: 7 }, ws);
    expect(bookPeers(7).map(peer => peer.userId)).toEqual([1]);
    expect(getOnlineUserIds()).toEqual(new Set([1]));
    vi.mocked(ws.send).mockClear();
    otherDb.run('UPDATE users SET password_version = 1 WHERE id = 1');
    broadcast(7, 'private', {});
    vi.advanceTimersByTime(2000);
    expect(ws.close).toHaveBeenCalledWith(4001, 'Session expired');
    expect(ws.send).not.toHaveBeenCalled();
    gateway.handleDisconnect(ws);
    expect(bookPeers(7)).toEqual([]);
  });
});

describe('shared gateway failure recovery', () => {
  function connected() {
    vi.useFakeTimers();
    vi.spyOn(db, 'canAccessTrip').mockReturnValue({} as never);
    const tokens = new EphemeralTokenService(db);
    const journeys = { canAccessJourney: () => ({ id: 7 }) } as unknown as JourneyDomainService;
    const gateway = new RealtimeGateway(db, tokens, journeys); gateways.push(gateway);
    const ws = socket(); const server = { clients: new Set([ws]) };
    setServer(server as never); gateway.afterInit(server as never);
    gateway.handleConnection(ws, { url: `/ws?token=${tokens.create(1, 'ws', { pv: 0 })}` } as never);
    gateway.handleJoin({ tripId: 7 }, ws);
    return { gateway, ws };
  }

  it('closes an incomplete stream instead of leaving clients silently stale', () => {
    const { ws } = connected();
    broadcast(7, 'trip:updated', {});
    db.run('DELETE FROM realtime_events');
    vi.advanceTimersByTime(2000);
    expect(ws.close).toHaveBeenCalledWith(1012, 'Resynchronization required');
  });

  it('closes password-revoked idle sockets on the heartbeat', () => {
    const { ws } = connected();
    otherDb.run('UPDATE users SET password_version = 1 WHERE id = 1');
    vi.advanceTimersByTime(30_000);
    expect(ws.close).toHaveBeenCalledWith(4001, 'Session expired');
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('enforces an MFA policy enabled while the connection is open', () => {
    const { ws } = connected();
    otherDb.run("INSERT INTO app_settings VALUES ('require_mfa', 'true')");
    broadcast(7, 'trip:updated', {});
    vi.advanceTimersByTime(2000);
    expect(ws.close).toHaveBeenCalledWith(4403, 'MFA required');
  });

  it('stops delivering to removed members even while their socket remains open', () => {
    const { ws } = connected();
    vi.mocked(db.canAccessTrip).mockReturnValue(undefined);
    vi.mocked(ws.send).mockClear();
    broadcast(7, 'trip:updated', { secret: 'must not arrive' });
    vi.advanceTimersByTime(2000);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('closes a handshake if the shared ticket store cannot be read', () => {
    const tokens = new EphemeralTokenService(db);
    vi.spyOn(tokens, 'consumeWithMeta').mockImplementation(() => { throw new Error('unavailable'); });
    const gateway = new RealtimeGateway(db, tokens, {} as JourneyDomainService); gateways.push(gateway);
    const ws = socket();
    expect(() => gateway.handleConnection(ws, { url: '/ws?token=opaque' } as never)).not.toThrow();
    expect(ws.close).toHaveBeenCalledWith(1012, 'Resynchronization required');
  });
});

describe('shared one-use handshake tickets', () => {
  it('enforces the shared capacity and exact expiry without a cleanup timer', () => {
    vi.useFakeTimers();
    const tokens = new EphemeralTokenService(db);
    db.run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO ephemeral_tokens SELECT CAST(x AS TEXT), 1, 'ws', ?, 0 FROM n`, Date.now() + 30_000);
    expect(tokens.create(1, 'ws')).toBeNull();
    vi.advanceTimersByTime(30_000);
    const token = tokens.create(1, 'ws')!;
    expect(token).toBeTruthy();
    vi.advanceTimersByTime(30_000);
    expect(tokens.consume(token, 'ws')).toBeNull();
  });

  it('stores only hashes, keeps metadata and burns tickets atomically between instances', () => {
    const first = new EphemeralTokenService(db);
    const ticket = first.create(1, 'ws', { pv: 3 })!;
    const stored = db.get<{ token_hash: string }>('SELECT token_hash FROM ephemeral_tokens')!;
    expect(stored.token_hash).not.toBe(ticket); expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const second = new EphemeralTokenService(otherDb);
    expect(second.consumeWithMeta(ticket, 'ws')).toEqual({ userId: 1, pv: 3 });
    expect(first.consume(ticket, 'ws')).toBeNull();
  });

  it('burns wrong-purpose and expired tickets and rejects versions changed after mint', () => {
    vi.useFakeTimers(); const tokens = new EphemeralTokenService(db);
    const wrong = tokens.create(1, 'ws')!;
    expect(tokens.consume(wrong, 'download')).toBeNull(); expect(tokens.consume(wrong, 'ws')).toBeNull();
    const expired = tokens.create(1, 'ws')!; vi.advanceTimersByTime(30_001);
    expect(tokens.consume(expired, 'ws')).toBeNull();
    const revoked = tokens.create(1, 'ws', { pv: 0 })!; otherDb.run('UPDATE users SET password_version = 1 WHERE id = 1');
    const gateway = new RealtimeGateway(db, tokens, {} as JourneyDomainService); gateways.push(gateway);
    const ws = socket(); gateway.handleConnection(ws, { url: `/ws?token=${revoked}` } as never);
    expect(ws.close).toHaveBeenCalledWith(4001, 'Invalid or expired token');
  });
});
