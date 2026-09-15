// The tools the LLM calls. Two modes:
// - refine: list_profiles, describe_profile, validate_spec, lookup_values.
//   lookup_values searches a code list under the service scope (public
//   graph) and returns candidate values, so the LLM can suggest concrete
//   filter values. No report is created, no spec is evaluated.
// - execute: list_profiles, describe_profile, validate_spec, run_report.
//   run_report runs as the caller and returns only counts and URIs; no cell
//   value ever reaches the model.
//
// The shape every tool returns is { content: [{ type: 'text', text }] },
// which the loop passes straight back to the model.

import { checkSpec } from '../runner/check.js';
import { parseSpec } from '../runner/spec.js';
import { describeProfile, codeListValues } from './describe.js';
import { lookupValues } from './lookup.js';
import { run, slug } from '../runner/run.js';
import { scopedQuery } from '../db.js';

const MAX_PATH_DEPTH = Number(process.env.MAX_PATH_DEPTH || 8);
const RUN_TIMEOUT = Number(process.env.RUN_TIMEOUT || 60) * 1000;

// buildTools(profiles, session, mode) → { handlers }
export function buildTools(profiles, session, mode = 'refine') {
  const profileList = () => [...profiles.values()].map(p => ({ id: p.uri, title: p.title }));

  const findProfile = (id) => profiles.get(id);

  async function describe_profile({ profile_id }) {
    const p = findProfile(profile_id);
    if (!p) return text(`no profile <${profile_id}>. Available: ${profileList().map(x => x.title).join(', ')}.`);
    const inlined = await codeListValues(p, scopedQuery);
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

  async function list_profiles() {
    return text(profileList().map(x => `${x.title}  <${x.id}>`).join('\n'));
  }

  async function lookup_values({ profile_id, field, term }) {
    const p = findProfile(profile_id);
    if (!p) return text(`no profile <${profile_id}>. Available: ${profileList().map(x => x.title).join(', ')}.`);
    if (!term) return text('no term to search for.');
    try {
      const out = await lookupValues(p, term, field, scopedQuery);
      if (out.error) return text(out.error);
      if (!out.matches.length) return text(`no value matches "${term}" in ${field}.`);
      const lines = out.matches.map(m => `${m.label}  <${m.uri}>`);
      if (out.total === '25+') lines.push('(25+ matches, narrow the term)');
      if (out.exact) lines.push(`exact: <${out.exact}>`);
      return text(lines.join('\n'));
    } catch (e) {
      return text(`the lookup failed: ${String(e.message || e).split('\n')[0]}`);
    }
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
      const running = run(session.query, session.update, parsed, p, name, { spec }, waiter.tick);
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

  const handlers = new Map(
    mode === 'execute'
      ? [
        ['list_profiles', list_profiles],
        ['describe_profile', describe_profile],
        ['validate_spec', validate_spec],
        ['run_report', run_report],
      ]
      : [
        ['list_profiles', list_profiles],
        ['describe_profile', describe_profile],
        ['validate_spec', validate_spec],
        ['lookup_values', lookup_values],
      ],
  );

  return { handlers };
}

function text(s) { return { content: [{ type: 'text', text: s }] }; }

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