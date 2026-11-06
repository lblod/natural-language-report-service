// The two answers to a chat turn, as { text, attachments }. Every bijlage
// exists before the answer is written.
//
// Refine: the LLM proposes a spec. The last spec that checked out goes on the
// answer as a bijlage, not in the text.
//
// Execute: the last spec bijlage in the conversation is the agreed spec; it
// goes straight to the runner. The answer is fixed text; nothing is retried
// and no spec is rewritten. The caller writes the report's description right
// before the run, so execution holds no LLM call.
//
// A saved spec can also run again outside the chat, for the report spec tab:
// prepareSpec reads and checks it, runSavedSpec runs it.
import { uuid } from 'mu';
import { ask } from './llm/loop.js';
import { parseSpec } from './runner/spec.js';
import { checkSpec } from './runner/check.js';
import { runReport } from './runner/run.js';
import { storeSpecFile, readSpecFile, writeShareFile, registerFile, registerReport,
         registerReportSpec, SPEC_MEDIA_TYPE, RESULT_TYPE } from './chat.js';

const TEXT = {
  executed: 'Het rapport is uitgevoerd. De bijlagen staan erbij.',
  noSpec: 'Er is nog geen voorstel om uit te voeren. Beschrijf eerst welk rapport je wilt.',
  invalid: 'Het voorstel is niet meer geldig. Vraag een nieuw voorstel.',
  noAnswer: 'Er kwam geen antwoord. Probeer het opnieuw.',
};

// One refine turn: the LLM answers, and the spec it validated is stored and
// attached to that answer as a bijlage. An empty answer (a reasoning model
// can end with no text) gets a fixed text and no spec: only a spec the user
// saw explained may run.
export async function refineSpec(turns, profiles) {
  const { text, spec } = await ask(turns, profiles);
  if (!text.trim()) return { text: TEXT.noAnswer };
  const attachments = spec ? [await storeSpecFile(spec)] : [];
  return { text: text.trim(), attachments };
}

// A spec file read, parsed and checked against the profiles as they are
// now. Returns { spec }, or { error } with one sentence saying why it cannot
// run. The chat and the spec tab both go through here.
export function prepareSpec(fileName, profiles) {
  const content = readSpecFile(fileName);
  if (!content) return { error: 'this report spec has no spec file' };
  let spec;
  try {
    spec = parseSpec(content);
  } catch (e) {
    return { error: `the spec file did not parse: ${e.message}` };
  }
  const error = checkSpec(spec, profiles);
  return error ? { error } : { spec };
}

// The agreed spec of the conversation, the last spec bijlage, prepared. A
// failure is fixed text with no spec: only a spec the user saw explained may
// run.
export function prepareExecution(history, profiles) {
  const attachment = findLastSpecAttachment(history);
  if (!attachment) return { text: TEXT.noSpec };
  const { spec, error } = prepareSpec(attachment.name, profiles);
  if (error) {
    console.error(`[reports] the agreed spec cannot run: ${error}`);
    return { text: TEXT.invalid };
  }
  return { spec, attachment };
}

// Runs a prepared spec as the user and records its ReportSpec and report.
// The description comes from the caller, which writes it from the
// conversation right before this call: execution never talks to the LLM and
// never sees report data. The spec bijlage the user agreed to goes on this
// answer too, and the ReportSpec points at it, so the spec can run again
// later. A failed run throws; the route then writes its failure text.
export async function executeSpec({ spec, attachment }, conversation, profiles, description) {
  const csvFile = await runSpec(spec, profiles);
  const specUri = await registerReportSpec(spec.title, description, conversation.uri, attachment.uri);
  await registerReport(spec.title, csvFile, description, specUri);
  return { text: TEXT.executed, attachments: [csvFile, attachment.uri] };
}

// Runs a saved spec again as the user, outside the chat, and records a new
// report that conforms to the same ReportSpec. No LLM: the new report keeps
// the ReportSpec's description. Throws when the run fails.
export async function runSavedSpec(spec, reportSpec, profiles) {
  const csvFile = await runSpec(spec, profiles);
  await registerReport(spec.title, csvFile, reportSpec.description, reportSpec.uri);
}

// Runs a spec as the user, writes the CSV to the share and registers it as a
// result file, named after the spec's title so it downloads under a readable
// name. Returns the logical file uri. The share name is unique, so a second
// run never overwrites the first.
async function runSpec(spec, profiles) {
  const shareName = `${uuid()}.csv`;
  writeShareFile(shareName, await runReport(spec, profiles.get(spec.profileUri)));
  return registerFile(shareName, 'text/csv', RESULT_TYPE, `${slugify(spec.title)}.csv`);
}

// The newest spec bijlage in the history, or null. The agreed spec is the
// last one the user saw.
function findLastSpecAttachment(history) {
  return history.flatMap(message => message.attachments)
    .filter(a => a.mediaType === SPEC_MEDIA_TYPE).at(-1) || null;
}

// A file name from a title. Falls back to "report".
function slugify(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}
