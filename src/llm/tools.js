// The tools the LLM calls, refinement only: list_profiles, describe_profile,
// validate_spec, lookup_values, read_spec. lookup_values searches a code list
// under the service scope (public graph) and returns candidate values, so the
// LLM can suggest concrete filter values. No report is created, no spec is
// evaluated.
//
// The shape every tool returns is { content: [{ type: 'text', text }] },
// which the loop passes straight back to the model.

import { checkSpec, whereNotes } from '../runner/check.js';
import { parseSpec } from '../runner/spec.js';
import { describeProfile, codeListValues } from './describe.js';
import { lookupValues } from './lookup.js';
import { scopedQuery } from '../db.js';
import { readFileSync } from 'fs';

const MAX_PATH_DEPTH = Number(process.env.MAX_PATH_DEPTH || 8);

// buildTools(profiles, session) → { handlers }
export function buildTools(profiles, session) {
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
    if (errors.length) return text(errors[0]);
    // The spec that checks out becomes the attached proposal.
    session.onSpecValidated?.(spec);
    return text(['ok', ...whereNotes(parsed, p)].join('\n'));
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

  // A spec bijlage next to a message. The model opens it with read_spec:
  // only files this service made are readable, hte spec files under share.
  async function read_spec({ file_uri }) {
    const fileName = String(file_uri || '').split('/').pop();
    if (!fileName || !/^specificatie-[0-9a-f]{8}-[0-9a-f-]{27}\.ttl$/.test(fileName)) {
      return text('no such spec file.');
    }
    const shareDir = process.env.SHARE_DIR || '/share';
    try {
      return text(readFileSync(`${shareDir}/${fileName}`, 'utf8'));
    } catch (e) {
      return text(`the spec failed to load: ${String(e.message || e).split('\n')[0]}`);
    }
  }

  const handlers = new Map(
    [
      ['list_profiles', list_profiles],
      ['describe_profile', describe_profile],
      ['validate_spec', validate_spec],
      ['read_spec', read_spec],
      ['lookup_values', lookup_values],
    ],
  );

  return { handlers };
}

function text(s) { return { content: [{ type: 'text', text: s }] }; }
