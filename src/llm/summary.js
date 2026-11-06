// A report's dct:description, written right before the report runs. The LLM
// reads only the conversation that agreed the report, never report data: one
// short Dutch sentence, at most MAX_LENGTH characters. It stays outside the
// execution, so it can move to another service later.

import { callLlm } from './loop.js';

const MAX_LENGTH = 300;

const DESCRIPTION_PROMPT = `You write the description of a report for a list of reports.
The conversation below agreed the report. Write one plain Dutch sentence that
says what the report lists and which filters it applies. Use at most 300
characters. No markdown, no quotes, no title, no line breaks. Reply with the
description only.`;

// One description, or the title when the model returns no text. Only
// `content` counts: reasoning_content and the like are the model's thinking,
// not a description for the reports list. A failing call throws: the report
// is not registered without its description.
export async function describeReport(turns, title) {
  const transcript = turns
    .filter(t => t.content && t.content.trim())
    .map(t => `${t.role === 'assistant' ? 'Assistent' : 'Gebruiker'}: ${t.content.trim()}`)
    .join('\n\n');
  const message = await callLlm([
    { role: 'system', content: DESCRIPTION_PROMPT },
    { role: 'user', content: `Rapporttitel: ${title || '(geen titel)'}\n\nGesprek:\n${transcript}` },
  ]);
  return shorten(message?.content) || shorten(title);
}

// One line of at most MAX_LENGTH characters; a cut gets an ellipsis.
function shorten(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_LENGTH ? clean : `${clean.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}
