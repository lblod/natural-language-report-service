# natural-language-report-service

A chat assistant. The user asks for a report in Dutch and gets a CSV.

The user asks for a report. An LLM writes a report spec and explains it in
Dutch. The user confirms. The service checks the spec and runs it as the
user. The LLM does not write SPARQL. The LLM does not see the data of the
report.

Work in progress, POC phase. Scheduled reports stay in
`loket-report-generation-service`.

## Getting started

### Adding the service to your stack

Add the service to your `docker-compose.yml`:

```yml
natural-language-report:
  image: lblod/natural-language-report-service
  volumes:
    - ./data/files:/share
    - ./config/report-profiles:/config/profiles
  environment:
    LLM_BASE_URL: "http://openai-compatible-endpoint.example/v1"
    LLM_MODEL: "glm-5.2"
    LLM_API_KEY: "..."
```

Route the chat to it in `config/dispatcher/dispatcher.ex`:

```elixir
match "/assistant/*path" do
  forward conn, path, "http://natural-language-report/assistant/"
end
```

The chat frontend is
[frontend-report-assistant](https://github.com/lblod/frontend-report-assistant).

### Configuration

The service needs two things from the app:

- Report profiles. Turtle files in `config/report-profiles/`, mounted on
  `/config/profiles`. A profile describes the data users may ask about: the
  kinds of things, their fields and the links between them. The service has
  no vocabulary of its own. It only knows the profiles. The tutorial below
  writes one.
- An LLM. Any OpenAI-compatible endpoint with tool calls. Set
  `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`.

The app also needs the chat resources in mu-cl-resources, the agent that
signs the answers (`CHAT_ASSISTANT_URI`) and the two bijlage types (see
[Data model](#data-model)). See
[app-organization-portal#643](https://github.com/lblod/app-organization-portal/pull/643)
for the resource config and the migrations.

TODO: put this in a mu-cli script.

### Authorization

The service runs every query as the user who asks. So the group of the user
needs to:

- read the data the profiles describe;
- write files (`nfo:FileDataObject`) and reports (`reporting:Report`);
- read and write the chat (`sioc:Thread`, `sioc:Post`, `sioct:InstantMessage`).

There is one exception. While the LLM writes a spec, it reads code lists and
the names of linked entities (a bestuurseenheid, a persoon) to suggest filter
values. These reads do not run as the user. They run with the scope of the
service, `http://services.semantic.works/natural-language-report`
(`SERVICE_SCOPE`). Grant that scope read access to the graph with the code
lists and the names. If the scope can not read a code list or an entity, the
LLM sees it as "(not readable)" and filters on the name text instead. With
sparql-parser:

```lisp
(with-scope "http://services.semantic.works/natural-language-report"
  (grant (read)
    :to-graph public
    :for-allowed-group "public"))
```

Do not set `DEFAULT_MU_AUTH_SCOPE`. It would put every query under that
scope, also the report run.

The service writes messages, reports and files without a graph. So they land
in every graph the user may write to that accepts those types. If you want
them in one graph, set `WRITE_SCOPE`. Every write then runs under that
scope, still as the user, and only the grants inside that scope apply. The
conversation delete runs under it too. This is needed: without a scope,
sparql-parser 0.0.15 deletes a triple in only one of the graphs that accept
its type, and this may not be the graph the triple is in. Use another scope
than `SERVICE_SCOPE`. If both are the same, the code-list reads of the LLM
could reach the chat of the user. Example, one graph per user:

```lisp
(with-scope "http://services.semantic.works/natural-language-report/chat"
  (grant (read write)
    :to-graph chat
    :for-allowed-group "report-assistant-user"))
```

### Logging the LLM calls

The call to the LLM provider goes over TLS.
[app-http-logger](https://github.com/mu-semtech/app-http-logger) can not read
it. An app that logs its traffic has a `sink`: a container with the `logging`
label that answers every request with `200 {}`. If a service posts a copy of
a TLS exchange to the sink, app-http-logger captures the copy like any other
call. Set `LOG_SINK_URL` (for example `http://sink/llm`) and the service
posts every exchange there as
`{ "request": <the body sent>, "response": <the answer or { "error" }> }`.
It does not wait for the sink.

Note: the copy has the questions of the users and the answers. Run
app-http-logger in its encrypting mode.

Note: packetbeat cuts a captured message at `PACKETBEAT_MAX_MESSAGE_SIZE`,
100 KB by default. A request with a profile menu and history can be bigger.
Raise that cap in app-http-logger if you need the full copies.

## Tutorial: a first report

We add a small profile and run one report on it.

1. Write the profile `config/report-profiles/besturen.ttl`:

   ```turtle
   @prefix sh:      <http://www.w3.org/ns/shacl#> .
   @prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
   @prefix owl:     <http://www.w3.org/2002/07/owl#> .
   @prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
   @prefix dct:     <http://purl.org/dc/terms/> .
   @prefix skos:    <http://www.w3.org/2004/02/skos/core#> .
   @prefix org:     <http://www.w3.org/ns/org#> .
   @prefix besluit: <http://data.vlaanderen.be/ns/besluit#> .
   @prefix code:    <http://lblod.data.gift/vocabularies/organisatie/> .
   @prefix ent:     <http://data.lblod.info/id/report-entities/> .

   <http://data.lblod.info/id/report-profiles/besturen> a owl:Ontology ;
     dct:title "Besturen" .

   ent:Bestuurseenheid a sh:NodeShape ;
     rdfs:label "bestuurseenheid" ;
     sh:targetClass besluit:Bestuurseenheid ;
     sh:property [ sh:path skos:prefLabel ; sh:name "naam" ; sh:datatype xsd:string ] ;
     sh:property [ sh:path org:classification ; sh:name "soort bestuur" ; sh:node ent:SoortBestuur ] .

   ent:SoortBestuur a sh:NodeShape ;
     rdfs:label "soort bestuur" ;
     sh:targetClass code:BestuurseenheidClassificatieCode ;
     sh:property [ sh:path skos:prefLabel ; sh:name "naam" ; sh:datatype xsd:string ] .
   ```

   The profile names itself (`owl:Ontology` and `dct:title`) and has two
   entities. A bestuurseenheid has a name and a link to its soort bestuur.

2. Restart the service. It reads the profiles at boot.

   ```sh
   docker compose restart natural-language-report
   ```

   The log shows `[profile] "Besturen" (besturen.ttl): 2 entities, 3 fields`.
   If a profile is broken, the service stops and the log names the file.

3. Open the chat and ask `Geef alle gemeenten met hun naam.` The assistant
   explains what the report will list and adds the spec as a bijlage
   (`specificatie-<uuid>.ttl`). The spec looks like this:

   ```turtle
   <http://data.lblod.info/id/report-specs/gemeenten> a rep:ReportSpec , sh:NodeShape ;
     dct:title "Alle gemeenten" ;
     rep:profile <http://data.lblod.info/id/report-profiles/besturen> ;
     sh:targetClass besluit:Bestuurseenheid ;
     sh:property [ sh:path org:classification ;
                   sh:hasValue <http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/5ab0e9b8a3b2ca7c5e000001> ] ;
     rep:columns ( [ sh:path skos:prefLabel ; rdfs:label "naam" ] ) .
   ```

4. Ask for changes (`Voeg ook de URI toe.`) or confirm (`Voer het uit.`). On
   confirm, the service runs the last spec and answers with the CSV and the
   spec as bijlagen.

## How it works

First the LLM decides if the user said "run it". This gives one of two
modes.

- Refine. The LLM reads the profiles and writes a spec, or changes the
  current one. The service checks the spec against its profile. The LLM
  fixes what the check reports. The answer explains the spec in Dutch and
  has the spec as bijlage. Nothing runs.
- Execute. The service takes the last spec bijlage of the conversation and
  checks it again. Right before the run, one LLM call writes the
  `dct:description` of the report. It uses the conversation for this. It
  does not see the report data. The service runs the spec as the user,
  writes the CSV to the share and records a `reporting:Report` and a
  `reporting:ReportSpec`. The report links to the spec with
  `dct:conformsTo`. The answer is a fixed text with the CSV and the spec as
  bijlagen. If there is no spec, if the spec does not check out anymore, or
  if the run fails, the answer is a fixed failure text.

A run has three steps. It finds the rows: the subjects of the class of the
spec that pass its filters. It fetches each column for those rows. It pairs
the values and writes the CSV. A large report takes minutes.

The LLM gets no report data: no rows, no counts, no errors of the run. It
gets the conversation, the profiles, the check messages, the specs, the code
lists and the names it looks up for a filter.

## Reference

### Environment variables

| Name | Default | Meaning |
|---|---|---|
| `LLM_BASE_URL` | | OpenAI-compatible endpoint, for example `http://openai-compatible-endpoint.example/v1`. If not set, every turn answers with a failure text. |
| `LLM_MODEL` | | for example `glm-5.2` |
| `LLM_API_KEY` | | bearer token. Not needed for a local Ollama. |
| `PROFILE_DIR` | `/config/profiles` | folder with the profiles, one `.ttl` file each |
| `SHARE_DIR` | `/share` | where CSVs and specs are written |
| `SERVICE_SCOPE` | `http://services.semantic.works/natural-language-report` | scope of the reads of the LLM: code lists and names of linked entities |
| `WRITE_SCOPE` | | scope of every write (messages, reports, files) and of the conversation delete. If not set, no scope is sent. |
| `CHAT_ASSISTANT_URI` | `http://data.lblod.info/id/chat-agents/report-assistant` | agent that signs the answers and is the source (`prov:wasAttributedTo`) of every spec and report |
| `CSV_SEPARATOR` | `;` | CSV column separator |
| `ROW_LIMIT` | `200000` | a report with more rows fails. A report is never cut. |
| `MAX_PATH_DEPTH` | `8` | longest path in a spec |
| `INLINE_VALUES_MAX` | `50` | code lists and linked entities up to this size are shown to the LLM in full, with URIs. Bigger ones show as "(many)". Ones the service can not read show as "(not readable)". |
| `SUBJECT_CHUNK_SIZE` | `100` | rows per column query. Lower it if the database refuses long queries. |
| `LLM_RETRIES` | `3` | retries of an LLM call that fails on the network (no connection, a reset, no answer) or with a 500, 502, 503 or 504. Other failures are not retried. |
| `LLM_RETRY_DELAY` | `2000` | ms before the first retry. Each next retry waits twice as long. |
| `LOG_LLM` | `false` | log every LLM request and response to stdout |
| `LOG_SINK_URL` | | if set, every LLM exchange (request body, response or error) is also POSTed here, without waiting, so app-http-logger can record it. See above. If not set, nothing is sent. |

### API

#### POST /assistant/conversations/:id/turns

Body `{ "content": "..." }`. Stores the question and answers `202` with the
id of the message. The answer comes later as a new message in the
conversation. The frontend polls the conversation for it.

#### DELETE /assistant/conversations/:id

Deletes the conversation, its messages, its report specs and the spec
bijlagen (triples and files). The reports stay, with their CSV. The reports
of later runs of its specs stay too; their `dct:conformsTo` then points to a
deleted spec. Answers `204`. Answers `404` if the user can not read the
conversation.

#### POST /assistant/report-specs/:id/run

No body. Runs a saved `reporting:ReportSpec` again, outside the chat, as the
user. The service reads the Turtle file of the spec and checks it against
the profiles. Then it answers `202`. The run goes on in the background and
records a new `reporting:Report` that conforms to the same spec, with the
description of the spec. It shows up in the reports list. No LLM is called.
Answers `404` if the user can not read the spec. Answers `422` if its Turtle
file is gone or does not check out anymore. If the run fails, it is only
logged.

### Data model

| Prefix | URI |
|---|---|
| sioc | `http://rdfs.org/sioc/ns#` |
| sioct | `http://rdfs.org/sioc/types#` |
| nfo | `http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#` |
| as | `https://www.w3.org/ns/activitystreams#` |
| reporting | `http://lblod.data.gift/vocabularies/reporting/` |
| rep | `http://mu.semte.ch/vocabularies/reporting/` (profiles and specs) |

| Class | What |
|---|---|
| `sioc:Thread` | a conversation, made by the frontend |
| `sioc:Post`, `sioct:InstantMessage` | a message: `sioc:content`, `foaf:maker`, `as:attachment` to its bijlagen |
| `nfo:FileDataObject` | a bijlage; `dct:type` says spec or executed report |
| `reporting:Report` | one per run, in the chat or from `POST /assistant/report-specs/:id/run`. Has `dct:title`, a Dutch `dct:description` of at most 300 characters, `prov:generated` to the CSV, `dct:conformsTo` to its spec, and `prov:wasAttributedTo` to the assistant agent (`CHAT_ASSISTANT_URI`), also on a re-run |
| `reporting:ReportSpec` | the spec of one run in the chat. Has the same title, description and creation time, `dct:isPartOf` to its conversation, `prov:generated` to its Turtle file (the spec bijlage), and `prov:wasAttributedTo` to the assistant agent. The reports link to the spec. The spec does not link to its reports. |

The two bijlage types:

- `http://lblod.data.gift/concepts/6693014e-7b7d-448c-bb24-80c9758521f3` Rapportspecificatie
- `http://lblod.data.gift/concepts/28d97698-e219-4a92-bdbd-7ab367a7524e` Uitgevoerd rapport

### Profile

A profile lists the kinds of things in the data (entities), what each one
has (fields) and which fields lead to other entities (links). The LLM gets
the profile as a menu. The check tests every step of a spec against the
profile. The profile is not used to check the data.

| You write | It means |
|---|---|
| `owl:Ontology` + `dct:title` | the profile. A spec names this URI in `rep:profile`. |
| `sh:NodeShape` | an entity |
| `rdfs:label` on the entity | its name in the menu. Keep it unique in the profile. |
| `sh:targetClass` | the `rdf:type` of the entity |
| `sh:property` + `sh:path` | a field: one step, a predicate or `[ sh:inversePath p ]` |
| `sh:name` | the name of the field in the menu |
| `sh:datatype` | a value field. A column may end here. |
| `sh:class` | a code-list field. A column may end here. Short lists show in the menu in full, with URIs. |
| `sh:node` | a link to another entity. If the entity has few instances (a code), it shows in the menu in full, with URIs. A filter on a link tests the URI. |
| `sh:or ( [ sh:node A ] [ sh:node B ] )` | a link that reaches A or B |

The service ignores `sh:description`, cardinality and field paths of more
than one step.

If one step can reach entities of different kinds, write one field with
`sh:or`. Do not write two fields on one path:

```turtle
sh:property [ sh:path [ sh:inversePath besluit:bestuurt ] ; sh:name "bestuursorganen" ;
              sh:or ( [ sh:node ent:Bestuursorgaan ] [ sh:node ent:LeidinggevendBestuursorgaan ] ) ] .
```

### Spec

The LLM writes one spec per question. A spec has two halves: which rows,
and what the CSV shows for each row.

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

One row per mandataris with the role Burgemeester who started on or after
1 January 2025, with name and gemeente.

#### Which rows

| You write | It means |
|---|---|
| `rep:ReportSpec` + `sh:NodeShape` | this is a spec |
| `rep:profile` | the profile the spec uses |
| `sh:targetClass` | one row per subject of this class |
| `rep:entity` | which entity, if several share the class |
| `sh:property` | a filter: keep only the subjects that pass |

A filter has a `sh:path` from the row and a test. If the path reaches
several values, the row passes if one of them passes.

| Test | Keeps the row if |
|---|---|
| `sh:hasValue x` | the path reaches x |
| `sh:in ( x y )` | the path reaches x or y |
| `sh:minInclusive`, `sh:maxInclusive`, `sh:minExclusive`, `sh:maxExclusive` | a date or number at the end lies in the range |
| `sh:pattern` (+ `sh:flags`) | a value matches the regex |
| `rep:anyOf ( "woord" ... )` | a value has one of these words, case does not matter (at most 24 words) |
| `sh:minCount 1` | the path leads somewhere |
| `sh:minCount 2` | the path reaches two different values |
| `sh:maxCount 0` | the path leads nowhere |
| `sh:maxCount 0` with `sh:in` or `sh:hasValue` | the path reaches none of these values |

The service can not count. A higher `sh:minCount` or `sh:maxCount` is
refused, and also `sh:minCount 0`.

#### What the CSV shows

`rep:columns` is a list. Each item becomes a column, in that order.

| You write | It means |
|---|---|
| `sh:path ( ... )` | the steps from the row to the value |
| `sh:path rep:self` | the URI of the row itself |
| `rdfs:label` | the column header. Required and unique. |
| `sh:nodeKind sh:IRI` | show the URI of the node the path ends on |
| no `rep:collect`, or `rep:collect rep:row` | each value gets its own row |
| `rep:collect sh:groupConcat` (+ `sh:separator`) | all values in one cell |
| `rep:collect sh:min` / `sh:max` | the lowest or highest date or number |

Columns that walk the same steps share the nodes on those steps. Their
values are paired by those nodes: the first name and the last name of one
mayor stay on one row. Where paths split and both sides have several values,
every combination becomes a row. A missing value is an empty cell. Identical
rows show once.

## Advanced topics

### Entities that share a class

A profile may have several entities of one class. The `mandaten.ttl` of the
portal has four kinds of `besluit:Bestuursorgaan`: political and
leidinggevend, each fixed and in time. `rep:discriminator` says which
subjects belong to an entity. A spec picks the entity with `rep:entity`.

A discriminator is written like a spec filter: a `sh:path` of any length
and a test. If an entity has several, all must hold. `sh:and`, `sh:or` and
`sh:not` combine them.

```turtle
# fixed, and its classification is in the list
ent:LeidinggevendBestuursorgaan
  rep:discriminator [ sh:path generiek:isTijdspecialisatieVan ; sh:maxCount 0 ] ;
  rep:discriminator [ sh:path org:classification ; sh:in ent:LeidinggevendeOrgaanClassificaties ] .
```

A rule or a list can be a named node, so you can use it in several places.
`sh:not` on a named rule gives the exact opposite. So two entities split a
class without overlap and without gap:

```turtle
ent:IsLeidinggevendOrgaan sh:path org:classification ;
  sh:in ent:LeidinggevendeOrgaanClassificaties .

ent:LeidinggevendBestuursorgaan rep:discriminator ent:IsLeidinggevendOrgaan .
ent:Bestuursorgaan              rep:discriminator [ sh:not ent:IsLeidinggevendOrgaan ] .
```

Write a named list out: `ent:X rdf:first <a> ; rdf:rest ( <b> <c> ) .` Do
not type a named rule `sh:NodeShape`, or it becomes an entity.

Note: use the classification to decide what an organ is. Do not use "has a
bestuursfunctie". That trusts the data: if an organ loses its functie, it
moves to the other entity and no report finds it anymore.

### A test on the way: `rep:where`

A filter tests the end of its path. `rep:where` tests a node on the way.
Write it like a filter, with its path from the row. The steps it shares with
its column or filter are the same nodes. On a filter it drops rows. On a
column it drops values from the cell.

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
steps with the column, so it tests the mandate. The check says where each
`rep:where` applies, and the assistant repeats it to the user.

### How this relates to SHACL

Profiles and specs use the words of SHACL, so a SHACL tool can read them.
The meaning is not always the SHACL meaning.

A profile, read as SHACL, says what good data looks like. We read it as a
map. We do not check data with it. One term changes the meaning:
`rep:discriminator` narrows `sh:targetClass`. In SHACL four shapes on one
class mean that every subject must fit all four. Here a subject belongs only
to the shapes whose discriminators it meets.

A spec is valid SHACL syntax with its own meaning. A SHACL tool reads it as
a check and reports which subjects fail. We read it as a query: the rows are
the subjects that pass. Most terms agree. `sh:in`, the ranges and
`sh:pattern` do not: in SHACL every value must pass, in a spec one value is
enough. A report asks for "persons with a burgemeester mandate". With the
SHACL reading, a person who also has a second mandate would drop out. The
`rep:` terms and the CSV half have no SHACL meaning.

### Limits

No counting, no sorting, no top-N, no comparing two subjects. One class per
report. Filter suggestions read only what the service scope may read.

## Discussion

### Why a report spec and not SPARQL

The LLM could write SPARQL directly. This we didn't do, becauuse:

- A report is often multiple SPARQL queries.
  - It's technically possible to convert a SPARQL to SPIN, and validate this against SHACL profile.
    - But; this leaves the control of execution to the database. And this is often where the query fails.
- It's more portable.
- Safety. LLM could go wild with a SPARQL; it's harder to validate.
- Smaller problem space for the model, hence some vague hope a smaller model can be used.
- SPARQL can do too much to check it. A spec only says rows, filters and columns, so all of it can be checked.

This doesn't come for free of course.
