// Unit check for src/chat/store.js. No stack, no network: writeMessage,
// setDocumentUrl and dropDocument are handed a recording updateFn and the
// SPARQL they produce is asserted on and parsed (sparqljs), so a syntax slip
// fails here and not against the auth layer.
//
//   npm test          (or: node --import ./dev-stubs/register.js test/chat-store.mjs)

import assert from 'node:assert/strict';
import { writeMessage, setDocumentUrl, dropDocument } from '../src/chat/store.js';

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

const CONVERSATION = 'http://data.lblod.info/id/chat-conversations/9ab4';
const ASSISTANT = 'http://data.lblod.info/id/chat-agents/rapportassistent';
const DOCUMENT = 'http://data.lblod.info/id/chat-documents/7d02';

// A recording update fn. `Parser` (sparqljs) is asserted later: every string
// the store builds must be a valid SPARQL update.
const { Parser } = await import('sparqljs');
const parse = (sparql) => new Parser().parse(sparql);

function recorder() {
  const calls = [];
  return {
    calls,
    async updateFn(sparql) { calls.push(sparql); },
  };
}

await check('writeMessage: both types, the container, the uuid', async () => {
  const { calls, updateFn } = recorder();
  const { uri, id, documents } = await writeMessage(updateFn, {
    conversationUri: CONVERSATION, content: 'Hallo?', maker: ASSISTANT,
  });
  const q = calls[0];
  assert.ok(q.includes('<http://rdfs.org/sioc/ns#Post>'), 'has sioc:Post');
  assert.ok(q.includes('<http://rdfs.org/sioc/types#InstantMessage>'), 'has sioct:InstantMessage');
  assert.ok(q.includes('<http://rdfs.org/sioc/ns#has_container>'), 'has sioc:has_container');
  assert.ok(q.includes(`<${CONVERSATION}>`), 'names the conversation');
  assert.ok(q.includes(id), 'carries the message uuid');
  assert.ok(q.trim().startsWith('DELETE'), 'touches the conversation');
  assert.ok(!q.includes('http://purl.org/dc/terms/title'), 'no title when none given');
  assert.ok(!q.includes('activitystreams'), 'no attachments when none given');
  assert.equal(documents.length, 0);
  assert.ok(uri.endsWith(id));
});

await check('writeMessage: the title on the first question', async () => {
  const { calls, updateFn } = recorder();
  await writeMessage(updateFn, {
    conversationUri: CONVERSATION, content: 'Hoeveel meldingen?',
    maker: ASSISTANT, title: 'Hoeveel meldingen?',
  });
  assert.ok(calls[0].includes('http://purl.org/dc/terms/title'), 'writes dct:title');
});

await check('writeMessage: an attachment without url is pending, with url is ready', async () => {
  const { calls, updateFn } = recorder();
  const { documents } = await writeMessage(updateFn, {
    conversationUri: CONVERSATION, content: 'Ik maak het rapport.',
    maker: ASSISTANT, attachments: [{ name: 'meldingen.csv', mediaType: 'text/csv' }],
  });
  const pending = calls[0];
  assert.ok(pending.includes('https://www.w3.org/ns/activitystreams#name'), 'names the file');
  assert.ok(pending.includes('https://www.w3.org/ns/activitystreams#mediaType'), 'types the file');
  assert.ok(!pending.includes('https://www.w3.org/ns/activitystreams#url'), 'a pending file has no url');
  assert.ok(documents[0].uri.endsWith(documents[0].id), 'the document uri ends in its uuid');

  const r2 = recorder();
  await writeMessage(r2.updateFn, {
    conversationUri: CONVERSATION, content: 'Klaar.',
    maker: ASSISTANT,
    attachments: [{ name: 'meldingen.csv', mediaType: 'text/csv', url: '/files/8c31/download' }],
  });
  assert.ok(r2.calls[0].includes('https://www.w3.org/ns/activitystreams#url'), 'a ready file has a url');
});

await check('setDocumentUrl and dropDocument name the document', async () => {
  const r1 = recorder();
  await setDocumentUrl(r1.updateFn, DOCUMENT, '/files/8c31/download', CONVERSATION);
  assert.ok(r1.calls[0].includes(`<${DOCUMENT}>`), 'setDocumentUrl names the document');
  assert.ok(r1.calls[0].includes('sioc/ns#last_activity_date'), 'touches the conversation');

  const r2 = recorder();
  await dropDocument(r2.updateFn, DOCUMENT);
  assert.ok(r2.calls[0].includes(`<${DOCUMENT}>`), 'dropDocument names the document');
  assert.ok(r2.calls[0].includes('?message'), 'drops the link from the message');
});

await check('every recorded string parses as a SPARQL update', async () => {
  for (const maker of [recorder]) {
    const r = maker();
    await writeMessage(r.updateFn, {
      conversationUri: CONVERSATION, content: 'x', maker: ASSISTANT, title: 'x',
      attachments: [{ name: 'a.csv', mediaType: 'text/csv' }],
    });
    await writeMessage(r.updateFn, { conversationUri: CONVERSATION, content: 'y', maker: ASSISTANT });
    await setDocumentUrl(r.updateFn, DOCUMENT, '/files/8c31/download', CONVERSATION);
    await dropDocument(r.updateFn, DOCUMENT);
    for (const [i, sparql] of r.calls.entries()) {
      try {
        parse(sparql);
      } catch (e) {
        assert.fail(`update ${i} does not parse: ${e.message}\n${sparql}`);
      }
    }
  }
});

process.exit(failures ? 1 : 0);
