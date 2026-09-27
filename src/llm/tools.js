// The tools the LLM calls, refinement only: list_profiles,
// describe_profile, validate_spec, read_spec and lookup_values. Each returns
// plain text for the model. No report is created, no spec is evaluated; the
// database reads run under the service scope (public graph).
import { parseSpec } from '../runner/spec.js';
import { checkSpec, whereNotes, profileError } from '../runner/check.js';
import { describeProfile } from './describe.js';
import { lookupValues } from './explore.js';
import { readSpecFile } from '../chat.js';

// The tool definitions sent to the model. The descriptions are what the LLM
// reads to decide which tool to call.
export const TOOLS = [
  tool('list_profiles',
    'List the report profiles available, with their id and title.',
    {}),
  tool('describe_profile',
    'Describe one profile: its entities, fields, relations and labels. Inline the values of short code lists.',
    { profile_id: 'The profile URI returned by list_profiles' }),
  tool('validate_spec',
    'Validate a report spec (Turtle). Returns "ok", followed by one line per rep:where saying where it applies, or one clear sentence saying what is wrong and what to write instead. No database is touched.',
    { spec: 'The spec as Turtle text' }),
  tool('read_spec',
    'Return the Turtle of a spec bijlage, a ttl file attached to an earlier message in this conversation. Use it to reuse the agreed spec, or to read back an earlier proposal before you change it. Read-only.',
    { file_name: 'The file name of the spec bijlage, e.g. specificatie-<uuid>.ttl' }),
  tool('lookup_values',
    'Search a code list for a term so you can suggest concrete values for a filter (for sh:hasValue or sh:in). Returns up to 25 matches with their URIs and labels, a total, and an exact flag when a label equals the term. Reads candidate values only; it never runs the spec and never tells you how many subjects a spec would match. Read-only, no report is created.',
    {
      profile_id: 'The profile URI returned by list_profiles',
      field: 'The field as "entityLabel.fieldLabel", e.g. "bestuurseenheid.naam"',
      term: 'The Dutch word or name to search for',
    }),
];

function tool(name, description, params) {
  const properties = {};
  for (const [key, text] of Object.entries(params)) {
    properties[key] = { type: 'string', description: text };
  }
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required: Object.keys(params) },
    },
  };
}

export async function runTool(name, args, profiles) {
  switch (name) {
    case 'list_profiles': return listProfiles(profiles);
    case 'describe_profile': return describe(args, profiles);
    case 'validate_spec': return validateSpec(args, profiles);
    case 'read_spec': return readSpec(args);
    case 'lookup_values': return lookup(args, profiles);
    default: return `unknown tool "${name}"`;
  }
}

function listProfiles(profiles) {
  return [...profiles.values()].map(p => `${p.title}  <${p.uri}>`).join('\n');
}

async function describe({ profile_id }, profiles) {
  return profileError(profiles, profile_id) || describeProfile(profiles.get(profile_id));
}

function validateSpec({ spec }, profiles) {
  let parsed;
  try {
    parsed = parseSpec(spec);
  } catch (e) {
    return `the spec did not parse: ${e.message}`;
  }
  const error = checkSpec(parsed, profiles);
  if (error) return error;
  return ['ok', ...whereNotes(parsed, profiles.get(parsed.profileUri))].join('\n');
}

// Only spec files this service made are readable.
function readSpec({ file_name }) {
  return readSpecFile(file_name) || 'no such spec file.';
}

async function lookup({ profile_id, field, term }, profiles) {
  const error = profileError(profiles, profile_id);
  if (error) return error;
  if (!term) return 'no term to search for.';
  return lookupValues(profiles.get(profile_id), field, term);
}
