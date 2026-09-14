// The chat store's SPARQL, asserted on the strings the mu stub records and
// parsed with sparqljs, so a syntax slip fails in the test and not against
// the auth layer.
//
//   npm test          (or: node --import ./dev-stubs/register.js test/chat-store.mjs)

import assert from 'node:assert/strict';
import { resetMu, state } from 'mu';
import { writeMessage, setDocumentUrl, dropDocument } from '../src/chat/store.js';
import { Parser } from 'sparqljs';

const CONVERSATION = 'http://data.lblod.info/id/chat-conversations/9ab4';

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

await check('writeMessage: both types, the container, the uuid', async () => {
  resetMu();
  const { id } = await writeMessage({ conversationUri: CONVERSATION, content: 'Hallo?' });
  const q = state.updates[0];
  assert.ok(q.includes('<http://rdfs.org/sioc/ns#Post>'), 'sioc:Post');
  assert.ok(q.includes('<http://rdfs.org/sioc/types#InstantMessage>'), 'sioct:InstantMessage');
  assert.ok(q.includes(`<${CONVERSATION}>`), 'the container');
  assert.ok(q.includes(id), 'the uuid');
  assert.ok(q.includes('Hallo?'), 'the content');
});

await check('writeMessage: the title on the first question', async () => {
  resetMu();
  await writeMessage({ conversationUri: CONVERSATION, content: 'Eerste vraag', title: 'Eerste vraag' });
  const withTitle = state.updates[0];
  assert.ok(withTitle.includes('<http://purl.org/dc/terms/title>'), 'the title triple');

  resetMu();
  await writeMessage({ conversationUri: CONVERSATION, content: 'Tweede vraag' });
  const withoutTitle = state.updates[0];
  assert.ok(!withoutTitle.includes('<http://purl.org/dc/terms/title>'), 'no title triple');
});

await check('writeMessage: an attachment without url is pending, with url is ready', async () => {
  resetMu();
  const { documents } = await writeMessage({
    conversationUri: CONVERSATION, content: 'Rapport',
    attachments: [{ name: 'rapport.csv', mediaType: 'text/csv' }],
  });
  const pending = state.updates[0];
  assert.ok(pending.includes(documents[0].uri), 'the document is named');
  assert.ok(pending.includes('<https://www.w3.org/ns/activitystreams#Document>'), 'as:Document');
  assert.ok(!pending.includes('<https://www.w3.org/ns/activitystreams#url>'), 'no url yet');

  resetMu();
  await writeMessage({
    conversationUri: CONVERSATION, content: 'Rapport',
    attachments: [{ name: 'rapport.csv', mediaType: 'text/csv', url: '/files/1/download' }],
  });
  const ready = state.updates[0];
  assert.ok(ready.includes('/files/1/download'), 'the url is written');
});

await check('setDocumentUrl and dropDocument name the document', async () => {
  resetMu();
  await setDocumentUrl(
    'http://data.lblod.info/id/chat-documents/1', '/files/1/download', CONVERSATION);
  assert.ok(state.updates[0].includes('http://data.lblod.info/id/chat-documents/1'));

  resetMu();
  await dropDocument('http://data.lblod.info/id/chat-documents/1');
  assert.ok(state.updates[0].includes('http://data.lblod.info/id/chat-documents/1'));
});

await check('every recorded string parses as a SPARQL update', async () => {
  resetMu();
  await writeMessage({ conversationUri: CONVERSATION, content: 'Parsen', title: 'Parsen' });
  await writeMessage({
    conversationUri: CONVERSATION, content: 'Parsen',
    attachments: [{ name: 'a.csv', mediaType: 'text/csv', url: '/files/a/download' }],
  });
  await setDocumentUrl('http://data.lblod.info/id/chat-documents/a', '/files/a/download', CONVERSATION);
  await dropDocument('http://data.lblod.info/id/chat-documents/a');
  const parser = new Parser();
  for (const q of state.updates) {
    assert.ok(parser.parse(q), 'parses');
  }
});

process.exit(failures ? 1 : 0);
