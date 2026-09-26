import { app, errorHandler } from 'mu';
import { loadProfiles } from './src/runner/profile.js';
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

// The chat. reportAssistant is the answer hook: it refines the spec with the
// LLM, or runs the agreed spec without it.
mountChat(app, { path: '/assistant', answer: reportAssistant(whenProfiles) });

app.use(errorHandler);