// The refine loop. The LLM proposes a spec, may look up code-list values and
// iterates with the user. It never runs a report and never learns what a
// spec would match: the user confirms, and execution runs the agreed spec
// without the LLM. It talks to an OpenAI-compatible /chat/completions with
// tool calls and no provider SDK, so any such endpoint works.

import { TOOLS, runTool } from './tools.js';
import { describeProfile } from './describe.js';
import { parseSpec } from '../runner/spec.js';
import { SPEC_MEDIA_TYPE, readSpecFile } from '../chat.js';

// LLM calls per turn while the model writes a spec.
const MAX_ROUNDS = 12;
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL;
const LLM_API_KEY = process.env.LLM_API_KEY;
// LOG_LLM=1 dumps every request to and response from the provider, verbatim.
const LOG_LLM = /^(true|1)$/i.test(process.env.LOG_LLM || '');
// Set, every exchange with the provider is also posted here, so app-http-logger
// records it (the sink of the app). The provider call itself is TLS, which
// the logger cannot read.
const LOG_SINK_URL = process.env.LOG_SINK_URL;
// A call that fails on the network or with a status in RETRY_STATUS is tried
// again LLM_RETRIES times. The first retry waits LLM_RETRY_DELAY ms, every
// next one twice as long. Any other failure is thrown at once.
const LLM_RETRIES = Number(process.env.LLM_RETRIES || 3);
const LLM_RETRY_DELAY = Number(process.env.LLM_RETRY_DELAY || 2000);
const RETRY_STATUS = [500, 502, 503, 504];

const REFINE_PROMPT = `You refine report specs with the user. You never write SPARQL and you never run a report.

The profile lists what can be asked. Compose paths by chaining fields. The
profiles are listed at the end of this prompt. When there is a current spec,
the menu of its profile follows them: use it, and call describe_profile only
for another profile.

Rules:
- A column must end on a value, not on a link. Chain one more hop. Only when
  the user asks for the URI of a linked node itself, end the column on that
  link and add sh:nodeKind sh:IRI to the column.
- When two entities share one sh:targetClass, the spec also needs rep:entity
  with that entity's URI; describe_profile shows it after each entity.
- Filters go in sh:property. Columns go in rep:columns, in the order you want.
- A filter on a linked thing (a code, a bestuurseenheid, anything with a
  name) tests the link, not the name: sh:path ( <link> ) ; sh:hasValue <uri>,
  or sh:in ( <uri> <uri> ) for several. Take the URI from the values the menu
  lists after the field, or call lookup_values with that field. The menu
  marks an entity "(not readable)" when nothing of it is in the part of the
  database you read: lookup_values finds nothing there. Even of an entity
  you can read, you may see only some instances: a bestuurseenheid that is
  not in your lookup can still exist where the report runs. So when neither
  gives a URI, that is normal: you only read the public part of the
  database, the report runs on the whole. Then filter on the name field
  with a regex instead, sh:path ( <link> <name field> ) ; sh:pattern "the
  name" ; sh:flags "i". Say in your answer that the name text is matched
  because you only see the public part of the database, and that the user
  can check the result.
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
- One answer carries one spec, and one spec is one report on one profile. If
  the question needs two reports, say so, propose the first, and offer the
  second as the next step.
- You cannot count, sort, take the first N, or compare two subjects. Say so.
- The report's title is the dct:title you write in the spec. There is no other
  title input.

You are in refinement mode. You propose a spec and explain in Dutch what it
will list and filter. Use lookup_values to find concrete values (names, codes)
for a filter, so your proposal names real values instead of guesses. That is
the only database read you have, and it only suggests values: it never tells
you whether a spec is good or how much it matches. The database you read may
differ from the one the report runs on, so never treat a lookup as a check.
Iterate with the user on the spec itself: paths, filters, columns. The
current spec, the last one in the conversation, comes with the user's
message. When the user refines (other columns, filters or title), change the
current spec. When the user asks for a different report, one that lists
another kind of thing per row, start a new spec. Older specs show only as a
bijlage name. Only when the user asks for an older spec, open it with
read_spec and change that one. Never call run_report; there is no such tool
here. When the spec is ready, ask the user
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

// One refine turn. turns is the conversation so far, [{ role, content,
// attachments }], newest last. Sends it to the model and runs the tools the
// model asks for, until it answers in text or MAX_ROUNDS runs out. The model
// may only propose a spec it validated, hence the tool rounds. Returns the
// answer text and the last spec validate_spec accepted in this turn, or
// null.
export async function ask(turns, profiles) {
  const current = findCurrentSpec(turns);
  const messages = [{ role: 'system', content: await buildSystemPrompt(current, profiles) },
    ...addCurrentSpec(turns.map(addSpecHint), current)];
  let spec = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const message = await callLlm(messages, TOOLS);
    messages.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) return { text: message.content || '', spec };

    for (const call of calls) {
      const args = parseArgs(call.function.arguments);
      let result;
      try {
        result = await runTool(call.function.name, args, profiles);
      } catch (e) {
        result = { content: `tool failed: ${String(e.message || e).split('\n')[0]}` };
      }
      // validate_spec hands back the spec when it checks out; that spec
      // becomes the bijlage of the answer.
      // One answer carries one spec: say so when this one replaces another.
      if (call.function.name === 'validate_spec' && result.spec) {
        if (spec && spec !== result.spec) {
          result.content += '\nThis spec replaces the one you validated before. Your answer carries only this one.';
        }
        spec = result.spec;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
  }
  return { text: 'Sorry, dit rapport is te moeilijk. Contacteer de developers.', spec };
}

// The history carries the spec as a bijlage, never as text. Paste one hint
// line per spec under the message text, so the model knows a spec is there
// and can open it with read_spec when the user asks for it. A spec the model
// printed in its answer anyway is cut from the text.
function addSpecHint(turn) {
  const content = turn.role === 'assistant' ? cutSpecText(turn.content) : turn.content;
  const specs = (turn.attachments || []).filter(a => a.mediaType === SPEC_MEDIA_TYPE);
  if (!specs.length) return { ...turn, content };
  const hints = specs.map(a => `Bijlage "${a.name}", a spec file.`);
  return { ...turn, content: `${content}\n\n${hints.join('\n\n')}` };
}

// A code block that holds a spec becomes "(spec left out)": the spec lives
// in its bijlage, and the history should not carry a second copy.
function cutSpecText(text) {
  return text.replace(/```[\s\S]*?```/g, block => (block.includes('ReportSpec') ? '(spec left out)' : block));
}

// The current spec: the last spec bijlage in the conversation, or null.
// Refine changes this spec, so the model gets it in full.
function findCurrentSpec(turns) {
  const name = turns.flatMap(t => t.attachments || [])
    .filter(a => a.mediaType === SPEC_MEDIA_TYPE).at(-1)?.name;
  const turtle = name && readSpecFile(name);
  return turtle ? { name, turtle } : null;
}

// The system prompt also carries what the model would otherwise fetch at the
// start of every turn: the profile list, and the menu of the current spec's
// profile. Without a menu the model calls describe_profile itself.
async function buildSystemPrompt(current, profiles) {
  const parts = [REFINE_PROMPT, `The profiles:\n${listProfiles(profiles)}`];
  const uri = current && readProfileUri(current.turtle);
  if (profiles.has(uri)) {
    try {
      parts.push(`The menu of the current spec's profile <${uri}>:\n\n${await describeProfile(profiles.get(uri))}`);
    } catch (e) {
      console.error('[llm] could not describe the current profile:', e.message);
    }
  }
  return parts.join('\n\n');
}

