// The eight tools the LLM calls. They return a job URI, a status, a count, a
// link, column names or an error we wrote — never a cell value. The shape
// every tool returns is { content: [{ type: 'text', text }] }, which the loop
// passes straight back to the model.

import { checkSpec } from '../runner/check.js';
import { parseSpec } from '../runner/spec.js';
import { seedPageQuery } from '../runner/seed.js';
import { describeProfile, codeListValues } from './describe.js';
import { run, slug } from '../runner/run.js';
import { lookupValues } from './lookup.js';
import { readSpec } from '../runner/csv.js';

const MAX_PATH_DEPTH = Number(process.env.MAX_PATH_DEPTH || 8);
const RUN_TIMEOUT = Number(process.env.RUN_TIMEOUT || 60) * 1000;

// buildTools(profiles, session) → { handlers }
// run_report waits while the run keeps answering: every query that comes
// back (a seed page, a column batch) restarts the RUN_TIMEOUT clock, and
// only that much silence gives up. The batch count is known upfront — the
// subject list is complete after the seed — so a slow run with many small
// batches finishes, however long it takes in total.
export function buildTools(profiles, session) {
  const profileList = () => [...profiles.values()].map(p => ({ id: p.uri, title: p.title }));

  const findProfile = (id) => profiles.get(id);

  async function describe_profile({ profile_id }) {
    const p = findProfile(profile_id);
    if (!p) return text(`no profile <${profile_id}>. Available: ${profileList().map(x => x.title).join(', ')}.`);
    const inlined = await codeListValues(p, profiles);
    return text(describeProfile(p, inlined));
  }

  async function validate_spec({ spec }) {
    let parsed;
    try { parsed = parseSpec(spec); }
    catch (e) { return text(`the spec did not parse: ${e.message}`); }
    const p = findProfile(parsed.profileUri);
    if (!p) return text(`no profile <${parsed.profileUri}>. Available: ${profileList().map(x => x.title).join(', ')}.`);
    const errors = checkSpec(parsed, p, MAX_PATH_DEPTH, profiles);
    return text(errors.length ? errors[0] : 'ok');
  }

  async function lookup_values({ profile_id, field, term }) {
    const p = findProfile(profile_id);
    if (!p) return text(`no profile <${profile_id}>.`);
    const res = await lookupValues(p, term, field);
    return text(JSON.stringify(res));
  }

  async function preview_queries({ spec }) {
    let parsed;
    try { parsed = parseSpec(spec); }
    catch (e) { return text(`the spec did not parse: ${e.message}`); }
    const p = findProfile(parsed.profileUri);
    if (!p) return text(`no profile <${parsed.profileUri}>.`);
    const errors = checkSpec(parsed, p, MAX_PATH_DEPTH, profiles);
    if (errors.length) return text(`the spec is not valid: ${errors[0]}`);
    return text(buildQueriesText(parsed, p));
  }

  async function list_profiles() {
    return text(profileList().map(x => `${x.title}  <${x.id}>`).join('\n'));
  }

  async function run_report({ spec }) {
    let parsed;
    try { parsed = parseSpec(spec); }
    catch (e) { return text(`the spec did not parse: ${e.message}`); }
    const p = findProfile(parsed.profileUri);
    if (!p) return text(`no profile <${parsed.profileUri}>.`);
    const errors = checkSpec(parsed, p, MAX_PATH_DEPTH, profiles);
    if (errors.length) return text(`the spec is not valid: ${errors[0]}`);
    try {
      // The spec's dct:title names the report.
      const name = parsed.title || 'report';
      await session.onReportStart?.({ title: name, fileName: `${slug(name)}.csv` });
      const waiter = newRunWaiter(RUN_TIMEOUT);
      const running = run(session.query, session.update, parsed, p, name, null, { spec }, waiter.tick);
      // The end callback also fires after the wait gave up: the run is not
      // cancelled, the file arrives when it arrives. The .catch keeps a late
      // failure from crashing the process.
      running
        .then((r) => session.onReportEnd?.(null, r), (e) => session.onReportEnd?.(e))
        .catch((e) => console.error('[reports] end callback failed:', e));
      const result = await waiter.finish(running);
      return text(`done. report <${result.reportUri}>, ${result.rowCount} rows, file <${result.fileUri}>.`);
    } catch (e) {
      return text(`the report failed: ${String(e.message || e).split('\n')[0]}`);
    }
  }

  async function report_status({ job_uri }) {
    const r = await session.query(
      `SELECT ?status WHERE { <${job_uri}> <http://www.w3.org/ns/adms#status> ?status } LIMIT 1`);
    const b = r.results.bindings[0];
    if (!b) return text(`no job <${job_uri}>.`);
    const status = b.status.value.split('/').pop();
    let link = '';
    if (status === 'success') {
      const f = await session.query(
        `SELECT ?file WHERE { <${job_uri}> <http://redpencil.data.gift/vocabularies/tasks/resultsContainer> ?c . ?c <http://redpencil.data.gift/vocabularies/tasks/hasFile> ?file } LIMIT 1`);
      const fb = f.results.bindings[0];
      if (fb) link = ` file <${fb.file.value}>.`;
    }
    return text(`status: ${status}.${link}`);
  }

  async function export_spec({ report_uri }) {
    const r = await session.query(
      `SELECT ?specFile WHERE { <${report_uri}> <http://mu.semte.ch/vocabularies/ext/specFile> ?specFile } LIMIT 1`);
    const b = r.results.bindings[0];
    if (!b) return text(`no spec stored on <${report_uri}>.`);
    try {
      return text(readSpec(b.specFile.value));
    } catch {
      return text(`the spec file ${b.specFile.value} is not on disk anymore.`);
    }
  }

  const handlers = new Map([
    ['list_profiles', list_profiles],
    ['describe_profile', describe_profile],
    ['validate_spec', validate_spec],
    ['lookup_values', lookup_values],
    ['preview_queries', preview_queries],
    ['run_report', run_report],
    ['report_status', report_status],
    ['export_spec', export_spec],
  ]);

  return { handlers };
}

function text(s) { return { content: [{ type: 'text', text: s }] }; }

function buildQueriesText(spec, profile) {
  const seed = seedPageQuery(spec, Number(process.env.SEED_PAGE_SIZE || 5000), 0);
  return ['-- seed query', seed, ''].join('\n');
}

// Waits for a report run while it makes progress. tick restarts the silence
// clock; idleMs without a single tick rejects. The run is never cancelled:
// finish's handlers only pass its own settlement on, so a run that answers
// after the wait gave up still delivers through the end callback.
function newRunWaiter(idleMs) {
  let deferred;
  const promise = new Promise((resolve, reject) => { deferred = { resolve, reject }; });
  let settled = false;
  let timer = setTimeout(fail, idleMs);
  function fail() {
    if (settled) return;
    settled = true;
    deferred.reject(new Error(`no query answered for ${idleMs / 1000}s`));
  }
  return {
    tick() {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(fail, idleMs);
    },
    finish(running) {
      running.then(
        (r) => { settled = true; clearTimeout(timer); deferred.resolve(r); },
        (e) => { settled = true; clearTimeout(timer); deferred.reject(e); });
      return promise;
    },
  };
}