// What this service answers a chat turn with. The service is synchronous
// per turn: when the answer is written, every bijlage already exists.
//
// Execute turns skip the LLM loop. The mode classifier says the user wants
// to run the report now; the agreed spec already sits in the conversation
// as a bijlage, so it is read from disk and fed straight to the runner.
// The answer is hard-coded: no extra prompt runs for it. When anything on
// the fast path fails, the turn falls back to the LLM loop as before.
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
        console.error('[reports] direct execution failed, falling back to the LLM:', e);
      }
    }
    return llmAnswer(turn, turns, profiles);
  };
}

// The fast path: the last spec bijlage in the conversation is the agreed
// spec. No prompt runs; the runner gets it straight away.
async function runStoredSpec(turn, profiles) {
  const attachment = lastSpecAttachment(turn.history);
  const content = attachment && readSpecFile(attachment.name);
  if (!content) throw new Error('no agreed spec in the conversation');

  const parsed = parseSpec(content);
  const profile = profiles.get(parsed.profileUri);
  if (!profile) throw new Error(`no profile <${parsed.profileUri}>`);
  const errors = checkSpec(parsed, profile, MAX_PATH_DEPTH, profiles);
  if (errors.length) throw new Error(`the agreed spec is not valid: ${errors[0]}`);

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

// The LLM loop, refinement and execute mode. LLM answer with the
// conversation so far; the agreed spec goes on the proposal, and once a
// report runs, its CSV (registered by the runner as a real file) and the
// spec go on the same turn. The prompt never carries the Turtle.
async function llmAnswer(turn, turns, profiles) {
  // The file uri of the executed report, set by the end callback.
  let fileUri = null;
  // The last spec that checked out; stored as a file for this turn's
  // final message.
  let spec = null;

  const session = {
    query: turn.query,
    update: turn.update,
    onSpecValidated(validated) { spec = validated; },
    async onReportEnd(error, result) {
      if (!error && result) fileUri = result.fileUri;
    },
  };

  const { text } = await ask(turns, profiles, session);

  // The bijlagen of this turn, all with a real file behind them: the
  // executed report's CSV first, next the validated spec.
  const attachments = [];
  if (fileUri) attachments.push({ uri: fileUri });
  if (spec) {
    const stored = await storeSpecFile(turn.update, spec);
    attachments.push({ ...stored, mediaType: SPEC_MEDIA_TYPE });
  }
  return { text, attachments };
}
