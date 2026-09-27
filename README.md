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

**Execution (Modus B).** The user has confirmed. No LLM runs. The last spec
bijlage in the conversation is the agreed spec: the service reads it from the
share, checks it against its profile and runs it as the caller. The answer is
a fixed Dutch text with the CSV and the spec as bijlagen. No spec yet, a spec
that no longer checks out, or a failed run each give a fixed Dutch failure
message. Nothing is retried and no spec is rewritten.

Only refinement has tools: `describe_profile`, `validate_spec`, `read_spec`
and `lookup_values`.

## How it works

Two documents drive everything:

| | Who writes it | When | Where |
|---|---|---|---|
| **profile** | the app | once, committed | `config/report-profiles/*.ttl`, mounted at `/config/profiles/` |
| **spec** | the LLM | one per question | in the request, not stored |

The profile says what the data looks like. The spec says what one report
holds. Both are Turtle, and both borrow the words of SHACL, the W3C language
to describe RDF data. Neither is used the way a SHACL tool uses it: see "How
this relates to SHACL" below.

The run: check → seed (`SELECT DISTINCT ?s`, paged) → columns (per group, per
chunk of subjects, with the nodes on each path) → assemble (pair by the
nodes columns share, on every step; `rep:collect`) → CSV → register file
+ report resource. One run per confirmed spec.

## The profile: a map of the data

A profile (using SHACL + some extensions) lists the kinds of things in the data (entities), what each one
has (fields), and which fields lead to other entities (links). The app
writes it; the service ships no profile and knows no vocabulary.

Three parts of the service read it:

- the validator checks every step of a spec's paths against it;
- the LLM gets it as a menu (`describe_profile`), its only picture of the
  data;
- the seed takes the class of the rows from it.

Nothing checks the data against a profile.

```turtle
<http://data.lblod.info/id/report-profiles/mandaten> a owl:Ontology ;
  dct:title "Mandaten" .

ent:Mandataris a sh:NodeShape ;
  rdfs:label "mandataris" ;
  sh:targetClass mandaat:Mandataris ;
  sh:property [ sh:path mandaat:start ; sh:name "start" ; sh:datatype xsd:dateTime ] ;
  sh:property [ sh:path org:holds ; sh:name "bekleedt mandaat" ; sh:node ent:Mandaat ] ;
  sh:property [ sh:path mandaat:isBestuurlijkeAliasVan ; sh:name "persoon" ; sh:node ent:Persoon ] .
```

| You write | It means |
|---|---|
| `owl:Ontology` + `dct:title` | the profile. A spec names this URI in `rep:profile`. |
| `sh:NodeShape` | an entity. A spec names this URI in `rep:entity` when it must pick one. |
| `rdfs:label` on the entity | its name in the menu and in error messages. Keep it unique in the profile. |
| `sh:targetClass` | the `rdf:type` of the entity's subjects |
| `sh:property` + `sh:path` | a field: one step, a predicate or `[ sh:inversePath p ]` |
| `sh:name` | the field's name in the menu and in messages |
| `sh:datatype` | a value field: a column may end here |
| `sh:class` | a code-list field: a column may end here. Lists up to `INLINE_VALUES_MAX` values show in the menu. |
| `sh:node` | a link to another entity: a spec may take this step |
| `sh:or ( [ sh:node A ] [ sh:node B ] )` | a link that reaches A or B |

The service does not read `sh:description` (write it for people; the LLM
never sees it), cardinality (every link counts as "many"), or a field path
of more than one step.

At boot each profile must parse, name itself with `owl:Ontology` and hold at
least one entity; a broken profile stops the service. A `sh:node` to an
entity that does not exist only shows when a spec takes that step.

### A link to several kinds

When one step can reach entities of different kinds, say so with `sh:or`:

```turtle
sh:property [ sh:path [ sh:inversePath besluit:bestuurt ] ; sh:name "bestuursorganen" ;
              sh:or ( [ sh:node ent:Bestuursorgaan ] [ sh:node ent:LeidinggevendBestuursorgaan ] ) ] .
```

The validator follows all of them, and the next steps decide. A spec that
wants one kind adds a `rep:where` on a step only that kind has. Write one
field with `sh:or`, not two fields on one path: in SHACL, two fields mean a
value must fit both. (The validator reads two fields like `sh:or`, but a
SHACL reader would not.)

### Entities that share a class

A profile may hold several entities of one class. The portal's
`mandaten.ttl` has four kinds of `besluit:Bestuursorgaan`: political and
leidinggevend, each fixed (vast) and in time. A spec picks one with
`rep:entity`; `rep:discriminator` tells the seed which subjects belong to
it.

