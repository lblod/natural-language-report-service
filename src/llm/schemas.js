// The JSON schemas for the eight tools, in the shape the MCP ListTools call
// returns. Keep these short and Dutch-aware: the descriptions are what the
// LLM reads to decide which tool to call.

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
      name: 'lookup_values',
      description: 'Search a code list (too long to inline) for a term. Returns matches, a total, and an exact flag when a label equals the term.',
      inputSchema: {
        type: 'object',
        properties: {
          profile_id: { type: 'string' },
          field: { type: 'string', description: 'The field as "entityLabel.fieldLabel", e.g. "melding.type dossier"' },
          term: { type: 'string', description: 'The Dutch word or name to search for' },
        },
        required: ['profile_id', 'field', 'term'],
      },
    },
    {
      name: 'preview_queries',
      description: 'Show the SPARQL queries the runner would run for a valid spec, as text. Lets you check before running.',
      inputSchema: {
        type: 'object',
        properties: { spec: { type: 'string' } },
        required: ['spec'],
      },
    },
    {
      name: 'run_report',
      description: 'Run a valid spec and return the report URI, the row count and the file URI. Runs as the caller, so it sees only what they may see. Waits up to RUN_TIMEOUT. The report is named by the dct:title in the spec.',
      inputSchema: {
        type: 'object',
        properties: { spec: { type: 'string' } },
        required: ['spec'],
      },
    },
    {
      name: 'report_status',
      description: 'Read the status of a job by its URI, and the file once it succeeds.',
      inputSchema: {
        type: 'object',
        properties: { job_uri: { type: 'string' } },
        required: ['job_uri'],
      },
    },
    {
      name: 'export_spec',
      description: 'Return the Turtle spec that produced a report, by report URI.',
      inputSchema: {
        type: 'object',
        properties: { report_uri: { type: 'string' } },
        required: ['report_uri'],
      },
    },
  ];
}