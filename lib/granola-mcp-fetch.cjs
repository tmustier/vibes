// Node preload for Granola's incomplete, chunked 202 initialization acknowledgement.
// Read its real HTTP status at the headers, not at the first response-body chunk.
// Authentication, tool requests and every other server keep the original fetch.
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

function headersFirst(url, init) {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    if (!headers.has('content-length')) headers.set('content-length', String(Buffer.byteLength(init.body)));
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method,
      headers: Object.fromEntries(headers),
      signal: init.signal,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      // A notification's 202 acknowledgement has no JSON-RPC reply. Release the
      // socket even when the server never sends the terminating HTTP body chunk.
      const empty = incoming.statusCode === 202 || incoming.statusCode === 204;
      const body = empty ? null : Readable.toWeb(incoming);
      resolve(new Response(body, { status: incoming.statusCode, headers: responseHeaders }));
      if (empty) incoming.destroy();
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

function createGranolaFetch(fetch, notificationFetch = headersFirst) {
  return function(input, init) {
    // mcp-remote passes a URL plus a serialized body. Leave Request inputs and
    // other request representations alone rather than consuming their streams.
    if (init?.method !== 'POST' || typeof init.body !== 'string' || input instanceof Request) {
      return fetch(input, init);
    }
    const url = new URL(input);
    if (url.origin !== 'https://mcp.granola.ai' || url.pathname !== '/mcp') return fetch(input, init);
    let message;
    try { message = JSON.parse(init.body); } catch { return fetch(input, init); }
    if (message?.jsonrpc !== '2.0' || message.method !== 'notifications/initialized' || 'id' in message) {
      return fetch(input, init);
    }
    return notificationFetch(url, init);
  };
}

module.exports = { headersFirst, createGranolaFetch };
globalThis.fetch = createGranolaFetch(globalThis.fetch);
