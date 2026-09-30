# natural-language-report-service

Chat assistant that turns a question in Dutch into a CSV report.

The user asks for a report. An LLM writes a report spec and explains it in
Dutch. The user confirms. The service checks the spec and runs it as the
user. The LLM writes no SPARQL and never sees report data.

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

The chat itself is
[frontend-report-assistant](https://github.com/lblod/frontend-report-assistant).

### Configuration

The service needs two things from the app:

- **Report profiles.** Turtle files in `config/report-profiles/`, mounted on
  `/config/profiles`. A profile describes the data users may ask about: the
  kinds of things, their fields and the links between them. The service
  knows no vocabulary of its own. The tutorial below writes one.
- **An LLM.** Any OpenAI-compatible endpoint with tool calls, set with
  `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`.

The app also needs the chat resources in mu-cl-resources, the agent that
signs the answers (`CHAT_ASSISTANT_URI`) and the two bijlage types (see
[Data model](#data-model)). See
[app-organization-portal#643](https://github.com/lblod/app-organization-portal/pull/643)
for the resource config and the migrations to add.

TODO: put this in a mu-cli script.

### Authorization

The service runs every query as the user who asks. The user's group must be
able to:

- read the data the profiles describe;
- write files (`nfo:FileDataObject`) and reports (`reporting:Report`);
- read and write the chat (`sioc:Thread`, `sioc:Post`, `sioct:InstantMessage`).

One exception. While it writes a spec, the LLM reads code lists to suggest
filter values. These reads use the service's own scope,
`http://services.semantic.works/natural-language-report` (`SERVICE_SCOPE`).
Grant that scope read access to the graph with the code lists. With
sparql-parser:

```lisp
(with-scope "http://services.semantic.works/natural-language-report"
  (grant (read)
    :to-graph public
    :for-allowed-group "public"))
```

Do not set `DEFAULT_MU_AUTH_SCOPE`: it would scope every query, the report
run too.

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

   The profile names itself (`owl:Ontology` and `dct:title`) and holds two
   entities. A bestuurseenheid has a name and links to its soort bestuur.

2. Restart the service. It reads the profiles at boot.

   ```sh
   docker compose restart natural-language-report
   ```

   The log shows `[profile] "Besturen" (besturen.ttl): 2 entities, 3 fields`.
   A broken profile stops the service and names the file.

3. Open the chat and ask `Geef alle gemeenten met hun naam.` The assistant
   explains what the report will list and adds the spec as a bijlage
   (`specificatie-<uuid>.ttl`). It looks like this:

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

First the LLM decides whether the user clearly said "run it". That
picks one of two modes.

- **Refine.** The LLM reads the profiles and writes or changes a spec. The
  service checks the spec against its profile, and the LLM fixes what the
  check reports. The answer explains the spec in Dutch and holds it as a
  bijlage. Nothing runs.
- **Execute.** No LLM runs. The service takes the last spec bijlage of the
  conversation, checks it again and runs it as the user. It writes the CSV
  to the share and records a `reporting:Report`. The answer is a fixed text
  with the CSV and the spec. No spec, a spec that no longer checks out or a
  failed run each give a fixed failure text.

A run finds the rows (the subjects of the spec's class that pass its
filters), fetches each column for those rows, pairs the values and writes
the CSV. A large report takes minutes.

No report data reaches the LLM: no rows, no counts, no run errors. It sees
the conversation, the profiles, the check messages, the specs and the code
lists.

## Reference

### Environment variables

| Name | Default | Meaning |
|---|---|---|
| `LLM_BASE_URL` | | OpenAI-compatible endpoint, for example `http://openai-compatible-endpoint.example/v1`. Without it every turn answers with a failure text. |
| `LLM_MODEL` | | for example `glm-5.2` |
| `LLM_API_KEY` | | bearer token, not needed for a local Ollama |
| `PROFILE_DIR` | `/config/profiles` | folder with the profiles, one `.ttl` file each |
| `SHARE_DIR` | `/share` | where CSVs and specs are written |
| `SERVICE_SCOPE` | `http://services.semantic.works/natural-language-report` | scope of the code-list reads |
| `CHAT_ASSISTANT_URI` | `http://data.lblod.info/id/chat-agents/rapportassistent` | agent that signs the answers |
| `CHAT_HISTORY_LIMIT` | `20` | messages of history a turn reads |
| `REPORT_CLASS` | `http://lblod.data.gift/vocabularies/reporting/Report` | type of the report resource |
| `CSV_SEPARATOR` | `;` | CSV column separator |
| `ROW_LIMIT` | `200000` | a report with more rows fails, it is never cut |
| `MAX_PATH_DEPTH` | `8` | longest path in a spec |
| `INLINE_VALUES_MAX` | `50` | code lists up to this size are shown to the LLM in full |
| `VALUES_TTL` | `3600` | seconds the code lists are cached |
| `SEED_PAGE_SIZE` | `5000` | page size when the run fetches the rows |
| `SUBJECT_CHUNK_SIZE` | `100` | rows per column query; lower it when the database refuses long queries |
| `MAX_ROUNDS` | `12` | LLM calls per turn while it writes a spec |
| `LLM_RETRIES` | `3` | retries of an LLM call that fails on the network (no connection, a reset, no answer) or with a status in `LLM_RETRY_STATUS`. Other failures fail at once. |
| `LLM_RETRY_STATUS` | `500,502,503,504` | the statuses that are retried; add for example `429` or `408` |
| `LLM_RETRY_DELAY` | `2000` | ms before the first retry; each next one waits twice as long. A `Retry-After` from the provider wins, up to 60 s. |
| `LOG_LLM` | `false` | log every LLM request and response |

### API

#### POST /assistant/conversations/:id/turns

Body `{ "content": "..." }`. Stores the question and answers `202` with the
message id. The answer comes later as a new message in the conversation. The
frontend polls the conversation for it.

#### DELETE /assistant/conversations/:id

Deletes the conversation, its messages, their bijlagen (triples and files)
and the reports of those files. Answers `204`, or `404` when the user cannot
read the conversation.

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
| `reporting:Report` | one per run; `prov:generated` points to the CSV |

The two bijlage types:

- `http://lblod.data.gift/concepts/6693014e-7b7d-448c-bb24-80c9758521f3` Rapportspecificatie
- `http://lblod.data.gift/concepts/28d97698-e219-4a92-bdbd-7ab367a7524e` Uitgevoerd rapport

### Profile

A profile lists the kinds of things in the data (entities), what each one
has (fields) and which fields lead to other entities (links). The LLM gets
it as a menu, and the check tests every step of a spec against it. Nothing
checks the data against a profile.

| You write | It means |
|---|---|
| `owl:Ontology` + `dct:title` | the profile. A spec names this URI in `rep:profile`. |
| `sh:NodeShape` | an entity |
| `rdfs:label` on the entity | its name in the menu. Keep it unique in the profile. |
| `sh:targetClass` | the `rdf:type` of the entity |
| `sh:property` + `sh:path` | a field: one step, a predicate or `[ sh:inversePath p ]` |
| `sh:name` | the field's name in the menu |
| `sh:datatype` | a value field: a column may end here |
| `sh:class` | a code-list field: a column may end here. Short lists show in the menu in full. |
| `sh:node` | a link to another entity |
| `sh:or ( [ sh:node A ] [ sh:node B ] )` | a link that reaches A or B |

The service ignores `sh:description`, cardinality and field paths of more
than one step.

When one step can reach entities of different kinds, write one field with
`sh:or`, not two fields on one path:

```turtle
sh:property [ sh:path [ sh:inversePath besluit:bestuurt ] ; sh:name "bestuursorganen" ;
              sh:or ( [ sh:node ent:Bestuursorgaan ] [ sh:node ent:LeidinggevendBestuursorgaan ] ) ] .
```

### Spec

The LLM writes one spec per question. A spec has two halves: which rows,
and what the CSV shows about each row.

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
| `rep:entity` | which entity, when several share the class |
| `sh:property` | a filter: keep only the subjects that pass |

A filter has a `sh:path` from the row and a test. When the path reaches
several values, the row passes if one of them passes.

| Test | Keeps the row when |
|---|---|
| `sh:hasValue x` | the path reaches x |
| `sh:in ( x y )` | the path reaches x or y |
| `sh:minInclusive`, `sh:maxInclusive`, `sh:minExclusive`, `sh:maxExclusive` | a date or number at the end lies in range |
| `sh:pattern` (+ `sh:flags`) | a value matches the regex |
| `rep:anyOf ( "woord" ... )` | a value holds one of these words, case aside (at most 24 words) |
| `sh:minCount 1` | the path leads somewhere |
| `sh:minCount 2` | the path reaches two different values |
| `sh:maxCount 0` | the path leads nowhere |
| `sh:maxCount 0` with `sh:in` or `sh:hasValue` | the path reaches none of these values |

The service cannot count: a higher `sh:minCount` or `sh:maxCount` is refused.

#### What the CSV shows

`rep:columns` is a list. Each item becomes a column, in that order.

| You write | It means |
|---|---|
| `sh:path ( ... )` | the steps from the row to the value |
| `sh:path rep:self` | the row's own URI |
| `rdfs:label` | the column header; required and unique |
| `sh:nodeKind sh:IRI` | show the URI of the node the path ends on |
| no `rep:collect`, or `rep:collect rep:row` | each value gets its own row; at most one column may say `rep:row` |
| `rep:collect sh:groupConcat` (+ `sh:separator`) | all values in one cell |
| `rep:collect sh:min` / `sh:max` | the lowest or highest date or number |

Columns that walk the same steps share the nodes on those steps, and their
values pair by those nodes: one mayor's first and last name stay on one
row. Where paths split and both sides have several values, every
combination becomes a row. A missing value is an empty cell. Identical rows
show once.

## Advanced topics

### Entities that share a class

A profile may hold several entities of one class. The portal's
`mandaten.ttl` has four kinds of `besluit:Bestuursorgaan`: political and
leidinggevend, each fixed and in time. `rep:discriminator` says which
subjects belong to an entity, and a spec picks the entity with
`rep:entity`.

A discriminator is written like a spec filter: a `sh:path` of any length
and a test. Several on one entity must all hold. `sh:and`, `sh:or` and
`sh:not` combine them.

```turtle
# fixed, and its classification is in the list
ent:LeidinggevendBestuursorgaan
  rep:discriminator [ sh:path generiek:isTijdspecialisatieVan ; sh:maxCount 0 ] ;
  rep:discriminator [ sh:path org:classification ; sh:in ent:LeidinggevendeOrgaanClassificaties ] .
```

A rule or a list can be a named node, used in several places. `sh:not` on a
named rule gives its exact opposite, so two entities split a class with no
overlap and no gap:

```turtle
ent:IsLeidinggevendOrgaan sh:path org:classification ;
  sh:in ent:LeidinggevendeOrgaanClassificaties .

ent:LeidinggevendBestuursorgaan rep:discriminator ent:IsLeidinggevendOrgaan .
ent:Bestuursorgaan              rep:discriminator [ sh:not ent:IsLeidinggevendOrgaan ] .
```

Write a named list out: `ent:X rdf:first <a> ; rdf:rest ( <b> <c> ) .` Do
not type a named rule `sh:NodeShape`, or it becomes an entity.

Test what a thing is, not what hangs off it. The classification says what
an organ is. "Has a bestuursfunctie" trusts the data: an organ that lost
its functie moves to the other entity, and no report finds it.

### A test on the way: `rep:where`

A filter tests the end of its path. `rep:where` tests a node on the way.
Write it like a filter, with its path from the row. The steps it shares with
its column or filter are the same nodes. On a filter it drops rows, on a
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

Profiles and specs borrow the words of SHACL, so a SHACL tool can read
them. We use them for other jobs.

A profile, read as SHACL, says what good data looks like. We read it as a
map and never check data with it. One term changes the meaning:
`rep:discriminator` narrows `sh:targetClass`. In SHACL four shapes on one
class mean every subject must fit all four; here a subject belongs only to
the shapes whose discriminators it meets.

A spec is valid SHACL syntax with its own meaning. A SHACL tool reads it as
a check and reports which subjects fail. We read it as a query: the rows
are the subjects that pass. Most terms agree. `sh:in`, ranges and
`sh:pattern` do not: in SHACL every value must pass, in a spec one value is
enough. Reports ask for "persons with a burgemeester mandate", and SHACL's
reading would drop a person who holds a second mandate too. The `rep:` terms
and the CSV half have no SHACL meaning.

### Limits

No counting, no sorting, no top-N, no comparing two subjects. One class per
report. Filter suggestions read only what the service scope may read.

## Discussion

### Why a report spec and not SPARQL

The LLM could write SPARQL directly. This we didn't do, becauuse:

- Safety. Even when the service runs the query, the LLM decides what it
  does. With SPARQL it can do odd things.
- SPARQL can do too much to check it against the profile. A report needs
  rows of one class, some filters and some columns. A spec only says that,
  so all of it can be checked.
- A report is often several queries: first the rows, then the columns in
  batches, joined on URI. The service does this. One big query with an
  `OPTIONAL` per column is slow and repeats rows.
- A spec is RDF, so it can be stored in the database, linked to its report
  and shared. Anyone who runs it gets the rows they may see. Today it is
  stored as a file.
  - The spec can be reused in totally different contexts.

This doesn't come for free of course.
