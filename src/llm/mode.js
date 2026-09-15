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

// classifyMode(turns) → boolean (true = execute now)
// turns: [{ role, content }], newest last. A leading system message is
// dropped; the assistant's own system prompt is never sent to the model.
export async function classifyMode(turns) {
  const convo = (turns || [])
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content ?? '' }));
  if (!convo.length) return false;

  // Keep the last few turns; the decision is about the latest message.
  const recent = convo.slice(-6);
  const messages = [{ role: 'system', content: MODE_PROMPT }, ...recent];
  let raw;
  try {
    const reply = await chat(messages, { tools: null });
    raw = firstText(reply.message);
  } catch (e) {
    // The classifier call failed (no LLM, provider down). Default to refine:
    // safer than running a report on a guess, and the refine loop will
    // surface the real error to the user.
    return false;
  }
  const text = stripMarkdown(raw).trim().toLowerCase();
  if (!text) return false;
  if (text.startsWith('true')) return true;
  if (text.startsWith('false')) return false;
  // A JSON {"execute": ...} shape some models emit.
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const v = JSON.parse(m[0]);
      if (typeof v === 'boolean') return v;
      if (v && typeof v.execute === 'boolean') return v.execute;
      if (v && typeof v.refine === 'boolean') return !v.refine;
    }
  } catch { /* ignore */ }
  return false;
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