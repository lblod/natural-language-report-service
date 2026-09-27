// The two answers to a chat turn, as { text, attachments }. Every bijlage
// exists before the answer is written.
//
// Refine: the LLM proposes a spec. The last spec that checked out goes on the
// answer as a bijlage, not in the text.
//
// Execute: no LLM runs, so no LLM ever sees report data. The last spec
// bijlage in the conversation is the agreed spec; it goes straight to the
// runner. The answer is fixed text, also when the run fails: nothing is
// retried and no spec is rewritten.
import { uuid } from 'mu';
import { ask } from './llm/loop.js';
import { parseSpec } from './runner/spec.js';
import { checkSpec } from './runner/check.js';
import { run } from './runner/run.js';
import { storeSpecFile, readSpecFile, writeShareFile, registerFile, registerReport,
         SPEC_MEDIA_TYPE, SPEC_TYPE, RESULT_TYPE } from './chat.js';

const TEXT = {
  executed: 'Het rapport is uitgevoerd. De bijlagen staan erbij.',
  noSpec: 'Er is nog geen voorstel om uit te voeren. Beschrijf eerst welk rapport je wilt.',
  invalid: 'Het voorstel is niet meer geldig. Vraag een nieuw voorstel.',
  failed: 'Het rapport kon niet uitgevoerd worden. Probeer het later opnieuw.',
  noAnswer: 'Er kwam geen antwoord. Probeer het opnieuw.',
};

// An empty answer (a reasoning model can end with no text) gets a fixed
// text and no spec: only a spec the user saw explained may run.
export async function refineSpec(turns, profiles) {
  const { text, spec } = await ask(turns, profiles);
  if (!text.trim()) return { text: TEXT.noAnswer };
  const attachments = spec ? [await storeSpecFile(spec)] : [];
  return { text: text.trim(), attachments };
}

export async function executeSpec(history, conversationTitle, profiles) {
  const attachment = lastSpecAttachment(history);
  const content = attachment && readSpecFile(attachment.name);
  if (!content) return { text: TEXT.noSpec };

  try {
    const spec = parseSpec(content);
    const error = checkSpec(spec, profiles);
    if (error) {
      console.error(`[reports] the agreed spec is not valid: ${error}`);
      return { text: TEXT.invalid };
    }

    // The conversation's title (named by the first question) names the
    // file; the share name is unique, so a second run never overwrites the
    // first. The report itself keeps the dct:title of the spec.
    const shareName = `${uuid()}.csv`;
    writeShareFile(shareName, await run(spec, profiles.get(spec.profileUri)));
    const csvFile = await registerFile(shareName, 'text/csv', RESULT_TYPE, `${slug(conversationTitle)}.csv`);
    await registerReport(spec.title, csvFile);

    // Same physical spec file, registered as a bijlage for this message.
    const specFile = await registerFile(attachment.name, SPEC_MEDIA_TYPE, SPEC_TYPE);

    return { text: TEXT.executed, attachments: [csvFile, specFile] };
  } catch (e) {
    console.error('[reports] execution failed:', e);
    return { text: TEXT.failed };
  }
}

function lastSpecAttachment(history) {
  return history.flatMap(message => message.attachments)
    .filter(a => a.mediaType === SPEC_MEDIA_TYPE).at(-1) || null;
}

function slug(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}
