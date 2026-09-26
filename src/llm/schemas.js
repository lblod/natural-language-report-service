// The JSON schemas of the tools. The descriptions are what the LLM reads to
// decide which tool to call. Refinement only: list_profiles,
// describe_profile, validate_spec, read_spec and lookup_values.

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

const READ_SPEC = {
  name: 'read_spec',
  description: 'Return the Turtle of a spec bijlage, a ttl file attached to an earlier message in this conversation. Use it to reuse the agreed spec, or to read back an earlier proposal before you change it. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { file_uri: { type: 'string', description: 'The file URI of the spec bijlage, e.g. http://data.lblod.info/files/<uuid>' } },
    required: ['file_uri'],
  },
};

export function toolSchemas() {
  return [...COMMON, READ_SPEC, LOOKUP_VALUES];
}