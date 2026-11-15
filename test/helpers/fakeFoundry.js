'use strict';

// Fake Azure AI Foundry /openai/v1/chat/completions endpoint.
// Push scripted replies onto `state.replies` (each: a message object, or a function(reqBody) -> message,
// or { status, error } for an HTTP error). Requests are recorded in `state.requests`.

const http = require('http');

function startFakeFoundry({ apiKey = 'test-key' } = {}) {
  const state = { replies: [], requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/openai/v1/chat/completions') return send(404, { error: { message: 'not found' } });
      if (req.headers['api-key'] !== apiKey) return send(401, { error: { message: 'bad key' } });
      const body = JSON.parse(raw);
      state.requests.push(body);
      let next = state.replies.shift();
      if (typeof next === 'function') next = next(body);
      if (!next) next = { role: 'assistant', content: 'default fake answer' };
      if (next.status) return send(next.status, { error: { message: next.error || 'error' } });
      return send(200, { choices: [{ index: 0, message: { role: 'assistant', ...next } }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, url: `http://127.0.0.1:${server.address().port}`, apiKey, close: () => server.close() });
    });
  });
}

module.exports = { startFakeFoundry };
