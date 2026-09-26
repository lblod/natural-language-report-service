// What this service answers a chat turn with. The service is synchronous
// per turn: when the answer is written, every bijlage already exists.
//
// Execute turns skip the LLM loop. The mode classifier says the user wants
// to run the report now; the agreed spec already sits in the conversation
// as a bijlage, so it is read from disk and fed straight to the runner.
// The answer is hard-coded: no extra prompt runs for it. When the run cannot
// happen or fails, the answer is a hard-coded failure message: nothing is
// retried and no spec is rewritten.
import { classifyMode } from './llm/mode.js';
import { ask } from './llm/loop.js';
import { parseSpec } from './runner/spec.js';
import { checkSpec } from './runner/check.js';
import { run, slug } from './runner/run.js';
import { readFileSync } from 'fs';
import { storeSpecFile, registerFileObject } from './chat/attachment-file.js';
import { SPEC_MEDIA_TYPE, ATTACHMENT_TYPES } from './chat/vocab.js';

const TEXT = {
  executed: 'Het rapport is uitgevoerd. De bijlagen staan erbij.',
  noSpec: 'Er is nog geen voorstel om uit te voeren. Beschrijf eerst welk rapport je wilt.',
  invalid: 'Het voorstel is niet meer geldig. Vraag een nieuw voorstel.',
  failed: 'Het rapport kon niet uitgevoerd worden. Probeer het later opnieuw.',
};

const MAX_PATH_DEPTH = Number(process.env.MAX_PATH_DEPTH || 8);
const SHARE_DIR = process.env.SHARE_DIR || '/share';

// The chat mounts before the profiles are in; whenProfiles waits for the load.
export function reportAssistant(whenProfiles) {
  return async function answer(turn) {
    const turns = [...turn.history, { role: 'user', content: turn.content }];
    const profiles = await whenProfiles();

    if (await classifyMode(turns)) {
      try {
        return await runStoredSpec(turn, profiles);
      } catch (e) {
        console.error('[reports] execution failed:', e);
        return TEXT.failed;
      }
    }
    return llmAnswer(turn, turns, profiles);
  };
}

// Execution: the last spec bijlage in the conversation is the agreed spec.
// No prompt runs; the runner gets it straight away.
async function runStoredSpec(turn, profiles) {
  const attachment = lastSpecAttachment(turn.history);
  const content = attachment && readSpecFile(attachment.name);
  if (!content) return TEXT.noSpec;

  const parsed = parseSpec(content);
  const profile = profiles.get(parsed.profileUri);
  if (!profile) {
    console.error(`[reports] no profile <${parsed.profileUri}>`);
    return TEXT.invalid;
  }
  const errors = checkSpec(parsed, profile, MAX_PATH_DEPTH, profiles);
  if (errors.length) {
    console.error(`[reports] the agreed spec is not valid: ${errors[0]}`);
    return TEXT.invalid;
  }

  // The conversation's title (named by the first question) names the file.
  // The report itself keeps the dct:title of the spec.
  const { fileUri } = await run(turn.query, turn.update, parsed, profile,
    parsed.title, {
      spec: content,
      fileType: ATTACHMENT_TYPES.result,
      fileName: `${slug(turn.conversation.title)}.csv`,
    });

  // Same physical spec file, registered as a bijlage for this message.
  const specFile = await registerFileObject(turn.update, {
    fileName: attachment.name,
    format: SPEC_MEDIA_TYPE,
    size: Buffer.byteLength(content),
    type: ATTACHMENT_TYPES.spec,
  });

  return {
    text: TEXT.executed,
    attachments: [
      { uri: fileUri },
      { ...specFile, mediaType: SPEC_MEDIA_TYPE },
    ],
  };
}

function lastSpecAttachment(history) {
  for (const message of [...(history || [])].reverse()) {
    const specs = (message.attachments || []).filter(a =>
      a.mediaType === SPEC_MEDIA_TYPE
      && /^specificatie-[0-9a-f-]+\.ttl$/.test(a.name || ''));
    if (specs.length) return specs[specs.length - 1];
  }
  return null;
}

function readSpecFile(fileName) {
  try {
    return readFileSync(`${SHARE_DIR}/${fileName}`, 'utf8');
  } catch {
    return null;
  }
}

// The LLM loop, refinement only. The spec that checked out goes on the
// answer as a bijlage. The prompt never carries the Turtle.
async function llmAnswer(turn, turns, profiles) {
  // The last spec that checked out; stored as a file for this turn's
  // final message.
  let spec = null;

  const session = {
    onSpecValidated(validated) { spec = validated; },
  };

  const { text } = await ask(turns, profiles, session);

  const attachments = [];
  if (spec) {
    const stored = await storeSpecFile(turn.update, spec);
    attachments.push({ ...stored, mediaType: SPEC_MEDIA_TYPE });
  }
  return { text, attachments };
}
