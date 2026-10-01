'use strict';

// Native libsql blocks its calling thread during HTTP requests, so this local
// Hrana v3 fixture runs in a worker. Real in-memory SQLite executes the SQL;
// the fixture models stream expiry and the serialized flows used by these tests.
// Protocol: https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md
const http = require('node:http');
const { parentPort } = require('node:worker_threads');
const Libsql = require('libsql');

const database = new Libsql(':memory:');
database.exec(`
  CREATE TABLE trips (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, is_archived INTEGER NOT NULL DEFAULT 0);
  INSERT INTO trips (id, user_id, title) VALUES (41, 99, 'Existing fixture trip');
`);
const streams = new Set();
const requests = [];
let nextStream = 0;

function decode(value) {
  if (value.type === 'null') return null;
  if (value.type === 'integer') return BigInt(value.value);
  if (value.type === 'blob') return Buffer.from(value.base64, 'base64');
  return value.value;
}
function encode(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
  if (typeof value === 'number') return { type: 'float', value };
  if (typeof value === 'string') return { type: 'text', value };
  return { type: 'blob', base64: Buffer.from(value).toString('base64') };
}
function bindings(statement) {
  if (statement.named_args.length) {
    return Object.fromEntries(statement.named_args.map(arg => [arg.name.replace(/^[:@$]/, ''), decode(arg.value)]));
  }
  return statement.args.map(decode);
}
function columns(statement) {
  return statement.columns().map(column => ({ name: column.name, decltype: column.type }));
}
function execute(statement) {
  const prepared = database.prepare(statement.sql).safeIntegers(true);
  const cols = columns(prepared);
  if (prepared.reader) {
    const rows = prepared.raw().all(bindings(statement)).map(row => row.map(encode));
    return { cols, rows, affected_row_count: 0, last_insert_rowid: null };
  }
  const info = prepared.run(bindings(statement));
  return { cols, rows: [], affected_row_count: info.changes, last_insert_rowid: String(info.lastInsertRowid) };
}

const server = http.createServer((request, response) => {
  const parts = [];
  request.on('data', part => parts.push(part));
  request.on('end', () => {
    let entry;
    try {
      const body = JSON.parse(Buffer.concat(parts).toString());
      const statements = body.requests?.flatMap(item => item.batch?.steps.map(step => step.stmt) || [])
        || body.batch?.steps.map(step => step.stmt);
      entry = {
        path: request.url,
        baton: body.baton,
        stream: body.baton || `stream-${++nextStream}`,
        types: body.requests?.map(item => item.type) || ['cursor'],
        sql: body.requests?.flatMap(item => item.sql ? [item.sql] : item.batch?.steps.map(step => step.stmt.sql) || [])
          || body.batch?.steps.map(step => step.stmt.sql),
        statements,
        status: 200,
      };
      requests.push(entry);
      if (body.baton && !streams.has(body.baton)) {
        entry.status = 404;
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('stream not found');
        return;
      }
      const baton = entry.stream;
      streams.add(baton);

      if (request.url === '/v3/cursor') {
        const lines = [{ baton, base_url: null }];
        body.batch.steps.forEach((step, index) => {
          const result = execute(step.stmt);
          lines.push({ type: 'step_begin', step: index, cols: result.cols });
          lines.push(...result.rows.map(row => ({ type: 'row', row })));
          lines.push({ type: 'step_end', affected_row_count: result.affected_row_count, last_insert_rowid: result.last_insert_rowid });
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(lines.map(JSON.stringify).join('\n') + '\n');
        return;
      }
      if (request.url !== '/v3/pipeline') throw new Error('Unsupported fixture endpoint');
      const results = body.requests.map(item => {
        let result;
        switch (item.type) {
          case 'describe': {
            const prepared = database.prepare(item.sql);
            // The binding regression must persist even with complete server
            // parameter metadata. Test statements use simple named/? slots.
            const names = item.sql.match(/[:@$][A-Za-z_][A-Za-z_0-9]*|\?/g) || [];
            const params = names.filter((name, index) => name === '?' || names.indexOf(name) === index)
              .map(name => ({ name: name === '?' ? null : name }));
            entry.params = params;
            result = { type: 'describe', result: { params, cols: columns(prepared), is_explain: false, is_readonly: prepared.reader } };
            break;
          }
          case 'sequence':
            database.exec(item.sql);
            result = { type: 'sequence' };
            break;
          case 'batch': {
            const stepResults = item.batch.steps.map(step => execute(step.stmt));
            result = { type: 'batch', result: { step_results: stepResults, step_errors: stepResults.map(() => null) } };
            break;
          }
          case 'get_autocommit':
            result = { type: 'get_autocommit', is_autocommit: !database.inTransaction };
            break;
          case 'close':
            streams.delete(baton);
            result = { type: 'close' };
            break;
          default:
            throw new Error(`Unsupported fixture request: ${item.type}`);
        }
        return { type: 'ok', response: result };
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ baton: streams.has(baton) ? baton : null, base_url: null, results }));
    } catch (error) {
      if (entry) entry.status = 500;
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error.message);
    }
  });
});

parentPort.on('message', message => {
  if (message.type === 'expire') {
    // Acknowledged explicit expiry avoids sleeps and wall-clock assumptions.
    if (database.inTransaction) database.exec('ROLLBACK');
    streams.clear();
    parentPort.postMessage({ type: 'expired' });
  } else if (message.type === 'inspect') {
    parentPort.postMessage({ type: 'requests', requests });
  }
});
server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ type: 'ready', url: `http://127.0.0.1:${server.address().port}` });
});
