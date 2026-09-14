import { app } from 'mu';
import express from 'express';
import { loadProfiles } from './src/runner/profile.js';
import { buildSession, stripStoreError } from './src/db.js';
import { ask } from './src/llm/loop.js';
import { mountChat } from './src/chat/index.js';
import { reportAssistant } from './src/report-assistant.js';

const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profiles';

// Profiles load at boot; handlers await the same promise. A failed load
// answers an error per request instead of crashing boot.
let profilesPromise = loadProfiles(PROFILE_DIR);
profilesPromise.catch(e => console.error('[profiles] loading failed:', e.message));

async function whenProfiles() {
  try {
    return await profilesPromise;
  } catch (e) {
    throw new Error('profiles are not available: ' + e.message);
  }
}

// The chat. reportAssistant is the answer hook: it runs the LLM loop with the
// conversation so far and turns a report run into an interim message with a
// pending file.
mountChat(app, { path: '/assistant', answer: reportAssistant(whenProfiles) });

// POST /ask: one question in, the answer in Dutch and a trace of the tool
// calls back. Follow-ups carry the earlier turns in `history`.
// The template parses application/vnd.api+json only; this route parses the
// plain JSON body itself.
app.post('/ask', express.json(), async (req, res) => {
  const { question, history } = req.body || {};
  if (!question) return res.status(400).json({ error: 'no question in the request body' });
  if (!process.env.LLM_BASE_URL) return res.status(503).json({ error: 'no LLM configured (set LLM_BASE_URL)' });

  try {
    const profiles = await whenProfiles();
    const turns = [
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: question },
    ];
    const session = await buildSession();
    const { text, trace } = await ask(turns, profiles, session);
    res.json({ answer: text, toolCalls: trace });
  } catch (e) {
    console.error('[ask] failed:', e);
    res.status(502).json({ error: stripStoreError(e.message) });
  }
});
