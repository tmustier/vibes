import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

const originalFetch = globalThis.fetch;
const { headersFirst, createGranolaFetch } = createRequire(import.meta.url)('../lib/granola-mcp-fetch.cjs');
globalThis.fetch = originalFetch;
const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(new URL(`http://127.0.0.1:${server.address().port}/mcp`)); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('accepts a real 202 at the headers and closes an unfinished chunked body', async () => {
  let closed;
  await withServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer test-token');
    assert.equal(request.headers['content-length'], String(Buffer.byteLength(notification)));
    closed = once(response, 'close');
    response.writeHead(202, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    response.flushHeaders(); // Reproduces Granola's headers with no body chunk or EOF.
  }, async url => {
    const response = await headersFirst(url, {
      method: 'POST', body: notification, headers: { authorization: 'Bearer test-token' },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 202);
    assert.equal(response.body, null);
    await closed;
  });
});

test('preserves rejected HTTP statuses, OAuth challenges and response bodies', async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Bearer scope="mcp"', 'content-type': 'application/json' });
    response.end('{"error":"unauthorized"}');
  }, async url => {
    const response = await headersFirst(url, { method: 'POST', body: notification });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer scope="mcp"');
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  });
});

test('cancellation rejects the request and closes its socket', async () => {
  let closed;
  const controller = new AbortController();
  await withServer((request, _response) => {
    request.once('error', error => assert.equal(error.code, 'ECONNRESET'));
    closed = new Promise(resolve => request.once('close', resolve));
    controller.abort();
  }, async url => {
    await assert.rejects(headersFirst(url, { method: 'POST', body: notification, signal: controller.signal }), { name: 'AbortError' });
    await closed;
  });
});

test('routes only Granola initialization notifications without altering input', async () => {
  const fallback = [];
  const special = [];
  const fetch = createGranolaFetch((...args) => { fallback.push(args); return 'original'; }, (...args) => { special.push(args); return 'headers-first'; });
  const init = { method: 'POST', body: notification, headers: { authorization: 'Bearer test-token' } };
  const saved = structuredClone(init);
  assert.equal(fetch('https://mcp.granola.ai/mcp', init), 'headers-first');
  assert.deepEqual(init, saved);
  assert.equal(special[0][1], init);
  for (const [input, options] of [
    ['https://mcp.notion.com/mcp', init],
    ['https://mcp.granola.ai/token', init],
    ['https://mcp.granola.ai:444/mcp', init],
    ['https://mcp.granola.ai/mcp', { ...init, method: 'GET' }],
    ['https://mcp.granola.ai/mcp', { ...init, body: 'not JSON' }],
    ['https://mcp.granola.ai/mcp', { ...init, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) }],
    ['https://mcp.granola.ai/mcp', { ...init, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }) }],
    ['https://mcp.granola.ai/mcp', { ...init, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'notifications/initialized' }) }],
    [new Request('https://mcp.granola.ai/mcp'), init],
  ]) {
    assert.equal(fetch(input, options), 'original');
    assert.equal(fallback.at(-1)[0], input);
    assert.equal(fallback.at(-1)[1], options);
  }
  assert.equal(special.length, 1);
});
