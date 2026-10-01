import 'reflect-metadata';
import './app-config/boot-validate';
import { buildApp, getHttpServer } from './bootstrap';
import { isVercelRuntime, vercelSecrets } from './runtime';

import { createServer, type Server } from 'node:http';

/**
 * Export an HTTP server, not only an Express request listener: Vercel forwards
 * upgrades to this object. Nest's bound server owns its WebSocket gateway, so
 * BOTH events must reach it after the same cold-start initialization promise.
 */
export function createVercelServer(): Server {
  let application: Promise<Server> | undefined;
  const initialized = (): Promise<Server> => {
    application ??= (async () => {
      if (!isVercelRuntime()) throw new Error('This entry point requires VERCEL=1');
      vercelSecrets();
      await buildApp();
      return getHttpServer();
    })();
    // Failed boot stays failed. A partially initialized app is never served.
    return application;
  };
  const server = createServer((request, response) => {
    void initialized().then(
      (app) => {
        app.emit('request', request, response);
      },
      () => {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'Application initialization failed' }));
      },
    );
  });
  server.on('upgrade', (request, socket, head) => {
    socket.pause();
    void initialized().then(
      (app) => {
        if (!app.emit('upgrade', request, socket, head)) socket.destroy();
        else socket.resume();
      },
      () => {
        socket.destroy();
      },
    );
  });
  return server;
}

export default createVercelServer();
