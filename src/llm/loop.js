// The agent loop: POST /v1/chat/completions with tool calls,
// OpenAI-compatible (LLM_BASE_URL, LLM_MODEL, LLM_API_KEY). No provider
// SDKs. Stops when the model answers without tool calls.

import { buildTools } from './tools.js';

const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 12);
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL;
const LLM_API_KEY = process.env.LLM_API_KEY;
// LOG_LLM=1 dumps every request to and response from the provider, verbatim.
const LOG_LLM = /^(true|1)$/i.test(process.env.LOG_LLM || '');

const SYSTEM_PROMPT = `You write report specs. You never write SPARQL and you never see report data.

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
- One question makes one report. Write one spec, validate it, run it, then stop.
  Do not write a second report for the same question.

Always prefix the spec with @prefix lines. Use the prefixes the profile declares.
Write the spec as one Turtle block. Then call validate_spec. Fix what it says,
up to three rounds. Then call run_report. After run_report returns, stop.

Reply to the user in Dutch. Earlier turns are context only. Answer the last one.`;

// ask(questionOrMessages, profiles, session) → { text, trace }
// A string is one question; an array is the conversation so far,
// [{ role, content }], newest last. The system prompt is always this file's
// own; a system message in the input is dropped.
export async function ask(questionOrMessages, profiles, session) {
  const { handlers } = buildTools(profiles, session);
  const trace = [];

  const turns = typeof questionOrMessages === 'string'
    ? [{ role: 'user', content: questionOrMessages }]
    : questionOrMessages.filter(m => m.role !== 'system');
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...turns];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await chat(messages);
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

async function chat(messages) {
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
    tools: toolDefs(),
    tool_choice: 'auto',
  };
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
function toolDefs() {
  return toolSchemas().map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}