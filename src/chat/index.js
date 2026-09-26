// The turn endpoint. Mount it with mountChat(app, { path, answer });
// answer(turn) is the only thing the mounting service writes.
import express from 'express';
import { query as muQuery, update as muUpdate } from 'mu';
import {
  readConversation, readHistory, findAssistant,
  writeMessage,
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

    // 1. the access check: the caller's session decides what is readable
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

    // 2. answer 202 now; the assistant's message comes when it comes. The
    // continuation still runs as the caller.
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
    };

    try {
      // answer may return a string, or { text, attachments } for answers the
      // assistant writes with an attachment, such as the report spec.
      const result = await answer(turn);
      const text = typeof result === 'string' ? result : result?.text;
      const attachments
        = typeof result === 'string' ? [] : (result?.attachments ?? []);
      if (typeof text === 'string' && text.trim()) {
        await turn.say(text.trim(), attachments);
      }
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
