// The agent loop: POST /v1/chat/completions with tool calls,
// OpenAI-compatible (LLM_BASE_URL, LLM_MODEL, LLM_API_KEY). No provider
// SDKs. Stops when the model answers without tool calls.
//
// Two modes, picked per turn by a mode classifier (./mode.js):
// - refine: the LLM proposes a spec, may look up candidate values in code
//   lists (under the service scope) and iterates with the user. It never
//   runs a report and never learns what a spec would match. The user must
//   confirm before anything executes.
// - execute: the LLM writes the agreed spec, validates it and runs the
//   report once. run_report returns only counts and URIs; no cell value ever
//   reaches the model.

import { buildTools } from './tools.js';
import { classifyMode } from './mode.js';

const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 12);
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL;
const LLM_API_KEY = process.env.LLM_API_KEY;
// LOG_LLM=1 dumps every request to and response from the provider, verbatim.
const LOG_LLM = /^(true|1)$/i.test(process.env.LOG_LLM || '');

// Refinement (Modus A). The LLM and the user iterate on a spec. The LLM may
// look up candidate values in code lists (lookup_values, under the service
// scope) to make concrete suggestions, but it may not run a report and never
// learns how many subjects a spec would match. It ends with a proposal in
// Dutch and asks the user to confirm.
const REFINE_PROMPT = `You refine report specs with the user. You never write SPARQL and you never run a report.

The profile lists what can be asked. Compose paths by chaining fields.

Rules:
- A column must end on a value, not on a link. Chain one more hop.
- When two entities share one sh:targetClass, the spec also needs rep:entity
  with that entity's URI; describe_profile shows it after each entity.
- Filters go in sh:property. Columns go in rep:columns, in the order you want.
- To match a topic rather than a value, list the Dutch words and compounds you
  would expect and put them all in rep:anyOf.
- You cannot count, sort, take the first N, or compare two subjects. Say so.
- The report's title is the dct:title you write in the spec. There is no other
  title input.

You are in refinement mode. You propose a spec and explain in Dutch what it
will list and filter. Use lookup_values to find concrete values (names, codes)
for a filter, so your proposal names real values instead of guesses. That is
the only database read you have, and it only suggests values: it never tells
you whether a spec is good or how much it matches. The database you read may
differ from the one the report runs on, so never treat a lookup as a check.
Iterate with the user on the spec itself: paths, filters, columns. Never call
run_report; there is no such tool here. When the spec is ready, present it in
Dutch and ask the user to confirm execution. Then stop.

Your final answer to the user MUST contain the full agreed spec as one Turtle
block, so the next turn can reuse it verbatim. Put the Dutch explanation first,
then the Turtle block, then the question asking to confirm.

Always prefix the spec with @prefix lines. Use the prefixes the profile
declares. Write the spec as one Turtle block. Then call validate_spec. Fix
what it says, up to three rounds. Then propose and stop.

Reply to the user in Dutch. Earlier turns are context only. Answer the last one.`;

// Execution (Modus B). The user has confirmed. The LLM writes the agreed
// spec, validates it and runs the report once, then stops. It never sees the
// report's data: run_report returns only the report URI, the row count and
// the file URI.
const EXECUTE_PROMPT = `You write report specs. You never write SPARQL and you never see report data.

The profile lists what can be asked. Compose paths by chaining fields.

Rules:
- A column must end on a value, not on a link. Chain one more hop.
- When two entities share one sh:targetClass, the spec also needs rep:entity
  with that entity's URI; describe_profile shows it after each entity.
- Filters go in sh:property. Columns go in rep:columns, in the order you want.
- To match a topic rather than a value, list the Dutch words and compounds you
  would expect and put them all in rep:anyOf.
- You cannot count, sort, take the first N, or compare two subjects. Say so.
- The report's title is the dct:title you write in the spec. There is no other
  title input.
- One question makes one report. Write the agreed spec, validate it, run it,
  then stop. Do not write a second report.

The agreed spec may already be in an earlier assistant message (a Turtle
block). Reuse it verbatim when it fits the user's confirmed intent; only
adjust it when the user asked for a change.

Always prefix the spec with @prefix lines. Use the prefixes the profile
declares. Write the spec as one Turtle block. Then call validate_spec. Fix
what it says, up to three rounds. Then call run_report. After run_report
returns, stop.

Reply to the user in Dutch. Earlier turns are context only. Answer the last one.`;

// ask(questionOrMessages, profiles, session) → { text, trace }
// A string is one question; an array is the conversation so far,
// [{ role, content }], newest last. The system prompt is always this file's
// own; a system message in the input is dropped.
export async function ask(questionOrMessages, profiles, session) {
  const trace = [];

  const turns = typeof questionOrMessages === 'string'
    ? [{ role: 'user', content: questionOrMessages }]
    : questionOrMessages.filter(m => m.role !== 'system');

  const execute = await classifyMode(turns);
  trace.push({ name: 'classify', args: { execute }, result: execute ? 'execute' : 'refine' });

  if (execute) {
    return runLoop(turns, profiles, session, 'execute', trace);
  }
  return runLoop(turns, profiles, session, 'refine', trace);
}

// runLoop drives the agent loop for one mode. The mode picks the system
// prompt and the tool set; the code path is deterministic from there.
async function runLoop(turns, profiles, session, mode, trace) {
  const { handlers } = buildTools(profiles, session, mode);
  const systemPrompt = mode === 'execute' ? EXECUTE_PROMPT : REFINE_PROMPT;
  const messages = [{ role: 'system', content: systemPrompt }, ...turns];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await chat(messages, { tools: toolDefs(mode) });
    messages.push(reply.message);
    const calls = reply.message.tool_calls || [];
    if (!calls.length) {
      return { text: reply.message.content || '', trace };
    }
    for (const call of calls) {
      const args = parseArgs(call.function.arguments);
      trace.push({ name: call.function.name, args });
      const fn = handlers.get(call.function.name);
      let resultText;
      if (!fn) {
        resultText = `unknown tool "${call.function.name}"`;
      } else {
        try {
          const out = await fn(args);
          resultText = out.content?.[0]?.text ?? JSON.stringify(out);
        } catch (e) {
          resultText = `tool failed: ${String(e.message || e).split('\n')[0]}`;
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      trace[trace.length - 1].result = resultText;
    }
  }
  return { text: '(loop did not finish)', trace };
}

// chat(messages, { tools, toolChoice }) → { message }
// The one place that talks to the provider. tools null (the default) means a
// plain completion (the mode classifier); runLoop passes its mode's tool
// definitions; toolChoice defaults to 'auto'.
export async function chat(messages, { tools = null, toolChoice = 'auto' } = {}) {
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
  const body = {
    model: LLM_MODEL,
    messages: wire,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice === 'auto' ? 'auto' : toolChoice;
  }
  if (LOG_LLM) {
    console.log(`[llm] POST ${LLM_BASE_URL}/chat/completions request:\n${
      JSON.stringify(body, null, 2)}`);
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

// The tool definitions sent to the model.
import { toolSchemas } from './schemas.js';
function toolDefs(mode) {
  return toolSchemas(mode).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}