// The JSON schemas of the four tools. The descriptions are what the LLM
// reads to decide which tool to call.

export function toolSchemas() {
  return [
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
    {
      name: 'run_report',
      description: 'Run a valid spec and return the report URI, the row count and the file URI. Runs as the caller, so it sees only what they may see. Waits as long as the run keeps answering; gives up after RUN_TIMEOUT seconds of silence. The report is named by the dct:title in the spec. Call this once per question, after validate_spec returns ok.',
      inputSchema: {
        type: 'object',
        properties: { spec: { type: 'string' } },
        required: ['spec'],
      },
    },
  ];
}