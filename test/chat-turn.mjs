// Integration check for the turn endpoint (src/chat/index.js). No stack: the
// SPARQL endpoint is a stub in this process that answers like the auth layer
// (JSON bindings plus the mu-auth-allowed-groups response header), and the
// module is mounted on a real express app.
//
//   npm test          (or: node --import ./dev-stubs/register.js test/chat-turn.mjs)

import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const PORT = 8899;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}\n    ${e.message}`);
  }
}

// --- the stub auth layer ------------------------------------------------------

const KNOWN_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION = 'http://data.lblod.info/id/chat-conversations/9ab4';
const ASSISTANT = 'http://data.lblod.info/id/chat-agents/rapportassistent';
const GROUPS = '[{"variables":["account"],"name":"chat-owner"}]';

const requests = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/sparql-results+json');
    res.setHeader('mu-auth-allowed-groups', GROUPS);
    if (req.url === '/sparql' && /SELECT/.test(body)) {
      if (/prov%23SoftwareAgent|prov#SoftwareAgent/.test(body)) {
        res.end(JSON.stringify({ results: { bindings: [
          { agent: { value: ASSISTANT } },
        ] } }));
      } else if (body.includes(KNOWN_ID)) {
        res.end(JSON.stringify({ results: { bindings: [
          { conversation: { value: CONVERSATION }, creator: { value: 'http://data.lblod.info/id/gebruiker/1' } },
        ] } }));
      } else {
        res.end(JSON.stringify({ results: { bindings: [] } }));
      }
    } else {
      res.end('null');
    }
  });
});

await new Promise((r) => stub.listen(PORT, r));
process.env.MU_SPARQL_ENDPOINT = `http://localhost:${PORT}/sparql`;

const { mountChat } = await import('../src/chat/index.js');
const app = express();
const writes = [];
mountChat(app, {
  path: '/assistant',
  answer: async (turn) => {
    writes.push(turn.content);
    return `Je schreef: ${turn.content}`;
  },
});
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'mu-session-id': 'http://mu.semte.ch/sessions/x', ...headers },
  body: JSON.stringify(body),
});

await check('blank content is 400', async () => {
  const res = await post('/assistant/conversations/00000000-0000-0000-0000-000000000000/turns', { content: '  ' });
  assert.equal(res.status, 400);
});

await check('an unreadable conversation is 404', async () => {
  const res = await post('/assistant/conversations/00000000-0000-0000-0000-000000000000/turns', { content: 'Hallo?' });
  assert.equal(res.status, 404);
});

await check('a turn answers 202 with the message id, then writes the echo', async () => {
  requests.length = 0;
  const res = await post(`/assistant/conversations/${KNOWN_ID}/turns`, { content: 'Hallo?' });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  assert.match(id, /^[0-9a-f-]{36}$/);

  // the answer hook runs after the 202; give it a moment
  await new Promise((r) => setTimeout(r, 200));
  const updates = requests.filter((r) => r.method === 'POST' && /DELETE|INSERT/.test(r.body)).map((r) => r.body);
  assert.ok(updates.length >= 2, 'the question and the echo are written');
  assert.ok(updates[0].includes('Hallo?'), 'the question first');
  assert.ok(updates.some((u) => u.includes('Je schreef: Hallo?')), 'the echo after');
  // the identity carries past the 202
  assert.ok(requests.slice(1).every((r) => r.headers['mu-auth-allowed-groups'] === GROUPS),
    'every write carries the captured groups');
  const sessionRead = requests[0];
  assert.equal(sessionRead.headers['mu-session-id'], 'http://mu.semte.ch/sessions/x');
});

await check('a throwing hook writes the failure line', async () => {
  const app2 = express();
  mountChat(app2, { path: '/assistant', answer: async () => { throw new Error('boom'); } });
  const server2 = app2.listen(0);
  const base2 = `http://localhost:${server2.address().port}`;
  const requests2 = [];
  // route the stub's answers through a fresh recorder by watching requests on the shared stub
  const before = requests.length;
  const res = await fetch(`${base2}/assistant/conversations/${KNOWN_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'mu-session-id': 'http://mu.semte.ch/sessions/x' },
    body: JSON.stringify({ content: 'Breekt dit?' }),
  });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 200));
  const after = requests.slice(before).filter((r) => /DELETE|INSERT/.test(r.body)).map((r) => r.body);
  assert.ok(after.some((u) => u.includes('Er ging iets mis. Probeer het opnieuw.')),
    'the failure message is written');
  server2.close();
});

server.close();
stub.close();
process.exit(failures ? 1 : 0);
