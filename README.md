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
guesses. It never runs a report and never learns what a spec would match: the
database it reads may differ from the one the report runs on, so a lookup is
a suggestion, not a check. The user must confirm before anything executes.
As long as the user has not given a clear command, the turn stays in this
mode.

**Execution (Modus B).** The user has confirmed. The LLM writes the agreed
spec, validates it and calls `run_report` once, then stops. `run_report`
returns only the report URI, the row count and the file URI. No cell value
ever reaches the model; the service may count results, but no data is fed
to the LLM.

The two modes share `list_profiles`, `describe_profile` and `validate_spec`.
Refinement adds `lookup_values`; execution adds `run_report`. The tool set is
the only thing that differs; the code path from the classifier's answer is
deterministic.

## How it works

Two documents drive everything:

| | Who writes it | When | Where |
|---|---|---|---|
| **profile** | the app | once, committed | `config/report-profiles/*.ttl`, mounted at `/config/profiles/` |
| **spec** | the LLM | one per question | in the request, not stored |

A **profile** is a SHACL shapes graph: one `sh:NodeShape` per entity, fields
as `sh:property`, code lists via `sh:class`, links via `sh:node`. The service
ships no profile and knows no vocabulary; profiles live in the app repo.

A **spec** is `rep:ReportSpec` + `sh:NodeShape`: `sh:property` selects the
subjects, `rep:columns` says what the CSV holds. The two never interact. The
namespace is `http://mu.semte.ch/vocabularies/reporting/` (`rep:`).

The run: check → seed (`SELECT DISTINCT ?s`, paged) → columns (per group, per
chunk of subjects) → assemble (dedup + `rep:collect`) → CSV → register file
+ report resource. One run per question; the loop stops after `run_report`
returns.

## One identity: mu-authorization's

All SPARQL goes through the template's own helpers (`mu`'s `query` and
`update`). They attach the caller's session from
the request context, and mu-authorization decides graphs and visibility; the
service never touches an auth header. The context lives for the whole run,
also past the `202` the chat turn answers with, so background writes stay
the caller's.

The tools the LLM calls return URIs, counts, statuses and column names —
never a cell value.

### The service scope

The LLM's own reads during refinement (`describe_profile`'s code lists and
`lookup_values`) run under a service scope, not the caller's session. mu's
`query(q, { scope })` sends `mu-auth-scope`; the sparql-parser config grants
that scope read access to `http://mu.semte.ch/graphs/public` only. So
refinement reads only public code lists, regardless of who calls. Execution
(`run_report`) still runs as the caller, so the report contains what they may
see, and the LLM sees none of it.

The scope URI is `SERVICE_SCOPE` (default
`http://services.semantic.works/natural-language-report`) and must match the
`with-scope` grant in the app's sparql-parser `config.lisp`. Do not set
`DEFAULT_MU_AUTH_SCOPE` on the service: that would scope every query
(including the run and the chat store) and break them.

## Two endpoints

```
POST /ask                                     { question, history? } → { answer, toolCalls }
POST /assistant/conversations/:id/turns      { content }           → 202 { id }
```

`/ask` is synchronous: a Dutch question in, the turn is classified, and the
matching mode's loop runs inside the service (profiles, spec, validate,
refine or run), and the answer in Dutch comes back with a trace of the tool
calls. The CSV lands in `data/files/`. `history` carries the earlier turns
for follow-ups; the conversation lives on the caller's side, the service
stores nothing. One question makes one report; the execution loop stops
after `run_report`.

`/assistant` is the chat. The turn module in
`src/chat/` is generic — it imports nothing from `src/llm/` or `src/runner/`
and moves between services without edits — and `src/report-assistant.js` is
this service's one `answer` hook. It records the question, answers `202` with
the message id, then runs the same loop with the conversation's history. A
report run becomes an interim message with a pending file (`as:Document` with
no `as:url`); the URL is set when the run ends. The browser polls
`/chat-conversations/:id?include=messages.attachments` and finds the answer
that way. Failure is a message, never a silent loader.

`/ask` needs `LLM_BASE_URL` set, and answers 503 without it. A full-org report
run takes minutes.

### The internal tools

The loop drives a tool set per mode (`src/llm/tools.js`). Both modes share
`list_profiles`, `describe_profile`, `validate_spec`. Refinement adds
`lookup_values`; execution adds `run_report`. They are machinery, not an
external surface — the tool trace in the answer is the only thing a caller
sees of them. All LLM-facing text (system prompts, profile menu, tool
descriptions, validator errors) is English; the answer the user sees is Dutch.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `MU_SPARQL_ENDPOINT` | — | the auth layer, e.g. `http://database:8890/sparql`. Never virtuoso. |
| `REPORT_CLASS` | `…/reporting/Report` | type of the report resource |
| `CSV_SEPARATOR` | `;` | CSV column separator |
| `SUBJECT_CHUNK_SIZE` | `100` | subjects per column query (VALUES batch size); lower it when the auth layer rejects long queries |
| `ROW_LIMIT` | `200000` | seed limit; failing the job beats truncating |
| `MAX_PATH_DEPTH` | `8` | longest allowed spec path |
| `RUN_TIMEOUT` | `60` | seconds of silence before `run_report` gives up. Every answered query (seed page, column batch) restarts the clock, so a big report only needs the window per batch, not for the whole run. The run itself is never cancelled: the file still lands in the chat. |
| `INLINE_VALUES_MAX` | `50` | code lists up to this size are inlined in `describe_profile` |
| `VALUES_TTL` | `3600` | seconds the inlined lists are cached |
| `LLM_BASE_URL` | — | enables `/ask`; OpenAI-compatible (`https://ollama.com/v1`) |
| `LLM_MODEL` | — | e.g. `gpt-oss:120b` |
| `LLM_API_KEY` | — | bearer token, optional for local Ollama |
| `SEED_PAGE_SIZE` | `5000` | seed page size |
| `SUBJECT_CHUNK_SIZE` | `100` | see above |
| `SHARE_DIR` | `/share` | where CSVs are written |
| `CHAT_ASSISTANT_URI` | — | the `prov:SoftwareAgent` that signs assistant messages; found by lookup when unset |
| `CHAT_HISTORY_LIMIT` | `20` | messages of history a turn reads |
| `SERVICE_SCOPE` | `http://services.semantic.works/natural-language-report` | the mu-auth-scope for the LLM's own reads (code lists, `lookup_values`). Must match the `with-scope` grant in the app's sparql-parser config. |

Do not set `ALLOW_MU_AUTH_SUDO`; the template then refuses sudo queries.

## In the stack

`docker-compose.yml`:

```yaml
natural-language-report:
  build: ../natural-language-report-service/
  image: lblod/natural-language-report-service:0.1.0
  volumes:
    - ./data/files:/share
    - ./config/report-profiles/:/config/profiles/
```

`config/dispatcher/dispatcher.ex`:

```elixir
match "/natural-language-reports/*path" do
  forward conn, path, "http://natural-language-report/"
end
```

One route to the service root; `POST /ask` is the endpoint.
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