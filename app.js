import { app } from 'mu';
import { loadProfiles } from './src/runner/profile.js';
import { buildSession, stripStoreError } from './src/db.js';
import { ask } from './src/llm/loop.js';
import { mountChat } from './src/chat/index.js';
import { reportAssistant } from './src/report-assistant.js';

const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profiles';

// Profiles load fire-and-forget, like waitForDatabase in the bbcdr services:
// routes are registered synchronously, handlers await the same promise, and a
// call that lands before the load finishes just waits it out (local file
// reads). If loading failed, calls answer an error instead of crashing boot.
let profilesPromise = loadProfiles(PROFILE_DIR);
profilesPromise.catch(e => console.error('[profiles] loading failed:', e.message));

async function whenProfiles() {
  try {
    return await profilesPromise;
  } catch (e) {
    throw new Error('profiles are not available: ' + e.message);
  }
}

// The chat. The turn module is generic (src/chat/ moves between services
// without edits); reportAssistant is this service's one answer hook: it runs
// the loop below with the conversation so far and turns a report run into an
// interim message with a pending file. Step 1's echo hook, kept for tests:
//   answer: async (turn) => { await sleep(5000); return `Je schreef: ${turn.content}`; }
mountChat(app, { path: '/assistant', answer: reportAssistant(whenProfiles) });

// The endpoint. One conversation turn in Dutch, the agent loop runs inside
// (read the profiles, look up values on the public graph, write a spec,
// validate and repair it, run the report) and the answer in Dutch comes back
// with a trace of the tool calls. Follow-ups carry the earlier turns in
// `history`; the conversation lives on the caller's side.
app.post('/ask', async (req, res) => {
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