A discriminator is written like a spec filter (see "Which rows" below): a
`sh:path` from the subject, of any length, and a test on where it ends.
Several on one entity must all hold. `sh:and ( ... )`, `sh:or ( ... )` and
`sh:not ...` combine them, and may nest.

```turtle
# fixed, and its classification is in the list
ent:LeidinggevendBestuursorgaan
  rep:discriminator [ sh:path generiek:isTijdspecialisatieVan ; sh:maxCount 0 ] ;
  rep:discriminator [ sh:path org:classification ; sh:in ent:LeidinggevendeOrgaanClassificaties ] .

# in time, and the classification of its fixed organ is not in the list
ent:BestuursorgaanInTijd
  rep:discriminator [ sh:path generiek:isTijdspecialisatieVan ; sh:minCount 1 ] ;
  rep:discriminator [ sh:path ( generiek:isTijdspecialisatieVan org:classification ) ;
                      sh:in ent:LeidinggevendeOrgaanClassificaties ; sh:maxCount 0 ] .
```

A rule or a list can be a named node, written once and used in several
places. `sh:not` on a named rule gives its exact opposite, so two entities
split a class with no overlap and no gap:

```turtle
ent:IsLeidinggevendOrgaan sh:path org:classification ;
  sh:in ent:LeidinggevendeOrgaanClassificaties .

ent:LeidinggevendBestuursorgaan rep:discriminator ent:IsLeidinggevendOrgaan .
ent:Bestuursorgaan              rep:discriminator [ sh:not ent:IsLeidinggevendOrgaan ] .
```

Turtle cannot name a `( ... )` list, so write a named list out:
`ent:X rdf:first <a> ; rdf:rest ( <b> <c> ) .` Do not give a named rule the
type `sh:NodeShape`: it would become an entity.

Test what a thing is, not what hangs off it. The classification says what
an organ is. "Has a period with a bestuursfunctie" needs no code list, but
it trusts the data: an organ that lost its functie would move to the other
entity, and no report could find it. `sh:or` of both catches the most.

The seed turns a plain discriminator into the same SPARQL as a filter.
`sh:and`, `sh:or` and `sh:not` become one `FILTER(...)` over `EXISTS` tests;
that form is not yet tested against mu-authorization or sparql-parser. A
broken discriminator stops the service at boot and names the entity.

## The spec: one report

The LLM writes one spec per question. The user reads the proposal and
confirms; the service then checks the spec again and runs it. A spec has two
halves: which rows, and what the CSV shows about each row.

```turtle
<http://data.lblod.info/id/report-specs/burgemeesters> a rep:ReportSpec , sh:NodeShape ;
  dct:title "Burgemeesters sinds 2025" ;
  rep:profile <http://data.lblod.info/id/report-profiles/mandaten> ;
  sh:targetClass mandaat:Mandataris ;
  sh:property [ sh:path ( org:holds org:role ) ;
                sh:hasValue <http://data.vlaanderen.be/id/concept/BestuursfunctieCode/5ab0e9b8a3b2ca7c5e000013> ] ;
  sh:property [ sh:path mandaat:start ;
                sh:minInclusive "2025-01-01T00:00:00"^^xsd:dateTime ] ;
  rep:columns (
    [ sh:path rep:self ; rdfs:label "mandataris" ]
    [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:givenName ) ; rdfs:label "voornaam" ]
    [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; rdfs:label "achternaam" ]
    [ sh:path ( org:holds [ sh:inversePath org:hasPost ] generiek:isTijdspecialisatieVan
                besluit:bestuurt skos:prefLabel ) ; rdfs:label "gemeente" ]
  ) .
```

One row per mandataris whose mandate has the role Burgemeester and who
started on or after 1 January 2025, with name and gemeente.

### Which rows

| You write | It means |
|---|---|
| `rep:ReportSpec` + `sh:NodeShape` | this is a spec |
| `rep:profile` | the profile the spec was written against |
| `sh:targetClass` | one row per subject of this class |
| `rep:entity` | which entity, when more than one has this class |
| `sh:property` | a filter: keep only the subjects that pass |

A filter has a `sh:path` from the row and a test. When the path reaches
several values, the test passes if one of them passes.

| Test | Keeps the row when |
|---|---|
| `sh:hasValue x` | the path reaches x |
| `sh:in ( x y )` | the path reaches x or y (all URIs, or all text) |
| `sh:minInclusive`, `sh:maxInclusive`, `sh:minExclusive`, `sh:maxExclusive` | a date or number at the end lies in range; the path must end on a value field |
| `sh:pattern` (+ `sh:flags`) | a value matches the regex |
| `rep:anyOf ( "woord" ... )` | a value holds one of these words, upper or lower case; at most 24 words, no URIs |
| `sh:minCount 1` | the path leads somewhere |
| `sh:minCount 2` | the path reaches two different values |
| `sh:maxCount 0` | the path leads nowhere |
| `sh:maxCount 0` with `sh:in` or `sh:hasValue` | the path reaches none of these values |

