import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import { loadProfiles } from './src/runner/profile.js';
import { readConversation, readHistory, writeMessage } from './src/chat.js';
import { wantsExecution } from './src/llm/mode.js';
import { executeSpec, refineSpec } from './src/report-assistant.js';

const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profiles';
// The agent that signs the assistant's messages, seeded by the portal's
// chat-assistant migration.
const CHAT_ASSISTANT_URI = process.env.CHAT_ASSISTANT_URI || 'http://data.lblod.info/id/chat-agents/rapportassistent';
const TITLE_LENGTH = 80;
const FAILED = 'Er ging iets mis. Probeer het opnieuw.';

// Profiles load at boot. A broken profile stops the service.
const profiles = loadProfiles(PROFILE_DIR);

// One chat turn. Records the question, answers 202, then writes the
// assistant's answer; the frontend polls the conversation for it. mu's
// query/update run as the caller for the whole turn, also after the 202.
// The template only parses application/vnd.api+json, the chat sends
// application/json.
app.post('/assistant/conversations/:id/turns', bodyParser.json(), async function(req, res) {
  const content = String(req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });

  let conversation, history, question;
  try {
    // the access check: the caller's session decides what is readable
    conversation = await readConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'no such conversation' });
    history = await readHistory(conversation.uri, CHAT_ASSISTANT_URI);
    question = await writeMessage({
      conversationUri: conversation.uri,
      content,
      maker: conversation.creator,
      title: conversation.title ? undefined : content.slice(0, TITLE_LENGTH),
    });
  } catch (e) {
    console.error('[chat] could not record the question:', e);
    return res.status(500).json({ error: e.message });
  }

  res.status(202).json({ id: question.id });

  try {
    const turns = [...history, { role: 'user', content }];
    const answer = await wantsExecution(turns)
      ? await executeSpec(history, conversation.title, profiles)
      : await refineSpec(turns, profiles);
    await writeMessage({
      conversationUri: conversation.uri,
      content: answer.text,
      maker: CHAT_ASSISTANT_URI,
      attachments: answer.attachments,
    });
  } catch (e) {
    console.error('[chat] turn failed:', e);
    try {
      await writeMessage({ conversationUri: conversation.uri, content: FAILED, maker: CHAT_ASSISTANT_URI });
    } catch (e2) {
      console.error('[chat] could not write the failure message:', e2);
    }
  }
});

app.use(errorHandler);
