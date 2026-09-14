// The eight MCP tools the LLM calls. Each maps to a runner/ function or a
// pure profile/db read. Tools that touch session data (run_report,
// report_status, export_spec) live here and call into runner/; they never
// import sessionQuery themselves (CI check 2). What they return is always a
// job URI, a status, a count, a link, column names or an error we wrote,
// never a cell value (CI check 3, the §8 guarantee).
//
// The shape every tool returns is { content: [{ type: 'text', text }] } so the
// loop can pass it straight back to the model.

import { checkSpec } from '../runner/check.js';
import { parseSpec } from '../runner/spec.js';
import { seedPageQuery } from '../runner/seed.js';
import { describeProfile, codeListValues } from './describe.js';
import { run, slug } from '../runner/run.js';
import { lookupValues } from './lookup.js';

const MAX_PATH_DEPTH = Number(process.env.MAX_PATH_DEPTH || 8);
const RUN_TIMEOUT = Number(process.env.RUN_TIMEOUT || 60) * 1000;

// buildTools(profiles, session) → { tools: Tool[], handlers: Map<name, fn> }
// `session` is the request's { query, update, groups, capture } bundle the app
// builds once per /mcp request. run_report captures the identity and runs in
// the background exactly like POST /reports does, but waits up to
// RUN_TIMEOUT so the LLM gets the result in one turn when it is quick.

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
      const g = await session.groups;
      // The spec's own dct:title names the report; there is no other input.
      const name = parsed.title || 'report';
      await session.onReportStart?.({ title: name, fileName: `${slug(name)}.csv` });
      const running = run(g, parsed, p, name);
      // The end callback fires even when withTimeout below has given up: the
      // run is not cancelled, and the file arrives when it arrives. The
      // rejection handler also keeps a late failure from crashing Node 20.
      running
        .then((r) => session.onReportEnd?.(null, r), (e) => session.onReportEnd?.(e))
        .catch((e) => console.error('[reports] end callback failed:', e));
      const result = await withTimeout(running, RUN_TIMEOUT);
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
      `SELECT ?spec WHERE { <${report_uri}> <http://mu.semte.ch/vocabularies/ext/spec> ?spec } LIMIT 1`);
    const b = r.results.bindings[0];
    return text(b ? b.spec.value : `no spec stored on <${report_uri}>.`);
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

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`report took longer than ${ms / 1000}s`)), ms))]);
}