The service cannot count: `sh:minCount` above 2 and `sh:maxCount` above 0 are
refused.

### A test on the way: `rep:where`

A filter tests the end of its path. `rep:where` tests a node on the way.
Write it like a filter, with its path from the row. The steps it shares with
its column or filter are the same nodes; its test applies where its own path
ends. On a filter it drops rows; on a column it drops values from the cell,
never rows.

```turtle
<http://data.lblod.info/id/report-specs/eenheden-burgemeester> a rep:ReportSpec , sh:NodeShape ;
  rep:profile <http://data.lblod.info/id/report-profiles/mandaten> ;
  sh:targetClass besluit:Bestuurseenheid ;
  rep:columns (
    [ sh:path skos:prefLabel ; rdfs:label "eenheid" ]
    [ sh:path ( [ sh:inversePath besluit:bestuurt ] [ sh:inversePath generiek:isTijdspecialisatieVan ]
                org:hasPost [ sh:inversePath org:holds ] mandaat:isBestuurlijkeAliasVan foaf:familyName ) ;
      rdfs:label "burgemeester" ;
      rep:where [ sh:path ( [ sh:inversePath besluit:bestuurt ] [ sh:inversePath generiek:isTijdspecialisatieVan ]
                            org:hasPost org:role ) ;
                  sh:hasValue <http://data.vlaanderen.be/id/concept/BestuursfunctieCode/5ab0e9b8a3b2ca7c5e000013> ] ]
  ) .
```

Per eenheid, the family name of its mayors. The `rep:where` shares three
steps with the column, so it tests the mandate, not the organ or the
person. `validate_spec` says so: `rep:where 1 on column "burgemeester"
applies at "mandaat", after step 3`. The proposal repeats that line to the
user.

A `rep:where` must share at least one step with its column or filter, and
holds no `rep:where` of its own.

### What the CSV shows

`rep:columns` is a list; each item becomes a column, in that order.

| You write | It means |
|---|---|
| `sh:path ( ... )` | the steps from the row to the value |
| `sh:path rep:self` | the row's own URI |
| `rdfs:label` | the column header; required and unique |
| `sh:nodeKind sh:IRI` | show the URI of the node the path ends on (only then may a path end on a link) |
| no `rep:collect`, or `rep:collect rep:row` | each value gets its own row; at most one column may say `rep:row` |
| `rep:collect sh:groupConcat` (+ `sh:separator`) | all values in one cell |
| `rep:collect sh:min` / `sh:max` | the lowest / highest date or number |

A column holds no tests; those go in `sh:property`, or in the column's
`rep:where`.

### How values become rows

Columns that walk the same steps (with the same `rep:where`) share the nodes
on those steps, and their values pair by those nodes: one mayor's first and
last name stay on one row. Where paths split and both sides have several
values, every combination becomes a row. A missing value is an empty cell;
identical rows show once. `sh:groupConcat`, `sh:min` and `sh:max` fold a
column into one cell per node it shares with the other columns.

### What the validator checks

The validator (`src/runner/check.js`) runs on every proposal and again
before every run. It returns the first problem, in words the LLM can act on.
On top of the rules above, it checks that:

- the Turtle holds one `rep:ReportSpec`, no more: one answer is one report;
- every step of every path exists in the profile;
- no path is longer than `MAX_PATH_DEPTH` steps;
- a date or number test ends on a value field, not on a link;
- a class that several entities share comes with `rep:entity`.

## How this relates to SHACL

SHACL is the W3C language to check RDF data against shapes: a SHACL tool
takes data and shapes, and reports which nodes fail. We borrow its words and
its layout, so both documents are valid SHACL syntax and a SHACL tool can
read them. We use them for other jobs.

### The profile: SHACL, with one extension

Read as SHACL, a profile says what good data looks like: nodes of this
class, values of this datatype, links to nodes of that shape. We read the
same statements as a map, and never check data with them. That is a use of
SHACL, not a change to it. One thing does change the meaning:

- **`rep:discriminator` narrows `sh:targetClass`.** In SHACL, four shapes
  with `sh:targetClass besluit:Bestuursorgaan` mean that every organ must
  fit all four. Here each organ belongs only to the shapes whose
  discriminators it meets. A SHACL tool skips `rep:` terms, so to it the
  profile still says "all four". SHACL-AF has a tool for this job, custom
  targets (see below); we keep `sh:targetClass` so a spec can still name its
  class, and write the rule in the same terms as a spec filter.

Two smaller points:

- In SHACL, a node reached through `sh:node B` must pass B's field rules. We
  go one step further and treat it as "a B" for the next steps. If the data
  breaks that, the query finds nothing there; it never finds a wrong row.
