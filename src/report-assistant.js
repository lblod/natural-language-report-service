// What this service answers a chat turn with: the LLM loop with the
// conversation so far. The service is synchronous per turn: when the answer
// is written, every bijlage already exists. The agreed spec goes on the
// proposal, and once a report runs, its CSV (registered by the runner as a
// real file) and the spec go on the same turn. The prompt never carries the
// Turtle.
import { ask } from './llm/loop.js';
import { storeSpecFile } from './chat/attachment-file.js';
import { SPEC_MEDIA_TYPE } from './chat/vocab.js';

const TEXT = {
  making: 'Ik maak het rapport. Het verschijnt hier zodra het klaar is.',
};

// The chat mounts before the profiles are in; whenProfiles waits for the load.
export function reportAssistant(whenProfiles) {
  return async function answer(turn) {
    // The file uri of the executed report, set by the end callback.
    let fileUri = null;
    // The last spec that checked out; stored as a file for this turn's
    // final message.
    let spec = null;

    const session = {
      query: turn.query,
      update: turn.update,
      onSpecValidated(validated) { spec = validated; },
      async onReportStart() {
        // Feedback while the run goes on; the report itself lands on the
        // final message in bijlagen.
        await turn.say(TEXT.making);
      },
      async onReportEnd(error, result) {
        if (!error && result) fileUri = result.fileUri;
      },
    };

    const profiles = await whenProfiles();
    const { text } = await ask([...turn.history, { role: 'user', content: turn.content }], profiles, session);

    // The bijlagen of this turn, all with a real file behind them: the
    // executed report's CSV first, next the validated spec.
    const attachments = [];
    if (fileUri) attachments.push({ uri: fileUri });
    if (spec) {
      const stored = await storeSpecFile(turn.update, spec);
      attachments.push({ ...stored, mediaType: SPEC_MEDIA_TYPE });
    }
    return { text, attachments };
  };
}
