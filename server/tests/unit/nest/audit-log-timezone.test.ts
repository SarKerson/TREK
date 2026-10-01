import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { logError } from '../../../src/nest/audit/audit-log.logger';
import { applyGlobalMiddleware } from '../../../src/middleware/globalMiddleware';

beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('FORCE_HTTPS', 'false');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:34:56Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('audit timestamps tolerate host TZ settings', () => {
  it.each([
    ['UTC', '2026-10-01T12:34:56'],
    [':UTC', '2026-10-01T12:34:56'],
    ['America/New_York', '2026-10-01T08:34:56'],
    [':Asia/Tokyo', '2026-10-01T21:34:56'],
    [' Europe/Berlin ', '2026-10-01T14:34:56'],
  ])('preserves the requested zone for TZ=%s', (tz, timestamp) => {
    vi.stubEnv('TZ', tz);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logError('request failed')).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`${timestamp} request failed`));
  });

  it.each([undefined, '', ':', '::UTC', 'Invalid/Timezone', '../../etc/localtime', 'UTC+garbage'])(
    'falls back to UTC without throwing for TZ=%s',
    (tz) => {
      vi.stubEnv('TZ', tz);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => logError('request failed')).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('2026-10-01T12:34:56 request failed'));
    },
  );

  it.each([':UTC', 'Invalid/Timezone'])('does not crash a response finish listener for TZ=%s', async (tz) => {
    vi.stubEnv('TZ', tz);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    applyGlobalMiddleware(app);
    app.post('/api/auth/login', (_req, res) => res.status(500).json({ error: 'upstream failure' }));
    app.get('/next', (_req, res) => res.json({ ok: true }));

    expect((await request(app).post('/api/auth/login')).status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('POST /api/auth/login 500'));
    expect((await request(app).get('/next')).body).toEqual({ ok: true });
  });
});
