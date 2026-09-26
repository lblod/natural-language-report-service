// The mode classifier. One LLM call per turn: a guestimate of whether the
// user wants to keep refining the query or has given a clear command to
// execute it now. Returns true (execute) / false (refine). Deterministic
// code branches on the answer; refine is the safe default when the call
// fails or the answer does not parse.

import { chat } from './loop.js';

const MODE_PROMPT = `You read a conversation between a user and a report assistant.
The assistant proposes report specs and asks the user to confirm before
running them.

Decide whether the user's LAST message is a clear instruction to run the
report now (for example "ja", "voer uit", "doe het", "maak het rapport",
"go", "execute", "run it") or is still refining, asking, correcting or
answering a question.

Rules:
- Only return true when the user clearly tells the assistant to execute the
  agreed report right now. A short "ja" or "ok" after a proposal counts.
- A new or amended question, a clarification, a "no", a question about the
  proposal, or the absence of an earlier proposal means false.
- When in doubt, return false.

Reply with exactly one token: true or false. No other words, no punctuation,
no markdown.`;

// wantsExecution(turns) → true when the user's last message says "run it
// now". turns: [{ role, content }], newest last; the last few are enough.
export async function wantsExecution(turns) {
  let message;
  try {
    ({ message } = await chat([{ role: 'system', content: MODE_PROMPT }, ...turns.slice(-6)]));
  } catch (e) {
    // The call failed (no LLM, provider down). Refine: safer than running a
    // report on a guess, and the refine loop will surface the real error.
    return false;
  }
  return stripMarkdown(firstText(message)).trim().toLowerCase().startsWith('true');
}

// Reasoning models may leave `content` empty and put the visible text in a
// separate field (reasoning_content / thinking / reasoning), or may not
// answer at all when the thinking burned the token budget. Read the visible
// fields in order and take the first non-empty one.
function firstText(message) {
  for (const key of ['content', 'reasoning_content', 'reasoning', 'thinking']) {
    const v = message?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function stripMarkdown(s) {
  return String(s).replace(/[*_`>#]/g, ' ');
}
