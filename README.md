# natural-language-report-service

A user asks for a report in Dutch. An LLM turns the question into a spec. A
fixed program turns the spec into small SPARQL queries, joins the results and
writes a CSV. The LLM writes no SPARQL and sees no report data.

Ad-hoc reports only. The scheduled reports stay in
`loket-report-generation-service`.

## Two modes: refine, then execute

Every turn is classified first. One small LLM call (`src/llm/mode.js`)
returns true/false: does the user's last message clearly say "run it now" or
not. The answer picks one of two deterministic code paths.

**Refinement (Modus A).** The LLM proposes a spec and explains in Dutch what
it will list and filter. It may call `lookup_values` to search code lists for
candidate values, so its filter suggestions name real values instead of
guesses, `explore_data` to see the predicates, values and links of a target
class, and `sample_spec` to see a few rows a draft spec finds. All three read
the public graph only, under the service scope. The LLM never runs a report
and never learns what the report would hold: the report runs as the user, on
data the LLM may not see, so a sample is a hint, not a check. The user must confirm before anything executes.
As long as the user has not given a clear command, the turn stays in this
mode.

**Execution (Modus B).** The user has confirmed. No LLM runs. The last spec
bijlage in the conversation is the agreed spec: the service reads it from the
share, checks it against its profile and runs it as the caller. The answer is
a fixed Dutch text with the CSV and the spec as bijlagen. No spec yet, a spec
that no longer checks out, or a failed run each give a fixed Dutch failure
message. Nothing is retried and no spec is rewritten.

Only refinement has tools: `list_profiles`, `describe_profile`,
`validate_spec`, `read_spec`, `lookup_values`, `explore_data` and
`sample_spec`.

## How it works

Two documents drive everything:

| | Who writes it | When | Where |
|---|---|---|---|
| **profile** | the app | once, committed | `config/report-profiles/*.ttl`, mounted at `/config/profiles/` |
| **spec** | the LLM | one per question | in the request, not stored |

A **profile** is a SHACL shapes graph: one `sh:NodeShape` per entity, fields
as `sh:property`, code lists via `sh:class`, links via `sh:node`. The service
ships no profile and knows no vocabulary; profiles live in the app repo.
Profiles load at boot; a broken profile stops the service.

A **spec** is `rep:ReportSpec` + `sh:NodeShape`: `sh:property` selects the
subjects, `rep:columns` says what the CSV holds. The two never interact. The
namespace is `http://mu.semte.ch/vocabularies/reporting/` (`rep:`).

A filter tests only the end of its own path. To test a node in the middle of
a path ("the mandate whose role is Burgemeester"), a filter or column carries
`rep:where`: a condition written like a filter, from the row, that shares the
nodes of every step it has in common with its host. On a column it drops
values from the cell, never rows. The app's `report-spec-readme.md` has the
details and an example.

The run: check → seed (`SELECT DISTINCT ?s`, paged) → columns (per group, per
chunk of subjects, with the nodes on each path) → assemble (pair by the
nodes columns share, on every step; `rep:collect`) → CSV → register file
+ report resource. One run per confirmed spec.

## One identity: mu-authorization's

All SPARQL goes through the template's own helpers (`mu`'s `query` and
`update`). They attach the caller's session from
the request context, and mu-authorization decides graphs and visibility; the
service never touches an auth header. The context lives for the whole run,
also past the `202` the chat turn answers with, so background writes stay
the caller's.

The tools the LLM calls return URIs, counts, statuses and column names —
never a cell value.

### The rule: no report data reaches the LLM

No report row, row count or run error ever reaches the LLM. A run starts
after the turn's only LLM call (the mode check) and answers with fixed text.
What the LLM does see: the conversation, the profiles, validator messages,
spec files, and public data read under the service scope (inlined code
lists, `lookup_values`, `explore_data` and `sample_spec`, see below).

Keep it that way. Every database read the LLM drives goes through
`publicQuery` (the service scope), never the caller's session, and none of
them counts. `sample_spec` runs a draft spec's queries on the public graph
only; it is not the report. `validate_spec` still says where each
`rep:where` applies, and the proposal repeats it to the user.

### The service scope

The LLM's own reads during refinement (`describe_profile`'s code lists,
`lookup_values`, `explore_data` and `sample_spec`) run under a service
scope, not the caller's session: `publicQuery` in `src/llm/explore.js`. mu's
`query(q, { scope })` sends `mu-auth-scope`; the sparql-parser config grants
that scope read access to `http://mu.semte.ch/graphs/public` only. So
refinement reads only the public graph, regardless of who calls. Execution
still runs as the caller, so the report contains what they may see, and the
LLM sees none of it.

