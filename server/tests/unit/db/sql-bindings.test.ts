import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibsqlConnection } from '../../../src/db/adapter';

let db: LibsqlConnection;
beforeEach(() => { db = new LibsqlConnection(':memory:'); });
afterEach(() => { db.close(); });

describe('SQLite named binding compatibility', () => {
  it('binds repeated names, all standard prefixes, Unicode, null and binary values', () => {
    expect(db.prepare('SELECT :id AS a, @id AS b, $id AS c, :id AS repeated, :名称 AS label, :empty AS empty, :bytes AS bytes')
      .get({ id: 7, 名称: '旅', empty: null, bytes: Buffer.from('bound') }))
      .toEqual({ a: 7, b: 7, c: 7, repeated: 7, label: '旅', empty: null, bytes: Buffer.from('bound') });
  });

  it('preserves positional slot numbering for named and numbered placeholders', () => {
    expect(db.prepare('SELECT ?2 AS second, :named AS third, ?1 AS first, :named AS repeated')
      .get('one', 'two', 'three')).toEqual({ first: 'one', second: 'two', third: 'three', repeated: 'three' });
    expect(db.prepare('SELECT :same AS first, :same AS repeated, ? AS second').get([1, 2]))
      .toEqual({ first: 1, repeated: 1, second: 2 });
  });

  it('leaves quoted text, escaped quotes, quoted identifiers and comments unchanged', () => {
    const sql = `SELECT ':ignored ? @also $ignored' AS "quoted:identifier", 'it''s :literal' AS [literal@name],
      :value AS \`bound$name\` /* :ignored ?44 */, :value AS repeated -- :ignored ?99
    `;
    expect(db.prepare(sql).get({ value: 42 })).toEqual({
      'quoted:identifier': ':ignored ? @also $ignored', 'literal@name': "it's :literal", 'bound$name': 42, repeated: 42,
    });
  });

  it('does not mistake dollar signs inside bare identifiers for parameters', () => {
    db.exec('CREATE TABLE cash$ledger(value$usd INTEGER)');
    db.prepare('INSERT INTO cash$ledger(value$usd) VALUES (:value)').run({ value: 5 });
    expect(db.prepare('SELECT value$usd FROM cash$ledger WHERE value$usd = :value').get({ value: 5 }))
      .toEqual({ value$usd: 5 });
  });

  it('returns the actual inserted row ID and reads it back with a named query', () => {
    db.exec('CREATE TABLE trips(id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT); INSERT INTO trips VALUES (41, 1, \'previous\')');
    const created = db.prepare('INSERT INTO trips(user_id,title) VALUES (:userId,:title)').run({ userId: 7, title: '神户之旅' });
    expect(created).toEqual({ changes: 1, lastInsertRowid: 42 });
    expect(db.prepare('SELECT id, title FROM trips WHERE user_id = :userId AND id = :tripId').get({ userId: 7, tripId: created.lastInsertRowid }))
      .toEqual({ id: 42, title: '神户之旅' });
    expect(db.prepare('SELECT id FROM trips WHERE user_id = :userId').all({ userId: 7 })).toEqual([{ id: 42 }]);
    expect(db.prepare('SELECT id FROM trips WHERE user_id = :userId').all({ userId: 8 })).toEqual([]);
  });

  it('rejects missing or mixed named parameters before a write can execute', () => {
    db.exec('CREATE TABLE sample(value INTEGER)');
    expect(() => db.prepare('INSERT INTO sample VALUES (:required)').run({ other: 1 })).toThrow('Missing named SQLite parameter');
    expect(() => db.prepare('INSERT INTO sample VALUES (?)').run({ value: 1 })).toThrow('anonymous SQLite parameters');
    expect(db.prepare('SELECT count(*) AS count FROM sample').get()).toEqual({ count: 0 });
  });

  it('rejects unsupported Tcl-style parameters and invalid numbered indexes explicitly', () => {
    expect(() => db.prepare('SELECT $value::suffix(annotation)')).toThrow('Unsupported SQLite named parameter form');
    expect(() => db.prepare('SELECT ?0')).toThrow('Invalid SQLite parameter index');
  });
});
