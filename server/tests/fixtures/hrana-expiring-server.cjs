'use strict';

// Native libsql blocks the calling thread during HTTP requests, so this small
// Hrana v3 server runs in a worker. It deliberately supports only the constant
// SELECT and transaction controls needed by the connection lifetime tests.
// Protocol: https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md
const http = require('node:http');
const { parentPort } = require('node:worker_threads');

const streams = new Map();
const requests = [];
const cols = [{ name: 'answer', decltype: 'INTEGER' }];
let nextStream = 0;

function runControl(sql, stream) {
  if (/^BEGIN\b/i.test(sql)) stream.inTransaction = true;
  else if (/^(COMMIT|ROLLBACK)\s*;?$/i.test(sql)) stream.inTransaction = false;
  else throw new Error(`Unsupported fixture SQL: ${sql}`);
}

const server = http.createServer((request, response) => {
  const parts = [];
  request.on('data', part => parts.push(part));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(parts).toString());
      const entry = {
        path: request.url,
        baton: body.baton,
        stream: body.baton || `stream-${++nextStream}`,
        types: body.requests?.map(item => item.type) || ['cursor'],
        sql: body.requests?.flatMap(item => item.sql ? [item.sql] : item.batch?.steps.map(step => step.stmt.sql) || [])
          || body.batch?.steps.map(step => step.stmt.sql),
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
      if (!streams.has(baton)) streams.set(baton, { inTransaction: false });
      const stream = streams.get(baton);

      if (request.url === '/v3/cursor') {
        if (body.batch.steps.length !== 1 || !/^SELECT 42 AS answer;?$/i.test(body.batch.steps[0].stmt.sql)) {
          throw new Error('Unsupported fixture cursor batch');
        }
        const lines = [
          { baton, base_url: null },
          { type: 'step_begin', step: 0, cols },
          { type: 'row', row: [{ type: 'integer', value: '42' }] },
          { type: 'step_end', affected_row_count: 0, last_insert_rowid: null },
        ];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(lines.map(JSON.stringify).join('\n') + '\n');
        return;
      }
      if (request.url !== '/v3/pipeline') throw new Error('Unsupported fixture endpoint');
      const results = body.requests.map(item => {
        let result;
        switch (item.type) {
          case 'describe':
            if (!/^SELECT 42 AS answer;?$/i.test(item.sql)) throw new Error('Unsupported fixture describe');
            result = { type: 'describe', result: { params: [], cols, is_explain: false, is_readonly: true } };
            break;
          case 'sequence':
            runControl(item.sql, stream);
            result = { type: 'sequence' };
            break;
          case 'batch': {
            const stepResults = item.batch.steps.map(step => {
              runControl(step.stmt.sql, stream);
              return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null };
            });
            result = { type: 'batch', result: { step_results: stepResults, step_errors: stepResults.map(() => null) } };
            break;
          }
          case 'get_autocommit':
            result = { type: 'get_autocommit', is_autocommit: !stream.inTransaction };
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
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error.message);
    }
  });
});

parentPort.on('message', message => {
  if (message.type === 'expire') {
    // Acknowledged explicit expiry avoids sleeps and wall-clock assumptions.
    streams.clear();
    parentPort.postMessage({ type: 'expired' });
  } else if (message.type === 'inspect') {
    parentPort.postMessage({ type: 'requests', requests });
  }
});
server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ type: 'ready', url: `http://127.0.0.1:${server.address().port}` });
});
