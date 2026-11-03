// The two answers to a chat turn, as { text, attachments }. Every bijlage
// exists before the answer is written.
//
// Refine: the LLM proposes a spec. The last spec that checked out goes on the
// answer as a bijlage, not in the text.
//
// Execute: the last spec bijlage in the conversation is the agreed spec; it
// goes straight to the runner. The answer is fixed text, also when the run
// fails: nothing is retried and no spec is rewritten. The caller writes the
// report's description right before the run, so execution holds no LLM call.
//
// A saved spec can also run again outside the chat: prepareSavedSpec and
// executeSavedSpec, for the report spec tab.
import { uuid } from 'mu';
import { ask } from './llm/loop.js';
import { parseSpec } from './runner/spec.js';
import { checkSpec } from './runner/check.js';
import { runReport } from './runner/run.js';
import { storeSpecFile, readSpecFile, writeShareFile, registerFile, registerReport,
         registerReportSpec, SPEC_MEDIA_TYPE, SPEC_TYPE, RESULT_TYPE } from './chat.js';

const TEXT = {
  executed: 'Het rapport is uitgevoerd. De bijlagen staan erbij.',
  noSpec: 'Er is nog geen voorstel om uit te voeren. Beschrijf eerst welk rapport je wilt.',
  invalid: 'Het voorstel is niet meer geldig. Vraag een nieuw voorstel.',
  failed: 'Het rapport kon niet uitgevoerd worden. Probeer het later opnieuw.',
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

// The agreed spec of the conversation, parsed and checked against its
// profile. A failure is fixed text with no spec: only a spec the user saw
// explained may run.
export function prepareExecution(history, profiles) {
  const attachment = findLastSpecAttachment(history);
  const content = attachment && readSpecFile(attachment.name);
  if (!content) return { text: TEXT.noSpec };

  try {
    const spec = parseSpec(content);
    const error = checkSpec(spec, profiles);
    if (error) {
      console.error(`[reports] the agreed spec is not valid: ${error}`);
      return { text: TEXT.invalid };
    }
    return { spec, attachment };
  } catch (e) {
    console.error('[reports] could not prepare the run:', e);
    return { text: TEXT.failed };
  }
}

// Runs a prepared spec as the user and records its report. The description
// comes from the caller, which writes it from the conversation right before
// this call: execution never talks to the LLM and never sees report data.
export async function executeSpec({ spec, attachment }, conversation, profiles, description) {
  try {
    // The conversation's title (named by the first question) names the
    // file; the share name is unique, so a second run never overwrites the
    // first. The report itself keeps the dct:title of the spec.
    const shareName = `${uuid()}.csv`;
    writeShareFile(shareName, await runReport(spec, profiles.get(spec.profileUri)));
    const csvFile = await registerFile(shareName, 'text/csv', RESULT_TYPE, `${slugify(conversation.title)}.csv`);

    // Same physical spec file, registered as a bijlage for this message.
    // The ReportSpec points at it, so the spec can run again later.
    const specFile = await registerFile(attachment.name, SPEC_MEDIA_TYPE, SPEC_TYPE);

    const specUri = await registerReportSpec(spec.title, description, conversation.uri, specFile);
    // The conversation's maker ran the spec: conversations are per user, so
    // it is also the caller.
    await registerReport(spec.title, csvFile, description, specUri, conversation.creator);

    return { text: TEXT.executed, attachments: [csvFile, specFile] };
  } catch (e) {
    console.error('[reports] execution failed:', e);
    return { text: TEXT.failed };
  }
}

// A saved ReportSpec, ready to run again: its Turtle file read, parsed and
// checked against the profiles as they are now. Returns { spec }, or
// { error } with one sentence saying why it cannot run. The route calls it
// before its 202, so the user hears that at once.
export function prepareSavedSpec(reportSpec, profiles) {
  const content = readSpecFile(reportSpec.specFileName);
  if (!content) return { error: 'this report spec has no spec file' };
  try {
    const spec = parseSpec(content);
    const error = checkSpec(spec, profiles);
    return error ? { error } : { spec };
  } catch (e) {
    return { error: `the spec file did not parse: ${e.message}` };
  }
}

// Runs a prepared saved spec again as the user, outside the chat, and
// records a new report that conforms to the same ReportSpec. No LLM: the
// new report keeps the ReportSpec's description. creatorUri is the person
// who runs it, from the route's session. Throws when the run fails.
export async function executeSavedSpec(spec, reportSpec, profiles, creatorUri) {
  const shareName = `${uuid()}.csv`;
  writeShareFile(shareName, await runReport(spec, profiles.get(spec.profileUri)));
  const csvFile = await registerFile(shareName, 'text/csv', RESULT_TYPE, `${slugify(spec.title)}.csv`);
  await registerReport(spec.title, csvFile, reportSpec.description, reportSpec.uri, creatorUri);
}

// The newest spec bijlage in the history, or null. The agreed spec is the
// last one the user saw.
function findLastSpecAttachment(history) {
  return history.flatMap(message => message.attachments)
    .filter(a => a.mediaType === SPEC_MEDIA_TYPE).at(-1) || null;
}

// A file name from the conversation title, so the CSV downloads under a
// readable name. Falls back to "report".
function slugify(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}
