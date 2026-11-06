# natural-language-report-service

A chat assistant. The user asks for a report in Dutch and gets a CSV.

The user asks for a report. An LLM writes a report spec and explains it in
Dutch. The user confirms. The service checks the spec and runs it as the
user. The LLM does not write SPARQL. The LLM does not see the data of the
report.

Work in progress, POC phase. Scheduled reports stay in
`loket-report-generation-service`.

