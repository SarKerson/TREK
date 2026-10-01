import type Sqlite from 'better-sqlite3';
import Libsql from 'libsql';

/** The synchronous SQL surface TREK actually uses, shared by local and remote DBs. */
export interface DbStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): Sqlite.RunResult;
}
export interface DbTransaction<A extends unknown[], R> {
  (...args: A): R;
  deferred(...args: A): R;
  immediate(...args: A): R;
  exclusive(...args: A): R;
}
export interface DbConnection {
  readonly name: string;
  readonly open: boolean;
  readonly inTransaction: boolean;
  prepare(sql: string): DbStatement;
  exec(sql: string): unknown;
  close(): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): DbTransaction<A, R>;
}

function cleanRow(row: unknown): unknown {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const { _metadata: _ignored, ...values } = row as Record<string, unknown>;
    return values;
  }
  return row;
}

function bindings(params: unknown[]): unknown[] {
  const first = params[0];
  // libsql treats a sole object as named bindings, including null and Buffer:
  // those two can throw or abort the native driver. Explicitly group positional
  // values in one array and only forward plain named-binding maps as objects.
  if (params.length === 1 && first !== null && typeof first === 'object'
    && !Array.isArray(first) && !ArrayBuffer.isView(first)) return [first];
  return [params.flat()];
}

/** Direct remote connection: never uses a file replica or cached authorization reads. */
export class LibsqlConnection implements DbConnection {
  private readonly driver: Libsql.Database;
  private savepoint = 0;

  constructor(readonly name: string, authToken?: string) {
    // Published types omit authToken although the documented runtime supports it.
    const options: Libsql.Options & { authToken?: string } = { authToken, timeout: 5000 };
    this.driver = new Libsql(name, options);
  }
  get open(): boolean { return this.driver.open; }
  get inTransaction(): boolean { return this.driver.inTransaction; }
  close(): void { this.driver.close(); }
  exec(sql: string): void { this.driver.exec(sql); }
  prepare(sql: string): DbStatement {
    const statement = this.driver.prepare(sql);
    return {
      get: (...params) => cleanRow(statement.get(...bindings(params))),
      all: (...params) => statement.all(...bindings(params)).map(cleanRow),
      run: (...params) => {
        const { changes, lastInsertRowid } = statement.run(...bindings(params));
        return { changes, lastInsertRowid };
      },
    };
  }
  transaction<A extends unknown[], R>(fn: (...args: A) => R): DbTransaction<A, R> {
    const wrap = (mode: string) => (...args: A): R => {
      const nested = this.inTransaction;
      const name = `trek_savepoint_${++this.savepoint}`;
      this.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode}`);
      try {
        const result = fn(...args);
        if (result && typeof result === 'object' && 'then' in result) {
          throw new TypeError('Database transactions must be synchronous');
        }
        this.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        if (this.inTransaction) {
          this.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK');
          if (nested) this.exec(`RELEASE SAVEPOINT ${name}`);
        }
        throw error;
      }
    };
    return Object.assign(wrap('DEFERRED'), {
      deferred: wrap('DEFERRED'), immediate: wrap('IMMEDIATE'), exclusive: wrap('EXCLUSIVE'),
    });
  }
}
