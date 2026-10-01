import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibsqlConnection } from '../../../src/db/adapter';
import { RemoteLibsqlConnection } from '../../../src/db/remote-connection';
import { verifyRemoteDatabaseCompatibility } from '../../../src/db/remote-compatibility';

let directory: string;
let path: string;
let db: RemoteLibsqlConnection;
let connections: LibsqlConnection[];
let factory: ReturnType<typeof vi.fn<() => LibsqlConnection>>;
const lostStream = new Error('Hrana(Api("status=404 Not Found, body={error:stream not found:test}"))');

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'trek-remote-lifecycle-'));
  path = join(directory, 'test.db');
  const setup = new LibsqlConnection(path);
  setup.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE auth_ephemeral_state(namespace TEXT, key_hash TEXT, value TEXT, expires_at INTEGER, PRIMARY KEY(namespace,key_hash))');
  setup.close();
  connections = [];
  factory = vi.fn(() => {
    const connection = new LibsqlConnection(path);
    connection.exec('PRAGMA foreign_keys = ON');
    vi.spyOn(connection, 'close');
    connections.push(connection);
    return connection;
  });
  db = new RemoteLibsqlConnection('libsql://test.invalid', undefined, factory);
});
afterEach(() => {
  db.close();
  for (const connection of connections) if (connection.open) connection.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('remote connection lifetime', () => {
  it('opens only at execution and never retains a native stream or statement across idle periods', () => {
    const statement = db.prepare('SELECT ? AS value');
    expect(factory).not.toHaveBeenCalled();
    expect(statement.get('first')).toEqual({ value: 'first' });
    expect(connections[0].close).toHaveBeenCalledOnce();
    // Any attempt to reuse the pre-idle stream reproduces the production error.
    vi.spyOn(connections[0], 'prepare').mockImplementation(() => { throw lostStream; });
    expect(statement.get('after idle')).toEqual({ value: 'after idle' });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(connections[1].close).toHaveBeenCalledOnce();
    expect(db.open).toBe(true);
    expect(db.inTransaction).toBe(false);
  });

  it('pins one connection for the whole transaction, including existing SQL handles and nested savepoints', () => {
    const insert = db.prepare('INSERT INTO sample(id, value) VALUES (?, ?)');
    const value = db.transaction((id: number) => {
      expect(db.inTransaction).toBe(true);
      insert.run(id, 'outer');
      expect(() => db.transaction(() => { insert.run(2, 'discard'); throw new Error('inner abort'); })()).toThrow('inner abort');
      db.transaction(() => insert.run(3, 'inner commit')).immediate();
      expect(connections[0].close).not.toHaveBeenCalled();
      return db.prepare('SELECT id FROM sample ORDER BY id').all();
    }).exclusive(1);
    expect(value).toEqual([{ id: 1 }, { id: 3 }]);
    expect(factory).toHaveBeenCalledOnce();
    expect(connections[0].close).toHaveBeenCalledOnce();
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT id FROM sample ORDER BY id').all()).toEqual(value);
  });

  it('rolls back the entire transaction without reopening after a callback error', () => {
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO sample VALUES (1, ?)').run('discard');
      db.transaction(() => db.prepare('INSERT INTO sample VALUES (2, ?)').run('also discard'))();
      throw lostStream;
    })()).toThrow(lostStream);
    expect(factory).toHaveBeenCalledOnce();
    expect(connections[0].close).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT * FROM sample').all()).toEqual([]);
  });

  it('does not retry preparation failure, but the next independent operation uses a fresh stream', () => {
    const connect = factory.getMockImplementation()!;
    factory.mockImplementationOnce(() => {
      const connection = connect();
      vi.spyOn(connection, 'prepare').mockImplementation(() => { throw lostStream; });
      return connection;
    });
    expect(() => db.prepare('SELECT 1 AS value').get()).toThrow(lostStream);
    expect(factory).toHaveBeenCalledOnce();
    expect(connections[0].close).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
  });

  it.each(['run', 'get', 'all'] as const)('never retries an ambiguous %s result, including mutating RETURNING queries', (method) => {
    const connect = factory.getMockImplementation()!;
    factory.mockImplementationOnce(() => {
      const connection = connect();
      const prepare = connection.prepare.bind(connection);
      vi.spyOn(connection, 'prepare').mockImplementation(sql => {
        const statement = prepare(sql);
        const execute = statement[method].bind(statement);
        return { ...statement, [method]: (...params: unknown[]) => { execute(...params); throw lostStream; } };
      });
      return connection;
    });
    const sql = method === 'run' ? 'INSERT INTO sample(value) VALUES (?)' : 'INSERT INTO sample(value) VALUES (?) RETURNING id';
    expect(() => db.prepare(sql)[method]('once')).toThrow(lostStream);
    expect(factory).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT count(*) AS count FROM sample').get()).toEqual({ count: 1 });
  });

  it.each(['exec', 'commit'])('never replays after an ambiguous %s acknowledgement', (failure) => {
    const connect = factory.getMockImplementation()!;
    factory.mockImplementationOnce(() => {
      const connection = connect();
      const exec = connection.exec.bind(connection);
      vi.spyOn(connection, 'exec').mockImplementation(sql => {
        exec(sql);
        if (failure === 'exec' || sql === 'COMMIT') throw lostStream;
      });
      return connection;
    });
    const insert = () => db.exec("INSERT INTO sample(value) VALUES ('once')");
    expect(() => failure === 'exec' ? insert() : db.transaction(insert)()).toThrow(lostStream);
    expect(factory).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT count(*) AS count FROM sample').get()).toEqual({ count: 1 });
  });

  it('propagates BEGIN failure without running the callback or reconnecting', () => {
    const connect = factory.getMockImplementation()!;
    factory.mockImplementationOnce(() => {
      const connection = connect();
      vi.spyOn(connection, 'exec').mockImplementation(() => { throw lostStream; });
      return connection;
    });
    const callback = vi.fn();
    expect(() => db.transaction(callback).immediate()).toThrow(lostStream);
    expect(callback).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
    expect(connections[0].close).toHaveBeenCalledOnce();
  });

  it('keeps atomic token consumption and the release compatibility probe intact', () => {
    verifyRemoteDatabaseCompatibility(db);
    db.prepare('INSERT INTO sample(id, value) VALUES (?, ?)').run(1, 'token');
    const consume = db.prepare('DELETE FROM sample WHERE id = ? RETURNING value');
    expect(consume.get(1)).toEqual({ value: 'token' });
    expect(consume.get(1)).toBeUndefined();
    expect(db.prepare('SELECT * FROM auth_ephemeral_state').all()).toEqual([]);
  });

  it('rejects async transactions and prevents handles from reopening a closed facade', () => {
    expect(() => db.transaction(() => Promise.resolve())()).toThrow('must be synchronous');
    const statement = db.prepare('SELECT 1');
    db.close();
    expect(db.open).toBe(false);
    expect(() => statement.get()).toThrow('closed');
    expect(() => db.exec('SELECT 1')).toThrow('closed');
    expect(() => db.transaction(() => 1)()).toThrow('closed');
  });
});