The scope URI is `SERVICE_SCOPE` (default
`http://services.semantic.works/natural-language-report`) and must match the
`with-scope` grant in the app's sparql-parser `config.lisp`. Do not set
`DEFAULT_MU_AUTH_SCOPE` on the service: that would scope every query
(including the run and the chat store) and break them.

## The endpoint

```
POST /assistant/conversations/:id/turns      { content }           → 202 { id }
```

This is the chat. The route is in `app.js`: it records the question, answers
`202` with the message id, then classifies the turn and refines or executes
(`src/report-assistant.js`) with the conversation's history. The
conversation, message and bijlage reads and writes are in `src/chat.js`. The
answer and its bijlagen are written when the turn ends. The browser polls
`/chat-conversations/:id?include=messages.attachments` and finds the answer
that way. Failure is a message, never a silent loader.

The chat needs `LLM_BASE_URL`; without it every turn answers with a failure
message. A full-org report run takes minutes.

### The internal tools

The refinement loop drives one tool set (`src/llm/tools.js`). The tools are
machinery, not an external surface. All LLM-facing text (system prompts,
profile menu, tool descriptions, validator errors) is English; the answer the
user sees is Dutch.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `MU_SPARQL_ENDPOINT` | — | the auth layer, e.g. `http://database:8890/sparql`. Never virtuoso. |
| `REPORT_CLASS` | `…/reporting/Report` | type of the report resource |
| `CSV_SEPARATOR` | `;` | CSV column separator |
| `SUBJECT_CHUNK_SIZE` | `100` | subjects per column query (VALUES batch size); lower it when the auth layer rejects long queries |
| `ROW_LIMIT` | `200000` | seed limit; failing the job beats truncating |
| `MAX_PATH_DEPTH` | `8` | longest allowed spec path |
| `INLINE_VALUES_MAX` | `50` | code lists up to this size are inlined in `describe_profile` |
| `VALUES_TTL` | `3600` | seconds the inlined lists are cached |
| `LLM_BASE_URL` | — | the chat's LLM; OpenAI-compatible (`https://ollama.com/v1`) |
| `LLM_MODEL` | — | e.g. `gpt-oss:120b` |
| `LLM_API_KEY` | — | bearer token, optional for local Ollama |
| `SEED_PAGE_SIZE` | `5000` | seed page size |
| `SUBJECT_CHUNK_SIZE` | `100` | see above |
| `SHARE_DIR` | `/share` | where CSVs are written |
| `CHAT_ASSISTANT_URI` | `http://data.lblod.info/id/chat-agents/rapportassistent` | the `prov:SoftwareAgent` that signs assistant messages (the portal's chat-assistant migration seeds it) |
| `CHAT_HISTORY_LIMIT` | `20` | messages of history a turn reads |
| `SERVICE_SCOPE` | `http://services.semantic.works/natural-language-report` | the mu-auth-scope for the LLM's own reads (code lists, `lookup_values`, `explore_data`, `sample_spec`). Must match the `with-scope` grant in the app's sparql-parser config. |

Do not set `ALLOW_MU_AUTH_SUDO`; the template then refuses sudo queries.

## In the stack

`docker-compose.yml`:

```yaml
natural-language-report:
  build: ../natural-language-report-service/
  image: lblod/natural-language-report-service:0.2.0
  volumes:
    - ./data/files:/share
    - ./config/report-profiles/:/config/profiles/
```

`config/dispatcher/dispatcher.ex`:

```elixir
match "/assistant/*path" do
  forward conn, path, "http://natural-language-report/assistant/"
end
```

One route: the chat's turn endpoint.
First deploy: `docker compose build natural-language-report`, then
`docker compose up -d natural-language-report dispatcher`.

## Authorization

Admin only: `config.ex` grants `reporting:Report` to `LoketAdmin` (`o-admin-rwf`)
alone. A toezicht user can run the seed and read the CSV data, but the
`reporting:Report` triples are silently dropped by the auth layer (their group
may not write that type), so the report URI the tools return is dangling for
non-admin callers. Opening this up means adding the type to their group first.

## Rules the code holds to

- Query `http://database:8890/sparql`. Never virtuoso. Never sudo.
- No `GRAPH` clauses, no property paths, no aggregates, no inline comments:
  mu-authorization is a SPARQL 1.0 subset.
- Generated queries use full URIs, no prefixes (a bare `mu:uuid` prefixed
  name without its PREFIX line is an opaque 500).

## Libraries

- `n3` — Turtle parsing (profiles, specs)
- hand-written: CSV writer (quotes only when needed), the query builders,
  the agent loop (bare `fetch`, no provider SDK)

## What it will not do

No counting, no sorting, no top-N, no comparing two subjects, one class per
report, suggestions stop at the public graph.