import { readBlobStorageConfig, readRemoteDatabaseConfig } from '../../src/app-config/runtime';
import { unavailableRuntimeFeature, RuntimeCapabilityGuard } from '../../src/nest/common/runtime-capability.guard';
import { isVercelRuntime, vercelSecrets } from '../../src/runtime';
import type { ExecutionContext } from '@nestjs/common';

import { afterEach, describe, expect, it, vi } from 'vitest';

const context = (path: string) => ({ switchToHttp: () => ({ getRequest: () => ({ path }) }) }) as ExecutionContext;
afterEach(() => vi.unstubAllEnvs());

describe('Vercel runtime boundaries', () => {
  it('requires the explicit Vercel runtime flag', () => {
    vi.stubEnv('VERCEL', 'true');
    expect(isVercelRuntime()).toBe(false);
    expect(vercelSecrets()).toBeNull();
    vi.stubEnv('VERCEL', '1');
    expect(isVercelRuntime()).toBe(true);
  });
  it('fails closed without two stable, distinct deployment secrets', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('JWT_SECRET', '');
    vi.stubEnv('ENCRYPTION_KEY', '');
    expect(vercelSecrets).toThrow('requires JWT_SECRET');
    vi.stubEnv('JWT_SECRET', 'test-signing-fixture-not-a-real-secret');
    vi.stubEnv('ENCRYPTION_KEY', 'test-signing-fixture-not-a-real-secret');
    expect(vercelSecrets).toThrow('distinct');
    vi.stubEnv('ENCRYPTION_KEY', 'test-encryption-fixture-not-a-real-key');
    expect(vercelSecrets()?.jwt).toBe(process.env.JWT_SECRET);
  });
  it('requires a remote database on Vercel with no embedded credentials', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('TURSO_DATABASE_URL', '');
    vi.stubEnv('TURSO_AUTH_TOKEN', '');
    expect(readRemoteDatabaseConfig).toThrow('required together');
    vi.stubEnv('TURSO_AUTH_TOKEN', 'test-token-fixture');
    for (const url of [
      'file:local.db',
      'http://example.com',
      'https://user:pass@example.com',
      'https://example.com?token=bad',
    ]) {
      vi.stubEnv('TURSO_DATABASE_URL', url);
      expect(readRemoteDatabaseConfig).toThrow();
    }
    vi.stubEnv('TURSO_DATABASE_URL', 'libsql://example.turso.io');
    expect(readRemoteDatabaseConfig()?.url).toBe('libsql://example.turso.io');
  });
  it('requires a server-side Blob token', () => {
    vi.stubEnv('BLOB_STORE_ID', '');
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    expect(readBlobStorageConfig).toThrow('required');
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'test-blob-token-fixture');
    expect(readBlobStorageConfig()).toEqual({ token: 'test-blob-token-fixture' });
    vi.stubEnv('BLOB_STORE_ID', 'store_family');
    expect(readBlobStorageConfig()).toEqual({ storeId: 'store_family' });
    vi.stubEnv('BLOB_STORE_ID', '../bad');
    expect(readBlobStorageConfig).toThrow('invalid');
  });
  it('preserves local database defaults outside Vercel', () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('TURSO_DATABASE_URL', '');
    vi.stubEnv('TURSO_AUTH_TOKEN', '');
    expect(readRemoteDatabaseConfig()).toBeNull();
  });
  it.each([
    '/api/backup/create',
    '/api/admin/plugins/install',
    '/api/plugin-settings',
    '/mcp',
    '/oauth/token',
    '/api/admin/rotate-jwt-secret',
  ])('rejects unavailable feature %s', (path) => {
    vi.stubEnv('VERCEL', '1');
    expect(unavailableRuntimeFeature(path)).not.toBeNull();
    expect(() => new RuntimeCapabilityGuard().canActivate(context(path))).toThrow();
    vi.stubEnv('VERCEL', '');
    expect(new RuntimeCapabilityGuard().canActivate(context(path))).toBe(true);
  });
  it.each(['/api/trips', '/api/auth/login', '/api/files', '/api/maps', '/api/todo', '/api/budget'])(
    'retains core route %s',
    (path) => {
      vi.stubEnv('VERCEL', '1');
      expect(new RuntimeCapabilityGuard().canActivate(context(path))).toBe(true);
    },
  );
  it('leaves multipart restore rejection to the post-parser handler', () => {
    vi.stubEnv('VERCEL', '1');
    expect(new RuntimeCapabilityGuard().canActivate(context('/api/backup/upload-restore'))).toBe(true);
  });
});
