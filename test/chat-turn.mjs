// Integration check for the turn endpoint (src/chat/index.js). No stack:
// the mu stub records the queries and updates, and a handler steers the
// answers, so the test asserts on the same SPARQL the template's helpers
// would send.
//
//   npm test          (or: node --import ./dev-stubs/register.js test/chat-turn.mjs)

import assert from 'node:assert/strict';
import express from 'express';
import { resetMu, setQueryHandler, state } from 'mu';

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

// --- the stub answers -----------------------------------------------------------

const KNOWN_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION = 'http://data.lblod.info/id/chat-conversations/9ab4';
const ASSISTANT = 'http://data.lblod.info/id/chat-agents/rapportassistent';

setQueryHandler((sparql) => {
  if (sparql.includes('prov#SoftwareAgent')) {
    return [{ agent: { value: ASSISTANT } }];
  }
  if (sparql.includes('sioc/ns#Thread') && sparql.includes(KNOWN_ID)) {
    return [{ conversation: { value: CONVERSATION }, creator: { value: 'http://data.lblod.info/id/gebruiker/1' } }];
  }
  return [];
});

const { mountChat } = await import('../src/chat/index.js');
const app = express();
mountChat(app, {
  path: '/assistant',
  answer: async (turn) => {
    return `Je schreef: ${turn.content}`;
  },
});
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'mu-session-id': 'http://mu.semte.ch/sessions/x' },
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
  resetMu();
  const res = await post(`/assistant/conversations/${KNOWN_ID}/turns`, { content: 'Hallo?' });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  assert.match(id, /^[0-9a-f-]{36}$/);

  // the answer hook runs after the 202; give it a moment
  await new Promise((r) => setTimeout(r, 200));
  const updates = state.updates.map((u) => u);
  assert.ok(updates.length >= 2, 'the question and the echo are written');
  assert.ok(updates[0].includes('Hallo?'), 'the question first');
  assert.ok(updates.some((u) => u.includes('Je schreef: Hallo?')), 'the echo after');
});

await check('a throwing hook writes the failure line', async () => {
  const app2 = express();
  mountChat(app2, { path: '/assistant', answer: async () => { throw new Error('boom'); } });
  const server2 = app2.listen(0);
  const base2 = `http://localhost:${server2.address().port}`;
  resetMu();
  const res = await fetch(`${base2}/assistant/conversations/${KNOWN_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'mu-session-id': 'http://mu.semte.ch/sessions/x' },
    body: JSON.stringify({ content: 'Breekt dit?' }),
  });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(state.updates.some((u) => u.includes('Er ging iets mis. Probeer het opnieuw.')),
    'the failure message is written');
  server2.close();
});

server.close();
process.exit(failures ? 1 : 0);
