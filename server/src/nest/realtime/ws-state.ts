import { WebSocketServer, WebSocket } from 'ws';
import { randomInt } from 'node:crypto';
import { emitPluginEvent, pluginEventMeta } from '../../plugin-event-sink';
import { User } from '../../types';

/**
 * The socket registry: rooms, per-socket identity, and the three fan-out
 * primitives.
 *
 * MODULE state, not provider state, and that is load-bearing. The no-Nest test
 * harnesses hand-build RealtimeService instances (mcp-test-controllers.ts and
 * ~60 unit suites), and the 115 vi.mock('src/websocket') seams assert on these
 * exact exports. If the rooms lived on a provider instance, an out-of-container
 * broadcast would go to an empty map: no error, no log, just a client that
 * stops updating. Same reasoning as the geo throttle cursor and the
 * permissions cache.
 *
 * The gateway next door owns the connection lifecycle and the handshake and
 * writes into here. This file deliberately knows nothing about auth.
 */

export interface TrekWebSocket extends WebSocket {
  isAlive: boolean;
}

export interface SharedRealtimeEvent {
  /** Internal stream cursor, never added to the wire payload. */
  sequence?: number;
  scope: 'trip' | 'user' | 'book';
  targetId: number;
  payload: Record<string, unknown>;
  excludeSid?: number;
  onlyUserId?: number;
}

interface SharedTransport {
  publish(event: SharedRealtimeEvent): void;
  allowed(ws: TrekWebSocket, scope: SharedRealtimeEvent['scope'], targetId: number): boolean;
  peers(journeyId: number): BookPeer[];
  onlineUserIds(): Set<number>;
  latestSequence(): number;
}
let sharedTransport: SharedTransport | null = null;
export function setSharedTransport(transport: SharedTransport | null): void {
  sharedTransport = transport;
}

/** Incoming shared events never re-publish or re-emit plugin notifications. */
export function deliverSharedEvent(event: SharedRealtimeEvent): void {
  const targets = event.scope === 'trip' ? rooms.get(event.targetId)
    : event.scope === 'book' ? bookRooms.get(event.targetId) : wss?.clients;
  if (!targets) return;
  for (const socket of targets) {
    const ws = socket as TrekWebSocket;
    if (ws.readyState !== 1 || socketId.get(ws) === event.excludeSid) continue;
    if (event.scope === 'user' && socketUser.get(ws)?.id !== event.targetId) continue;
    if (event.onlyUserId != null && socketUser.get(ws)?.id !== event.onlyUserId) continue;
    const joinedAt = joinedSequences.get(ws)?.get(`${event.scope}:${event.targetId}`) ?? 0;
    if (event.sequence != null && event.sequence <= joinedAt) continue;
    if (sharedTransport && !sharedTransport.allowed(ws, event.scope, event.targetId)) continue;
    const payload = event.scope === 'book' && event.payload.type === 'journey:book:peers' && sharedTransport
      ? { ...event.payload, peers: sharedTransport.peers(event.targetId) } : event.payload;
    ws.send(JSON.stringify(payload));
  }
}

const rooms = new Map<number, Set<TrekWebSocket>>();
const joinedSequences = new WeakMap<TrekWebSocket, Map<string, number>>();

function markJoined(ws: TrekWebSocket, scope: SharedRealtimeEvent['scope'], id: number): void {
  if (!sharedTransport) return;
  if (!joinedSequences.has(ws)) joinedSequences.set(ws, new Map());
  joinedSequences.get(ws)!.set(`${scope}:${id}`, sharedTransport.latestSequence());
}

/**
 * Who has a Studio book open, per journey.
 *
 * Separate from the trip rooms above, and separate from "is a contributor
 * online": a book carries pointers and a presence list, and both are only of
 * interest to the people actually looking at it. Fanning them out to every
 * contributor's sockets would send a pointer moving at ten frames a second to
 * someone reading the journey on their phone.
 */
