// Run or refine. One LLM call per turn reads whether the user gave a clear
// command to run the report now. Plain code branches on the answer. Refine
// is the default when the call fails or the answer is unclear: running a
// report on a guess is worse than asking once more.

import { callLlm } from './loop.js';

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

// True when the user's last message says "run it now". turns: [{ role,
// content }], newest last; the last few are enough. Only `content` is the
// answer: reasoning_content and the like are the model's thinking, and a
// thought that starts with "true" must not run a report. Empty content
// means refine.
export async function wantsExecution(turns) {
  let message;
  try {
    message = await callLlm([{ role: 'system', content: MODE_PROMPT }, ...turns.slice(-6)]);
  } catch {
    // The call failed (no LLM, provider down). Refine: safer than running a
    // report on a guess, and the refine loop will surface the real error.
    return false;
  }
  return stripMarkdown(message?.content || '').trim().toLowerCase().startsWith('true');
}

// Markdown marks out, so "**true**" still reads as true.
function stripMarkdown(s) {
  return String(s).replace(/[*_`>#]/g, ' ');
}
