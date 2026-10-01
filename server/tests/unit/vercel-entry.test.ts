import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createVercelServer } from '../../src/vercel';

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

const boot = vi.hoisted(() => ({ buildApp: vi.fn(), getHttpServer: vi.fn() }));
vi.mock('../../src/bootstrap', () => boot);

const servers: Server[] = [];
const sockets: WebSocket[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('JWT_SECRET', 'test-signing-fixture-not-a-real-secret');
  vi.stubEnv('ENCRYPTION_KEY', 'test-encryption-fixture-not-a-real-key');
});
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  vi.unstubAllEnvs();
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
it('shares cold-start initialization across concurrent requests', async () => {
  const application = createServer((_req, res) => {
    res.end('ok');
  });
  boot.getHttpServer.mockReturnValue(application);
  boot.buildApp.mockResolvedValue({});
  const url = await listen(createVercelServer());
  const responses = await Promise.all([fetch(url), fetch(url)]);
  expect(await Promise.all(responses.map((r) => r.text()))).toEqual(['ok', 'ok']);
  expect(boot.buildApp).toHaveBeenCalledTimes(1);
});
it('forwards a real upgrade and WebSocket frames to the Nest-bound server', async () => {
  const application = createServer();
  const wss = new WebSocketServer({ server: application, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => socket.send(data.toString()));
  });
  boot.getHttpServer.mockReturnValue(application);
  boot.buildApp.mockResolvedValue({});
  const url = await listen(createVercelServer());
  const client = new WebSocket(`${url.replace('http:', 'ws:')}/ws?token=test`);
  sockets.push(client);
  await once(client, 'open');
  const message = once(client, 'message');
  client.send('realtime works');
  expect((await message)[0].toString()).toBe('realtime works');
  client.terminate();
  wss.close();
  expect(boot.buildApp).toHaveBeenCalledTimes(1);
});
it('fails closed and never retries a partial initialization', async () => {
  boot.buildApp.mockRejectedValue(new Error('private startup detail'));
  const url = await listen(createVercelServer());
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private startup detail');
  }
  expect(boot.buildApp).toHaveBeenCalledTimes(1);
});
it('refuses the entry outside Vercel', async () => {
  vi.stubEnv('VERCEL', '');
  const url = await listen(createVercelServer());
  expect((await fetch(url)).status).toBe(503);
  expect(boot.buildApp).not.toHaveBeenCalled();
});

it('packages the HTTP server, native databases, and WebSocket rewrite', () => {
  const root = resolve(__dirname, '../../..');
  const entry = readFileSync(resolve(root, 'api/index.js'), 'utf8');
  expect(entry).toContain("require('../server/dist/vercel').default");
  const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  expect(config.rewrites).toContainEqual({ source: '/ws', destination: '/api/index' });
  expect(config.functions['api/index.js'].includeFiles.length).toBeLessThanOrEqual(256);
  expect(config.functions['api/index.js'].excludeFiles.length).toBeLessThanOrEqual(256);
  expect(config.functions['api/index.js'].includeFiles).toContain('@libsql');
  expect(config.functions['api/index.js'].includeFiles).toContain('better-sqlite3');
  expect(config.functions['api/index.js'].includeFiles).toContain('@napi-rs/canvas');
  expect(config.functions['api/index.js'].includeFiles).toContain('pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs');
  expect(config.functions['api/index.js'].maxDuration).toBe(300);
  expect(config.functions['api/index.js'].excludeFiles).toContain('server/data/**');
  expect(config.functions['api/index.js'].excludeFiles).toContain('server/data/**/.*');
  expect(config.functions['api/index.js'].excludeFiles).toContain('**/.env');
});