const bookRooms = new Map<number, Set<TrekWebSocket>>();
const socketBooks = new WeakMap<TrekWebSocket, Set<number>>();
const socketRooms = new WeakMap<TrekWebSocket, Set<number>>();
const socketUser = new WeakMap<TrekWebSocket, User>();
const socketId = new WeakMap<TrekWebSocket, number>();

/**
 * A monotonic integer, NOT a uuid.
 *
 * The client echoes it back as the X-Socket-Id header and `broadcast` excludes
 * the originator with `Number(excludeSid)`. `Number(<uuid>)` is NaN, and
 * `NaN === NaN` is false, so every client would receive its own writes back.
 * Nothing throws; it shows up as drag-and-drop that jumps back under your
 * cursor.
 */
let nextSocketId = 1;

let wss: WebSocketServer | null = null;

export function setServer(server: WebSocketServer | null): void {
  wss = server;
}

export function getServer(): WebSocketServer | null {
  return wss;
}

export function registerSocket(ws: TrekWebSocket, user: User): number {
  const sid = sharedTransport ? randomInt(1, 2 ** 48 - 1) : nextSocketId++;
  socketId.set(ws, sid);
  socketUser.set(ws, user);
  socketRooms.set(ws, new Set());
  markJoined(ws, 'user', user.id);
  return sid;
}

export function userOf(ws: TrekWebSocket): User | undefined {
  return socketUser.get(ws);
}

export function joinRoom(ws: TrekWebSocket, tripId: number): void {
  if (!rooms.has(tripId)) rooms.set(tripId, new Set());
  markJoined(ws, 'trip', tripId);
  rooms.get(tripId)!.add(ws);
  socketRooms.get(ws)?.add(tripId);
}

export function leaveRoom(ws: TrekWebSocket, tripId: number): void {
  const room = rooms.get(tripId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) rooms.delete(tripId);
  }
  socketRooms.get(ws)?.delete(tripId);
}

export function leaveAllRooms(ws: TrekWebSocket): void {
  const mine = socketRooms.get(ws);
  if (!mine) return;
  for (const tripId of mine) leaveRoom(ws, tripId);
}

// ── Studio books ──────────────────────────────────────────────────────────

export interface BookPeer {
  socketId: number;
  userId: number;
  username: string;
  avatar?: string | null;
}

export function joinBook(ws: TrekWebSocket, journeyId: number): void {
  if (!bookRooms.has(journeyId)) bookRooms.set(journeyId, new Set());
  markJoined(ws, 'book', journeyId);
  bookRooms.get(journeyId)!.add(ws);
  if (!socketBooks.has(ws)) socketBooks.set(ws, new Set());
  socketBooks.get(ws)!.add(journeyId);
}

export function leaveBook(ws: TrekWebSocket, journeyId: number): void {
  const room = bookRooms.get(journeyId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) bookRooms.delete(journeyId);
  }
  socketBooks.get(ws)?.delete(journeyId);
}

/** Every book this socket had open — called when the connection goes. */
export function leaveAllBooks(ws: TrekWebSocket): number[] {
  const mine = socketBooks.get(ws);
  if (!mine) return [];
  const left = [...mine];
  for (const journeyId of left) leaveBook(ws, journeyId);
  return left;
}

/**
 * Who is in a book, by socket rather than by user.
 *
 * One person with two tabs open is two entries on purpose: they have two
 * pointers, and a list keyed by user could not say which one moved.
 */
export function isInBook(ws: TrekWebSocket, journeyId: number): boolean {
  return bookRooms.get(journeyId)?.has(ws) ?? false;
}

export function bookPeers(journeyId: number): BookPeer[] {
  if (sharedTransport) return sharedTransport.peers(journeyId);
  const room = bookRooms.get(journeyId);
  if (!room) return [];
  const peers: BookPeer[] = [];
  for (const ws of room) {
    if (ws.readyState !== 1) continue;
    const user = socketUser.get(ws);
    const sid = socketId.get(ws);
    if (!user || sid == null) continue;
    peers.push({ socketId: sid, userId: user.id, username: user.username, avatar: user.avatar ?? null });
  }
  return peers;
}

