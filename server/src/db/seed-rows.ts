import type { DbConnection } from './adapter';

/** Batch fixed release seed rows to stay within remote transaction time limits. */
export function insertSeedRows(db: DbConnection, insertSql: string, rows: unknown[][]): void {
  if (rows.length === 0) return;
  const width = rows[0].length;
  if (width === 0 || rows.some(row => row.length !== width)) throw new Error('Invalid seed row width');
  const placeholders = `(${Array.from({ length: width }, () => '?').join(', ')})`;
  db.prepare(`${insertSql} VALUES ${rows.map(() => placeholders).join(', ')}`).run(...rows.flat());
}
