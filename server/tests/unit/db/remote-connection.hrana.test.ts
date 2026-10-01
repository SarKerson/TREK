import { once } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibsqlConnection } from '../../../src/db/adapter';
import type { DbConnection } from '../../../src/db/adapter';
import { RemoteLibsqlConnection } from '../../../src/db/remote-connection';

interface FixtureRequest {
  path: string;
  baton: string | null;
  stream: string;
  types: string[];
  sql: string[];
  status: number;
}

const sql = 'SELECT 42 AS answer';
let worker: Worker;
let url: string;
const connections: DbConnection[] = [];

async function control(type: 'expire' | 'inspect') {
  const response = once(worker, 'message');
  worker.postMessage({ type });
  return (await response)[0] as { type: string; requests: FixtureRequest[] };
}

beforeEach(async () => {
  worker = new Worker(path.resolve('tests/fixtures/hrana-expiring-server.cjs'));
  const [ready] = await once(worker, 'message');
  url = ready.url;
});
afterEach(async () => {
  try {
    connections.splice(0).forEach(connection => connection.close());
  } finally {
    await worker?.terminate();
  }
});

describe('native Hrana stream lifetime', () => {
  it('reproduces a persistent native connection failing at prepare after stream expiry', async () => {
    const connection = new LibsqlConnection(url);
    connections.push(connection);
    expect(connection.prepare(sql).get()).toEqual({ answer: 42 });

    expect((await control('expire')).type).toBe('expired');
    expect(() => connection.prepare(sql)).toThrow('status=404 Not Found, body=stream not found');

    const { requests } = await control('inspect');
    const describes = requests.filter(request => request.types.includes('describe'));
    expect(describes).toHaveLength(2);
    expect(describes[0]).toMatchObject({ baton: null, stream: 'stream-1', status: 200 });
    expect(describes[1]).toMatchObject({ baton: 'stream-1', status: 404 });
  });

  it('reuses a facade statement across expiry by opening a fresh native stream for each read', async () => {
    const connection = new RemoteLibsqlConnection(url);
    connections.push(connection);
    const statement = connection.prepare(sql);
    expect(statement.get()).toEqual({ answer: 42 });

    expect((await control('expire')).type).toBe('expired');
    expect(statement.get()).toEqual({ answer: 42 });

    const { requests } = await control('inspect');
    const describes = requests.filter(request => request.types.includes('describe'));
    expect(describes).toHaveLength(2);
    expect(describes.map(request => request.baton)).toEqual([null, null]);
    expect(describes.map(request => request.stream)).toEqual(['stream-1', 'stream-2']);
    expect(describes.map(request => request.status)).toEqual([200, 200]);
    const reads = requests.filter(request => request.path === '/v3/cursor');
    expect(reads.map(request => request.baton)).toEqual(['stream-1', 'stream-2']);
  });

  it('pins one native stream for repeated reads within a synchronous transaction', async () => {
    const connection = new RemoteLibsqlConnection(url);
    connections.push(connection);
    const statement = connection.prepare(sql);
    connection.transaction(() => {
      expect(statement.get()).toEqual({ answer: 42 });
      expect(statement.get()).toEqual({ answer: 42 });
    })();

    const { requests } = await control('inspect');
    const operations = requests.filter(request => request.types.some(type => type !== 'close'));
    expect(new Set(operations.map(request => request.stream))).toEqual(new Set(['stream-1']));
    expect(operations.filter(request => request.path === '/v3/cursor')).toHaveLength(2);
    expect(operations.filter(request => request.types.includes('batch')).flatMap(request => request.sql).map(sql => sql.replace(/;$/, '')))
      .toEqual(['BEGIN DEFERRED', 'COMMIT']);
  });
});
