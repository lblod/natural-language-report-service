// What this service answers a chat turn with: the LLM loop with the
// conversation so far, and a report run becomes an interim message with a
// pending file.
import { ask } from './llm/loop.js';

const TEXT = {
  making: 'Ik maak het rapport. Het verschijnt hier zodra het klaar is.',
  failed: 'Het rapport is mislukt. Stel de vraag opnieuw, of anders geformuleerd.',
};

// The chat mounts before the profiles are in; whenProfiles waits for the load.
export function reportAssistant(whenProfiles) {
  return async function answer(turn) {
    // One pending file per turn: a second run_report overwrites it before the
    // first end callback fires.
    let pendingDocument = null;

    const session = {
      query: turn.query,
      update: turn.update,
      async onReportStart({ fileName }) {
        const said = await turn.say(TEXT.making, [{ name: fileName, mediaType: 'text/csv' }]);
        pendingDocument = said.documents[0].uri;
      },
      async onReportEnd(error, result) {
        const documentUri = pendingDocument;
        pendingDocument = null;
        if (!documentUri) return;
        if (error) {
          await turn.drop(documentUri);
          if (turn.finished) await turn.say(TEXT.failed);
          return;
        }
        await turn.setUrl(documentUri, downloadHref(result.fileUri));
      },
    };

    const profiles = await whenProfiles();
    const { text } = await ask([...turn.history, { role: 'user', content: turn.content }], profiles, session);
    return text;
  };
}

// The file service serves /files/<uuid>/download; the logical file URI ends
// in that uuid.
function downloadHref(fileUri) {
  return `/files/${fileUri.split('/').pop()}/download`;
}
