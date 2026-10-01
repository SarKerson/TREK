import { LibsqlConnection } from './adapter';
import type { DbConnection, DbStatement, DbTransaction } from './adapter';

/**
 * Hrana HTTP streams expire while a serverless instance is idle. Keep the
 * application facade, not its native stream, across requests. Standalone SQL
 * executes once on a fresh connection; transactions pin one connection through
 * every nested savepoint and discard it after commit/rollback. Never replay SQL
 * after a transport error: a write or COMMIT may already have reached Turso.
 *
 * Release migrations use LibsqlConnection directly because legacy migrations
 * intentionally preserve connection-local PRAGMAs between operations.
 */
export class RemoteLibsqlConnection implements DbConnection {
  private active: DbConnection | undefined;
  private closed = false;

  constructor(
    readonly name: string,
    authToken?: string,
    private readonly connect: () => DbConnection = () => new LibsqlConnection(name, authToken),
  ) {}

  get open(): boolean { return !this.closed; }
  get inTransaction(): boolean { return this.active?.inTransaction ?? false; }

  close(): void {
    if (this.active) throw new Error('Cannot close the remote database during a synchronous operation');
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Remote database connection is closed');
  }

  private use<T>(operation: (connection: DbConnection) => T): T {
    this.assertOpen();
    if (this.active) return operation(this.active);
    const connection = this.connect();
    this.active = connection;
    try {
      return operation(connection);
    } finally {
      this.active = undefined;
      connection.close();
    }
  }

  exec(sql: string): void { this.use(connection => connection.exec(sql)); }

  prepare(sql: string): DbStatement {
    this.assertOpen();
    // Capture SQL only. A reusable statement must never retain a native stream,
    // and a statement prepared before a transaction must execute inside it.
    return {
      get: (...params) => this.use(connection => connection.prepare(sql).get(...params)),
      all: (...params) => this.use(connection => connection.prepare(sql).all(...params)),
      run: (...params) => this.use(connection => connection.prepare(sql).run(...params)),
    };
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): DbTransaction<A, R> {
    const wrap = (mode: 'deferred' | 'immediate' | 'exclusive') => (...args: A): R =>
      this.use(connection => connection.transaction(() => fn(...args))[mode]());
    return Object.assign(wrap('deferred'), {
      deferred: wrap('deferred'), immediate: wrap('immediate'), exclusive: wrap('exclusive'),
    });
  }
}