- Links run in circles (bestuursorgaan to orgaan in tijd and back). SHACL
  leaves such shapes to each tool. That only matters if someone checks data
  with a profile.

### The spec: SHACL syntax, our own meaning

A spec is valid SHACL syntax, but it does not mean what SHACL says. A SHACL
tool reads a spec as a check and reports which subjects fail it. We read it
as a query: the rows are the subjects that pass. For some terms the two
readings agree; for others they do not.

| Term | In SHACL | In a spec | Same? |
|---|---|---|---|
| `sh:targetClass`, `sh:path` | which nodes; which values | same | yes |
| `sh:hasValue` | one value equals | same | yes |
| `sh:minCount 1` / `2` | at least 1 / 2 values | same | yes |
| `sh:maxCount 0` | no values | same | yes |
| `sh:in`, ranges, `sh:pattern` | every value passes, and a node without values passes too | one value passes | no |
| `sh:maxCount 0` with a test | no values at all | no value that passes | no |
| `rep:anyOf`, `rep:where` | skipped | tests of our own | added |
| `rep:columns`, `rep:self`, `rep:collect`, `sh:nodeKind` and `rdfs:label` on a column | skipped | the CSV | added |

So a spec means the same in both readings only if it uses the "yes" terms
alone; then its rows are exactly the subjects a SHACL tool finds good. Most
specs use `sh:in` or a date range, so most specs do not.

Why "one value passes": reports ask for "organs with classification X" or
"persons with a burgemeester mandate". With SHACL's `sh:in`, the first
would also keep organs with no classification, and the second would drop a
person who holds a second mandate too. SHACL can say "one value"
(`sh:qualifiedValueShape` with `sh:qualifiedMinCount 1`), but the LLM writes
the specs, and each extra construct is one more way to get it wrong.

The CSV half has no SHACL meaning at all: SHACL has no notion of output.

### SHACL-AF

SHACL Advanced Features is a W3C Working Group Note from 2017: a proposal,
not a standard. It adds custom targets (`sh:SPARQLTarget`: pick nodes with a
SPARQL query), values computed from the data, rules and functions. A later
draft adds `sh:count`, `sh:sum`, `sh:min`, `sh:max`, `sh:groupConcat` and
`sh:orderBy`. We borrow `sh:groupConcat`, `sh:min`, `sh:max` and
`sh:separator` as values of `rep:collect`, and keep `sh:count`, `sh:sum` and
`sh:orderBy` for when counting and sorting arrive. We do not use its custom
targets: a `sh:SPARQLTarget` is a SPARQL string that the service could not
check or combine with a spec's filters.

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
spec files, and public reference data read under the service scope (inlined
code lists and `lookup_values`, see below).

Keep it that way. Do not add a tool that previews, samples or counts what a
spec would match, not even to catch a `rep:where` that hangs on the wrong
node. That check stays on the profile: `validate_spec` says where each
`rep:where` applies, and the proposal repeats it to the user.

### The service scope

The LLM's own reads during refinement (`describe_profile`'s code lists and
`lookup_values`) run under a service scope, not the caller's session:
`publicQuery` in `src/llm/explore.js`. mu's
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
DELETE /assistant/conversations/:id                                 → 204
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

The delete is the trash bin in the chat's sidebar. It removes the
conversation, its messages, their bijlagen (the triples and the files on
the share) and the reports of those files. It runs as the caller: the auth
layer keeps a user to their own conversations, and a conversation the caller
cannot read is a 404.

### The internal tools

The refinement loop drives one tool set (`src/llm/tools.js`). The tools are
machinery, not an external surface. All LLM-facing text (system prompts,
profile menu, tool descriptions, validator errors) is English; the answer the
user sees is Dutch.

### What the model sees

The system prompt ends with the profile list and, when there is a current
spec, the menu of its profile (`src/llm/loop.js`). A turn that stays on that
profile needs no `describe_profile` call; the model calls it only for
another profile.

Each request to the model holds one spec in full: the newest.

- The history is text only. A spec bijlage shows as its file name, and a
  spec the model printed in its answer is cut out.
- The current spec, the last spec bijlage in the conversation, comes in full
  under the user's new message. When the user refines, the model changes it;
  when the user asks for a report that lists another kind of thing per row,
  it starts a new spec.
- Within a turn, each newer spec (a `validate_spec` call, or an older spec
  opened with `read_spec`) replaces the older one with "Left out: a newer
  spec follows."
- The model opens an older spec with `read_spec` only when the user asks for
  it.

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
| `SERVICE_SCOPE` | `http://services.semantic.works/natural-language-report` | the mu-auth-scope for the LLM's own reads (code lists, `lookup_values`). Must match the `with-scope` grant in the app's sparql-parser config. |

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
