// The turn endpoint. Mount it on the service that answers:
//
//   mountChat(app, { path: '/assistant', answer });
//
// answer(turn) is the only thing the service writes. See the plan, §3, for
// the turn object. This file knows nothing about what the answer is.
import express from 'express';
import { query as muQuery, update as muUpdate } from 'mu';
import {
  readConversation, readHistory, findAssistant,
  writeMessage, setDocumentUrl, dropDocument,
} from './store.js';

const TEXT = {
  failed: 'Er ging iets mis. Probeer het opnieuw.',
};
const TITLE_LENGTH = 80;

export function mountChat(app, { path = '/assistant', answer }) {
  if (typeof answer !== 'function') throw new Error('mountChat needs an answer(turn) function');

  app.post(`${path}/conversations/:id/turns`, express.json(), async (req, res) => {
    const content = String(req.body?.content ?? '').trim();
    if (!content) return res.status(400).json({ error: 'content is required' });

    // 1. the access check: the query carries the caller's session, and the
    // auth layer answers with what they may read
    let conversation;
    try {
      conversation = await readConversation(req.params.id);
    } catch (e) {
      console.error('[chat] conversation read failed:', e);
      return res.status(500).json({ error: e.message });
    }
    if (!conversation) return res.status(404).json({ error: 'no such conversation' });

    let assistant, history, userMessage;
    try {
      assistant = process.env.CHAT_ASSISTANT_URI || await findAssistant();
      history = await readHistory(conversation.uri, assistant);
      userMessage = await writeMessage({
        conversationUri: conversation.uri,
        content,
        maker: conversation.creator,
        title: conversation.title ? undefined : content.slice(0, TITLE_LENGTH),
      });
    } catch (e) {
      console.error('[chat] could not record the question:', e);
      return res.status(500).json({ error: e.message });
    }

    // 2. answer now; the assistant's message comes when it comes. The
    // template's helpers keep attaching this request's session for the
    // whole continuation, so the writes below stay the caller's;
    // mu-authorization is in charge of what lands where.
    res.status(202).json({ id: userMessage.id });

    const turn = {
      conversation: { uri: conversation.uri, id: conversation.id, title: conversation.title },
      history,
      content,
      query: muQuery,
      update: muUpdate,
      finished: false,
      say: (text, attachments = []) => writeMessage({
        conversationUri: conversation.uri, content: text, maker: assistant, attachments,
      }),
      setUrl: (documentUri, url) => setDocumentUrl(documentUri, url, conversation.uri),
      drop: (documentUri) => dropDocument(documentUri),
    };

    try {
      const text = await answer(turn);
      if (typeof text === 'string' && text.trim()) await turn.say(text.trim());
    } catch (e) {
      console.error('[chat] turn failed:', e);
      try {
        await turn.say(TEXT.failed);
      } catch (e2) {
        console.error('[chat] could not write the failure message:', e2);
      }
    } finally {
      turn.finished = true;
    }
  });

  console.log(`[chat] turns at POST ${path}/conversations/:id/turns`);
}
