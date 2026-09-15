// The JSON schemas of the tools. The descriptions are what the LLM reads to
// decide which tool to call. Two modes share three tools (list_profiles,
// describe_profile, validate_spec); refine adds lookup_values, execute adds
// run_report.

const COMMON = [
  {
    name: 'list_profiles',
    description: 'List the report profiles available, with their id and title.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'describe_profile',
    description: 'Describe one profile: its entities, fields, relations and labels. Inline the values of short code lists.',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string', description: 'The profile URI returned by list_profiles' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'validate_spec',
    description: 'Validate a report spec (Turtle). Returns "ok" or one clear sentence saying what is wrong and what to write instead. No database is touched.',
    inputSchema: {
      type: 'object',
      properties: { spec: { type: 'string', description: 'The spec as Turtle text' } },
      required: ['spec'],
    },
  },
];

const LOOKUP_VALUES = {
  name: 'lookup_values',
  description: 'Search a code list for a term so you can suggest concrete values for a filter (for sh:hasValue or sh:in). Returns up to 25 matches with their URIs and labels, a total, and an exact flag when a label equals the term. Reads candidate values only; it never runs the spec and never tells you how many subjects a spec would match. Read-only, no report is created.',
  inputSchema: {
    type: 'object',
    properties: {
      profile_id: { type: 'string', description: 'The profile URI returned by list_profiles' },
      field: { type: 'string', description: 'The field as "entityLabel.fieldLabel", e.g. "bestuurseenheid.naam"' },
      term: { type: 'string', description: 'The Dutch word or name to search for' },
    },
    required: ['profile_id', 'field', 'term'],
  },
};

const RUN_REPORT = {
  name: 'run_report',
  description: 'Run a valid spec and return the report URI, the row count and the file URI. Runs as the caller, so it sees only what they may see. Waits as long as the run keeps answering; gives up after RUN_TIMEOUT seconds of silence. The report is named by the dct:title in the spec. Call this once per question, after validate_spec returns ok. You never see the report data, only the count and URIs.',
  inputSchema: {
    type: 'object',
    properties: { spec: { type: 'string' } },
    required: ['spec'],
  },
};

export function toolSchemas(mode = 'refine') {
  if (mode === 'execute') return [...COMMON, RUN_REPORT];
  return [...COMMON, LOOKUP_VALUES];
}