/**
 * Send to everyone looking at a book.
 *
 * No plugin event sink here, unlike the trip broadcast: a pointer is not
 * something that happened to the trip, and announcing ten of them a second to
 * every subscribed plugin would be a firehose of nothing.
 */
export function broadcastToBook(
  journeyId: number,
  payload: Record<string, unknown>,
  excludeSid?: number,
): void {
  if (sharedTransport) {
    sharedTransport.publish({ scope: 'book', targetId: journeyId, payload: { journeyId, ...payload }, excludeSid });
    return;
  }
  const room = bookRooms.get(journeyId);
  if (!room || room.size === 0) return;
  for (const ws of room) {
    if (ws.readyState !== 1) continue;
    if (excludeSid != null && socketId.get(ws) === excludeSid) continue;
    ws.send(JSON.stringify({ journeyId, ...payload }));
  }
}

/** The socket's own id, so a handler can name the pointer it is forwarding. */
export function socketIdOf(ws: TrekWebSocket): number | undefined {
  return socketId.get(ws);
}

/**
 * Broadcast an event to all sockets in a trip room, optionally excluding a
 * socket.
 *
 * When `onlyUserId` is given the event is delivered only to that user's sockets
 * in the room — used to keep private packing items (#858) off other members'
 * screens while still syncing the owner's own tabs.
 */
export function broadcast(
  tripId: number | string,
  eventType: string,
  payload: Record<string, unknown>,
  excludeSid?: number | string,
  onlyUserId?: number,
): void {
  tripId = Number(tripId);
  // Announce every CORE trip event (name only, never the payload) to subscribed
  // plugins — before the room check so it fires even with no connected viewers
  // and with no ws server at all, and skipping plugin:* re-broadcasts so a
  // plugin's own events can't loop back.
  if (!eventType.startsWith('plugin:')) emitPluginEvent(tripId, eventType, pluginEventMeta(eventType, payload));
  if (sharedTransport) {
    sharedTransport.publish({ scope: 'trip', targetId: tripId, payload: { type: eventType, tripId, ...payload }, excludeSid: excludeSid ? Number(excludeSid) : undefined, onlyUserId });
    return;
  }
  const room = rooms.get(tripId);
  if (!room || room.size === 0) return;

  const excludeNum = excludeSid ? Number(excludeSid) : null;

  for (const ws of room) {
    if (ws.readyState !== 1) continue; // WebSocket.OPEN === 1
    if (excludeNum && socketId.get(ws) === excludeNum) continue;
    if (onlyUserId != null && socketUser.get(ws)?.id !== onlyUserId) continue;
    ws.send(JSON.stringify({ type: eventType, tripId, ...payload }));
  }
}

/** Send a message to all sockets belonging to a specific user (e.g. trip invitations). */
export function broadcastToUser(
  userId: number,
  payload: Record<string, unknown>,
  excludeSid?: number | string,
): void {
  if (sharedTransport) {
    sharedTransport.publish({ scope: 'user', targetId: userId, payload, excludeSid: excludeSid ? Number(excludeSid) : undefined });
    return;
  }
  if (!wss) return;
  const excludeNum = excludeSid ? Number(excludeSid) : null;
  for (const ws of wss.clients) {
    const tws = ws as TrekWebSocket;
    if (tws.readyState !== 1) continue;
    if (excludeNum && socketId.get(tws) === excludeNum) continue;
    if (socketUser.get(tws)?.id === userId) tws.send(JSON.stringify(payload));
  }
}

export function getOnlineUserIds(): Set<number> {
  if (sharedTransport) return sharedTransport.onlineUserIds();
  const ids = new Set<number>();
  if (!wss) return ids;
  for (const ws of wss.clients) {
    const tws = ws as TrekWebSocket;
    if (tws.readyState !== 1) continue;
    const user = socketUser.get(tws);
    if (user) ids.add(user.id);
  }
  return ids;
}
