// The report assistant: what the chat says when this service answers a turn.
// Runs the iteration-1 loop with the conversation so far, and turns a report
// run into an interim message with a pending file.
import { ask } from './llm/loop.js';

const TEXT = {
  making: 'Ik maak het rapport. Het verschijnt hier zodra het klaar is.',
  failed: 'Het rapport is mislukt. Stel de vraag opnieuw, of anders geformuleerd.',
};

// whenProfiles() resolves once the SHACL profiles are loaded (app.js keeps
// the load promise), so the chat mounts before the profiles are in.
export function reportAssistant(whenProfiles) {
  return async function answer(turn) {
    // the pending file of the current run; the end callback needs the one
    // the start callback made. One report per turn: a second run_report in
    // the same turn overwrites this before the first end callback fires.
    let pendingDocument = null;

    const session = {
      query: turn.query,
      groups: turn.groups,
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

// The file service serves /files/<uuid>/download, and the logical file URI
// that registerFile returns ends in that uuid.
function downloadHref(fileUri) {
  return `/files/${fileUri.split('/').pop()}/download`;
}
