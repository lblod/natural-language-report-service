// The agent loop: POST /v1/chat/completions with tool calls,
// OpenAI-compatible (LLM_BASE_URL, LLM_MODEL, LLM_API_KEY). No provider
// SDKs. Stops when the model answers without tool calls.
//
// Refinement only: the LLM proposes a spec, may look up candidate values in
// code lists, explore the data and sample a draft spec (all on the public
// graph, under the service scope) and iterates with the user. It never
// runs a report and never learns what the report would hold. The user must
// confirm before anything executes; execution runs the agreed spec without
// the LLM (../report-assistant.js).

import { TOOLS, runTool } from './tools.js';
import { SPEC_MEDIA_TYPE } from '../chat.js';

const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 12);
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL;
const LLM_API_KEY = process.env.LLM_API_KEY;
// LOG_LLM=1 dumps every request to and response from the provider, verbatim.
const LOG_LLM = /^(true|1)$/i.test(process.env.LOG_LLM || '');

// Refinement (Modus A). The LLM and the user iterate on a spec. The LLM may
// look up candidate values in code lists (lookup_values), explore the data
// of a target class (explore_data) and sample a draft spec (sample_spec),
// all on the public graph under the service scope, but it may not run a
// report and never learns how many subjects the report would match. It ends with a proposal in
// Dutch and asks the user to confirm.
const REFINE_PROMPT = `You refine report specs with the user. You never write SPARQL and you never run a report.

The profile lists what can be asked. Compose paths by chaining fields.

Rules:
- A column must end on a value, not on a link. Chain one more hop. Only when
  the user asks for the URI of a linked node itself, end the column on that
  link and add sh:nodeKind sh:IRI to the column.
- When two entities share one sh:targetClass, the spec also needs rep:entity
  with that entity's URI; describe_profile shows it after each entity.
- Filters go in sh:property. Columns go in rep:columns, in the order you want.
- To match a topic rather than a value, list the Dutch words and compounds you
  would expect and put them all in rep:anyOf.
- A filter tests only the end of its own path, and two filters never share a
  node. To test a node in the middle of a path (for example "the mandate
  whose role is Burgemeester"), give that filter or column a rep:where:
  rep:where [ sh:path ( <the same first steps> <more steps> ) ; <one condition> ].
  Write its path from the row, like a filter. The steps it has in common with
  its filter or column are the same nodes, and its condition tests where its
  own path ends. On a column, rep:where drops values from the cell, never
  rows. Several rep:where on one filter or column all apply.
- validate_spec answers "ok" plus one line per rep:where saying where it
  applies. Say that in Dutch in your proposal, so the user can check it.
- Only offer what validate_spec accepted. Before you suggest an alternative,
  write it and validate it; if it does not validate, say it cannot be done.
- You cannot count, sort, take the first N, or compare two subjects. Say so.
- The report's title is the dct:title you write in the spec. There is no other
  title input.

You are in refinement mode. You propose a spec and explain in Dutch what it
will list and filter. Use lookup_values to find concrete values (names, codes)
for a filter, so your proposal names real values instead of guesses. Use
explore_data to see what the data of a target class holds: its predicates,
example values and links; call it on a linked class to follow a path. A
predicate that is not in the profile cannot go in a spec. Use sample_spec on
a spec that validates to see a few of its rows, and fix paths or filters that
do not land where you expect. All three read only public data. The report
runs as the user, on data you may not see, so a lookup or a sample is a hint,
never a count and never a promise: do not tell the user how many rows the
report will have, or that it will be empty.
Iterate with the user on the spec itself: paths, filters, columns. When the
user wants an earlier spec changed, open it with read_spec and change what
they asked for. Never call
run_report; there is no such tool here. When the spec is ready, ask the user
to confirm execution. Then stop.

The spec itself does not go in your text. validate_spec stores a spec that
checks out as an attachment ("bijlage", a spec file) on your answer. So in
your answer: explain in Dutch in full what the report will list and which
filters it applies, tell the user the actual spec is in the bijlage and to
look there, and ask the user to confirm execution. Do not print the Turtle
yourself; the bijlage shows the validated version, so never rewrite it in
the text either.

Always prefix the spec with @prefix lines. Use the prefixes the profile
declares. Write the spec as one Turtle block. Then call validate_spec. Fix
what it says, up to three rounds. Then propose and stop.

Reply to the user in Dutch. Earlier turns are context only. Answer the last one.`;

// ask(turns, profiles) → { text, spec }. turns is the conversation so far,
// [{ role, content, attachments }], newest last. spec is the last spec
// validate_spec accepted in this turn, or null.
export async function ask(turns, profiles) {
  const messages = [{ role: 'system', content: REFINE_PROMPT }, ...turns.map(withSpecHint)];
  let spec = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { message } = await chat(messages, TOOLS);
    messages.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) return { text: message.content || '', spec };

    for (const call of calls) {
      const args = parseArgs(call.function.arguments);
      let result;
      try {
        result = await runTool(call.function.name, args, profiles);
      } catch (e) {
        result = `tool failed: ${String(e.message || e).split('\n')[0]}`;
      }
      // validate_spec answers "ok" (plus notes) when the spec checks out;
      // that spec becomes the bijlage of the answer.
      if (call.function.name === 'validate_spec' && /^ok(\n|$)/.test(result)) spec = args.spec;
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return { text: 'Sorry, dit rapport is te moeilijk. Contacteer de developers.', spec };
}

// The history carries the spec as a bijlage. Paste one hint line per spec
// under the message text, so the model knows a spec is there and opens it
// with read_spec; the chat itself still keeps the Turtle out of the text.
function withSpecHint(turn) {
  const specs = (turn.attachments || []).filter(a => a.mediaType === SPEC_MEDIA_TYPE);
  if (!specs.length) return turn;
  const hints = specs.map(a => `Bijlage "${a.name}", a spec file (read it with read_spec).`);
  return { ...turn, content: `${turn.content}\n\n${hints.join('\n\n')}` };
}

// chat(messages, tools) → { message }. The one place that talks to the
// provider. Without tools it is a plain completion (the mode check).
export async function chat(messages, tools = null) {
  // Send only the fields every provider accepts back.
  const wire = messages.map(m => {
    const out = { role: m.role, content: m.content ?? null };
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments },
      }));
    }
    if (m.role === 'tool' && m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
  const body = { model: LLM_MODEL, messages: wire };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (LOG_LLM) {
    console.log(`[llm] POST ${LLM_BASE_URL}/chat/completions request:\n${
      JSON.stringify(body, null, 2)}`);
  } else {
    console.log('[llm] sending instructions to llm');
  }
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  if (LOG_LLM) {
    console.log(`[llm] response:\n${JSON.stringify(data, null, 2)}`);
  }
  return { message: data.choices[0].message };
}

function parseArgs(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
