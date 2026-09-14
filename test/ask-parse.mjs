// POST /ask reads req.body, but the mu template only parses
// application/vnd.api+json; the route mounts express.json() for plain
// application/json, like the chat route does. Without an LLM configured a
// well-formed question must answer 503, not the "no question" 400.
//
//   npm test          (or: node --import ./dev-stubs/register.js test/ask-parse.mjs)

import assert from 'node:assert/strict';

delete process.env.LLM_BASE_URL;

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

const { app } = await import('mu');
await import('../app.js');
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

await check('a plain JSON question parses and answers 503 without an LLM', async () => {
  const res = await post('/ask', { question: 'meldingen met MAR-code 7300' });
  assert.equal(res.status, 503);
});

await check('an empty body is still the 400', async () => {
  const res = await post('/ask', {});
  assert.equal(res.status, 400);
});

server.close();
process.exit(failures ? 1 : 0);
