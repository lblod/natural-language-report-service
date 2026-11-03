import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import { loadProfiles } from './src/runner/profile.js';
import { readConversation, readHistory, writeMessage, deleteConversation, readReportSpec, readSessionMaker, getSessionUri } from './src/chat.js';
import { wantsExecution } from './src/llm/mode.js';
import { describeReport } from './src/llm/summary.js';
import { prepareExecution, executeSpec, refineSpec, prepareSavedSpec, executeSavedSpec } from './src/report-assistant.js';

const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profiles';
// The agent that signs the assistant's messages, seeded by the portal's
// chat-assistant migration.
const CHAT_ASSISTANT_URI = process.env.CHAT_ASSISTANT_URI || 'http://data.lblod.info/id/chat-agents/report-assistant';
const TITLE_LENGTH = 80;
const FAILED = 'Er ging iets mis. Probeer het opnieuw.';

// Profiles load at boot. A broken profile stops the service.
const profiles = loadProfiles(PROFILE_DIR);

// One chat turn. Records the question, answers 202, then writes the
// assistant's answer; the frontend polls the conversation for it. A turn
// takes several LLM calls, too long to keep the request open. mu's
// query/update run as the caller for the whole turn, also after the 202.
// The template only parses application/vnd.api+json, the chat sends
// application/json.
app.post('/assistant/conversations/:id/turns', bodyParser.json(), async function(req, res) {
  const content = String(req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });

  let conversation, history, questionId;
  try {
    // the access check: the caller's session decides what is readable
    conversation = await readConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'no such conversation' });
    history = await readHistory(conversation.uri, CHAT_ASSISTANT_URI);
    questionId = await writeMessage({
      conversationUri: conversation.uri,
      content,
      maker: conversation.creator,
      title: conversation.title ? undefined : content.slice(0, TITLE_LENGTH),
    });
  } catch (e) {
    console.error('[chat] could not record the question:', e);
    return res.status(500).json({ error: e.message });
  }

  res.status(202).json({ id: questionId });

  try {
    const turns = [...history, { role: 'user', content }];
    let answer;
    if (await wantsExecution(turns)) {
      const prepared = prepareExecution(history, profiles);
      if (!prepared.spec) {
        answer = prepared;
      } else {
        // The description is written from the conversation right before the
        // run, outside the execution itself.
        const description = await describeReport(history, prepared.spec.title || conversation.title);
        answer = await executeSpec(prepared, conversation, profiles, description);
      }
    } else {
      answer = await refineSpec(turns, profiles);
    }
    await writeMessage({
      conversationUri: conversation.uri,
      content: answer.text,
      maker: CHAT_ASSISTANT_URI,
      attachments: answer.attachments,
    });
  } catch (e) {
    console.error('[chat] turn failed:', e);
    try {
      await writeMessage({ conversationUri: conversation.uri, content: FAILED, maker: CHAT_ASSISTANT_URI });
    } catch (e2) {
      console.error('[chat] could not write the failure message:', e2);
    }
  }
});

// Delete a conversation with everything that hangs off it: the messages,
// their bijlagen (triples and share files) and the reports. The read is the
// access check: the caller's session decides what exists, so another user's
// conversation is a 404.
app.delete('/assistant/conversations/:id', async function(req, res) {
  try {
    const conversation = await readConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'no such conversation' });
    const removed = await deleteConversation(conversation.uri);
    console.log(`[chat] deleted conversation ${req.params.id}, ${removed} share file(s) removed`);
    res.status(204).send();
  } catch (e) {
    console.error('[chat] could not delete the conversation:', e);
    res.status(500).json({ error: e.message });
  }
});

// Run a saved report spec again, outside the chat. The checks answer at
// once: 404 when the caller cannot read the spec, 422 when its spec file is
// gone or no longer checks out against the profiles. Then 202, and the run
// goes on as the caller: a large report takes minutes, too long to keep the
// request open. The new report shows up in the reports list; a failed run
// is only logged.
app.post('/assistant/report-specs/:id/run', async function(req, res) {
  let reportSpec, prepared;
  try {
    // the access check: the caller's session decides what is readable
    reportSpec = await readReportSpec(req.params.id);
    if (!reportSpec) return res.status(404).json({ error: 'no such report spec' });
    prepared = prepareSavedSpec(reportSpec, profiles);
  } catch (e) {
    console.error('[reports] could not prepare the run:', e);
    return res.status(500).json({ error: e.message });
  }
  if (prepared.error) {
    console.error(`[reports] report spec ${req.params.id} cannot run: ${prepared.error}`);
    return res.status(422).json({ error: prepared.error });
  }

  res.status(202).send();

  try {
    // A missing or unresolvable session person must not stop the run: the
    // report is then written with no prov:wasAttributedTo.
    const creator = await readSessionMaker(getSessionUri(req)).catch(e => {
      console.error('[reports] could not resolve the session user:', e);
      return null;
    });
    await executeSavedSpec(prepared.spec, reportSpec, profiles, creator);
    console.log(`[reports] ran report spec ${req.params.id}`);
  } catch (e) {
    console.error(`[reports] run of report spec ${req.params.id} failed:`, e);
  }
});

app.use(errorHandler);