// One line per profile, its title and URI, for the system prompt.
function listProfiles(profiles) {
  return [...profiles.values()].map(p => `${p.title}  <${p.uri}>`).join('\n');
}

// The rep:profile of a spec, or null when the Turtle does not parse. It
// picks the menu for the system prompt.
function readProfileUri(turtle) {
  try {
    return parseSpec(turtle).profileUri;
  } catch {
    return null;
  }
}

// The current spec goes in full under the user's new message: the one spec
// the history holds as text, so the model needs no read_spec for it.
function addCurrentSpec(messages, current) {
  if (!current) return messages;
  const { name, turtle } = current;
  const last = messages.at(-1);
  return [...messages.slice(0, -1), {
    ...last,
    content: `${last.content}\n\nThe current spec, bijlage "${name}":\n\n${turtle}`,
  }];
}

// The one place that talks to the provider. Without tools it is a plain
// completion (the mode check and the report description). Returns the
// model's message.
export async function callLlm(messages, tools = null) {
  // Send only the fields every provider accepts back. Attachments never go
  // out.
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
  if (tools) body.tools = tools;
  if (LOG_LLM) {
    console.log(`[llm] POST ${LLM_BASE_URL}/chat/completions request:\n${
      JSON.stringify(body, null, 2)}`);
  } else {
    console.log('[llm] sending instructions to llm');
  }
  let data;
  try {
    data = await postWithRetry(body);
  } catch (e) {
    if (LOG_SINK_URL) copyToSink(body, { error: e.message });
    throw e;
  }
  if (LOG_LLM) {
    console.log(`[llm] response:\n${JSON.stringify(data, null, 2)}`);
  }
  if (LOG_SINK_URL) copyToSink(body, data);
  return data.choices[0].message;
}

// A copy of one exchange to the app's log sink: the body as it went to the
// provider (no Authorization header) and the answer, or the error when the
// call failed. Fire-and-forget, like acmidm-login-service does with its
// token sets: the sink never slows or fails a turn.
function copyToSink(request, response) {
  fetch(LOG_SINK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request, response }),
  }).catch(e => console.error('[llm] could not copy the exchange to the sink:', e.message));
}

// POST to the provider, with retries. A network error or a status in
// RETRY_STATUS waits and tries again; the last failure is thrown.
async function postWithRetry(body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // No connection, a reset or no answer at all: always worth another try.
      if (attempt >= LLM_RETRIES) throw e;
      await pause(attempt, `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
      continue;
    }
    if (res.ok) return res.json();
    const t = await res.text();
    if (!RETRY_STATUS.includes(res.status) || attempt >= LLM_RETRIES) {
      throw new Error(`LLM ${res.status}: ${t.slice(0, 300)}`);
    }
    await pause(attempt, `LLM ${res.status}`);
  }
}

// Waits before the next try: LLM_RETRY_DELAY, doubled on every attempt.
async function pause(attempt, reason) {
  const wait = LLM_RETRY_DELAY * 2 ** attempt;
  console.log(`[llm] ${reason}; retry ${attempt + 1}/${LLM_RETRIES} in ${Math.round(wait / 1000)}s`);
  await new Promise(resolve => setTimeout(resolve, wait));
}

// The model's tool arguments, from JSON text. Broken JSON gives {}: the
// tool then answers with an error the model can fix, instead of failing the
// turn.
function parseArgs(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
