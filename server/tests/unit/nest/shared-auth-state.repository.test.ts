import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { SharedAuthStateRepository } from '../../../src/nest/auth/shared-auth-state.repository';
import { RateLimitService } from '../../../src/nest/common/rate-limit.service';
import { OidcService, OIDC_AUTH_CODE_TTL_MS, OIDC_STATE_TTL_MS } from '../../../src/nest/oidc/oidc.service';
import { TripMembershipService } from '../../../src/nest/trip-membership/trip-membership.service';
import type { AuthService } from '../../../src/nest/auth/auth.service';

vi.mock('../../../src/db/database', () => ({}));
vi.mock('../../../src/nest/auth/auth.service', () => ({ AuthService: class {} }));
vi.mock('../../../src/config', () => ({ ENCRYPTION_KEY: 'shared-auth-test-encryption-only', JWT_SECRET: 'shared-auth-test-jwt-only' }));

let directory: string;
let connections: Database.Database[];
let databases: DatabaseService[];
let repositories: SharedAuthStateRepository[];
let oidc: OidcService[];

beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  directory = mkdtempSync(join(tmpdir(), 'trek-shared-auth-'));
  connections = [new Database(join(directory, 'shared.sqlite')), new Database(join(directory, 'shared.sqlite'))];
  connections[0].exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE auth_ephemeral_state (namespace TEXT, key_hash TEXT, value TEXT, expires_at INTEGER, PRIMARY KEY(namespace, key_hash));
    CREATE TABLE auth_rate_limits (key_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `);
  databases = connections.map(connection => new DatabaseService(connection));
  repositories = databases.map(db => new SharedAuthStateRepository(db));
  oidc = databases.map(db => new OidcService(db, {} as AuthService, new TripMembershipService(db)));
});

afterEach(() => {
  for (const service of oidc) service.onModuleDestroy();
  for (const connection of connections) connection.close();
  rmSync(directory, { recursive: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('shared auth state across independent SQLite connections', () => {
  it('persists only hashed identifiers and randomized authenticated ciphertext', () => {
    const value = { secret: 'plaintext-otp-secret', verifier: 'plaintext-pkce-verifier' };
    repositories[0].put('mfa-setup', 'private-user-key', value, Date.now() + 10_000);
    const first = databases[1].get<{ key_hash: string; value: string }>('SELECT key_hash, value FROM auth_ephemeral_state')!;
    expect(first.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain('private-user-key');
    expect(JSON.stringify(first)).not.toContain(value.secret);
    expect(JSON.stringify(first)).not.toContain(value.verifier);
    expect(repositories[1].read('mfa-setup', 'private-user-key')?.value).toEqual(value);
    repositories[1].put('mfa-setup', 'private-user-key', value, Date.now() + 10_000);
    expect(repositories[0].read('mfa-setup', 'private-user-key')?.revision).not.toBe(first.value);
  });

  it('rejects tampering and ciphertext moved to another key or namespace', () => {
    repositories[0].put('mfa-setup', 'user-one', 'secret-one', Date.now() + 10_000);
    repositories[0].put('mfa-setup', 'user-two', 'secret-two', Date.now() + 10_000);
    const original = repositories[0].read<string>('mfa-setup', 'user-one')!;
    databases[0].run('UPDATE auth_ephemeral_state SET value = ?', original.revision);
    expect(() => repositories[1].read('mfa-setup', 'user-two')).toThrow();
    databases[0].run("UPDATE auth_ephemeral_state SET namespace = 'oidc-code'");
    // Key hashes are themselves namespaced, and the GCM AAD binds both values.
    expect(repositories[1].read('oidc-code', 'user-one')).toBeNull();
    databases[0].run("UPDATE auth_ephemeral_state SET namespace = 'mfa-setup', value = 'tampered'");
    expect(() => repositories[1].read('mfa-setup', 'user-one')).toThrow();
  });

  it('enforces expiry at read, consume and compare-and-delete, without a timer', () => {
    const now = Date.now();
    repositories[0].put('mfa-setup', 'user', 'secret', now + 1000);
    const pending = repositories[1].read<string>('mfa-setup', 'user', now)!;
    expect(repositories[1].read('mfa-setup', 'user', now + 1000)).toBeNull();
    expect(repositories[1].compareAndDelete('mfa-setup', 'user', pending.revision, now + 1000)).toBe(false);
    expect(repositories[0].consume('mfa-setup', 'user', now + 1000)).toEqual({ expired: true });
    expect(repositories[1].consume('mfa-setup', 'user', now)).toBeNull();
  });

  it('CAS never consumes a replacement and only one instance wins', () => {
    repositories[0].put('mfa-setup', 'user', 'old', Date.now() + 10_000);
    const old = repositories[0].read<string>('mfa-setup', 'user')!;
    repositories[1].put('mfa-setup', 'user', 'new', Date.now() + 10_000);
    expect(repositories[0].compareAndDelete('mfa-setup', 'user', old.revision)).toBe(false);
    const fresh = repositories[1].read<string>('mfa-setup', 'user')!;
    expect(repositories[0].compareAndDelete('mfa-setup', 'user', fresh.revision)).toBe(true);
    expect(repositories[1].compareAndDelete('mfa-setup', 'user', fresh.revision)).toBe(false);
    repositories[0].put('mfa-setup', 'user', 'cancelled', Date.now() + 10_000);
    repositories[1].delete('mfa-setup', 'user');
    expect(repositories[0].read('mfa-setup', 'user')).toBeNull();
  });

  it('atomically caps IP attempts across instances and resets only at expiry', () => {
    const services = databases.map(db => new RateLimitService(db));
    const now = Date.now();
    for (let i = 0; i < 40; i++) expect(services[i % 2].check('login', '192.0.2.1', 3, 1000, now)).toBe(i < 3);
    expect(databases[0].get<{ count: number }>('SELECT count FROM auth_rate_limits')?.count).toBe(3);
    expect(services[0].check('login', '192.0.2.1', 3, 1000, now + 999)).toBe(false);
    expect(services[1].check('login', '192.0.2.1', 3, 1000, now + 1000)).toBe(true);
    expect(services[0].check('mfa', '192.0.2.1', 3, 1000, now)).toBe(true);
    expect(services[1].check('login', '192.0.2.2', 3, 1000, now)).toBe(true);
    expect(services[1].check('invalid', '192.0.2.2', 0, 1000, now)).toBe(false);
    expect(services[1].check('invalid', '192.0.2.2', 1, 0, now)).toBe(false);
    expect(JSON.stringify(databases[0].all('SELECT * FROM auth_rate_limits'))).not.toContain('192.0.2.1');
    expect(() => new RateLimitService().check('login', 'ip', 3, 1000, now)).toThrow(/database is required/);
  });

  it('sweeps expired records on later activity without affecting live state', () => {
    const now = Date.now();
    repositories[0].put('mfa-setup', 'expired', 'old', now + 1000);
    repositories[0].put('mfa-setup', 'live', 'new', now + 1_000_000);
    repositories[0].checkRateLimit('email', 'old@example.com', 3, 1000, now);
    repositories[0].checkRateLimit('email', 'new@example.com', 3, 1000, now + 300_001);
    expect(databases[0].get<{ count: number }>('SELECT COUNT(*) AS count FROM auth_ephemeral_state')?.count).toBe(1);
    expect(databases[0].get<{ count: number }>('SELECT COUNT(*) AS count FROM auth_rate_limits')?.count).toBe(1);
  });
});

describe('Vercel OIDC handoff', () => {
  it('consumes PKCE state on another instance once, retaining redirect, invitation and remember', () => {
    const { state, codeChallenge } = oidc[0].createState('https://trek.example/callback', 'invite-secret', true);
    const pending = oidc[1].consumeState(state)!;
    expect(pending).toMatchObject({ redirectUri: 'https://trek.example/callback', inviteToken: 'invite-secret', remember: true });
    expect(createHash('sha256').update(pending.codeVerifier).digest('base64url')).toBe(codeChallenge);
    expect(oidc[0].consumeState(state)).toBeNull();
  });

  it('rejects state exactly at its TTL even if no cleanup timer runs', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { state } = oidc[0].createState('https://trek.example/callback');
    vi.mocked(Date.now).mockReturnValue(now + OIDC_STATE_TTL_MS);
    expect(oidc[1].consumeState(state)).toBeNull();
  });

  it('stores no plaintext JWT, requires the binding cookie, and permits only one redemption', () => {
    const { code, binding } = oidc[0].createAuthCode('private-jwt-value', true);
    const persisted = JSON.stringify(databases[1].all('SELECT * FROM auth_ephemeral_state'));
    expect(persisted).not.toContain(code);
    expect(persisted).not.toContain(binding);
    expect(persisted).not.toContain('private-jwt-value');
    expect(oidc[1].consumeAuthCode(code, binding)).toEqual({ token: 'private-jwt-value', remember: true });
    expect(oidc[0].consumeAuthCode(code, binding)).toEqual({ error: 'Invalid or expired code' });
  });

  it.each([undefined, 'wrong-binding'])('burns the code for missing or incorrect binding: %s', binding => {
    const issued = oidc[0].createAuthCode('private-jwt');
    expect(oidc[1].consumeAuthCode(issued.code, binding)).toEqual({ error: 'Invalid or expired code' });
    expect(oidc[0].consumeAuthCode(issued.code, issued.binding)).toEqual({ error: 'Invalid or expired code' });
  });

  it('rejects and burns codes at their exact expiry', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const issued = oidc[0].createAuthCode('private-jwt');
    vi.mocked(Date.now).mockReturnValue(now + OIDC_AUTH_CODE_TTL_MS);
    expect(oidc[1].consumeAuthCode(issued.code, issued.binding)).toEqual({ error: 'Code expired' });
    expect(oidc[0].consumeAuthCode(issued.code, issued.binding)).toEqual({ error: 'Invalid or expired code' });
  });
});
