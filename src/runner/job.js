import { randomUUID } from 'crypto';
import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime } from '../db.js';

// cogs:Job + task:Task, written by us; no other service is involved. Every
// write carries mu-call-scope-id (REPORT_SCOPE) so the delta notifier lets
// jobs-controller ignore our statuses — it throws on unknown operations.

const REPORT_SCOPE = 'http://redpencil.data.gift/id/concept/muScope/report-generation';
const JOB_BASE = process.env.JOB_URI_BASE || 'http://redpencil.data.gift/id/job/';
const TASK_BASE = process.env.TASK_URI_BASE || 'http://redpencil.data.gift/id/task/';
const STATUS = {
  scheduled: 'http://redpencil.data.gift/id/concept/JobStatus/scheduled',
  busy: 'http://redpencil.data.gift/id/concept/JobStatus/busy',
  success: 'http://redpencil.data.gift/id/concept/JobStatus/success',
  failed: 'http://redpencil.data.gift/id/concept/JobStatus/failed',
};
const JOB_OPERATION = 'http://lblod.data.gift/id/jobs/concept/JobOperation/reportGeneration';
const TASK_OPERATION = 'http://lblod.data.gift/id/jobs/concept/TaskOperation/reportGeneration';

const COGS_JOB = 'http://vocab.deri.ie/cogs#Job';
const TASK_TASK = 'http://redpencil.data.gift/vocabularies/tasks/Task';
const DATA_CONTAINER = 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#DataContainer';

const MU_UUID = 'http://mu.semte.ch/vocabularies/core/uuid';
const ADMS_STATUS = 'http://www.w3.org/ns/adms#status';
const DCT = 'http://purl.org/dc/terms/';
const TASK = 'http://redpencil.data.gift/vocabularies/tasks/';
const OSLC_MESSAGE = 'http://open-services.net/ns/core#message';
const OSLC_ERROR_URI = 'http://open-services.net/ns/core#Error';

// Adds the scope header to every job write.
function withScope(updateFn) {
  return async sparql => updateFn(sparql, { 'mu-call-scope-id': REPORT_SCOPE });
}

// Create job + task + result container, all at status scheduled.
// Returns { jobUri, taskUri, containerUri }.
export async function createJob(updateFn, title, question, creator) {
  const upd = withScope(updateFn);
  const jobId = randomUUID();
  const taskId = randomUUID();
  const containerId = randomUUID();
  const jobUri = `${JOB_BASE}${jobId}`;
  const taskUri = `${TASK_BASE}${taskId}`;
  const containerUri = `http://redpencil.data.gift/id/dataContainers/${containerId}`;
  const now = sparqlEscapeDateTime(new Date());

  const creatorTriple = creator
    ? `${sparqlEscapeUri(jobUri)} ${sparqlEscapeUri(DCT + 'creator')} ${sparqlEscapeUri(creator)} .`
    : '';
  const questionTriple = question
    ? `${sparqlEscapeUri(jobUri)} ${sparqlEscapeUri('http://mu.semte.ch/vocabularies/ext/question')} ${sparqlEscapeString(question)} .`
    : '';

  await upd(`
    INSERT DATA {
      ${sparqlEscapeUri(jobUri)} a ${sparqlEscapeUri(COGS_JOB)} ;
        ${sparqlEscapeUri(MU_UUID)} ${sparqlEscapeString(jobId)} ;
        ${sparqlEscapeUri(DCT + 'title')} ${sparqlEscapeString(title)} ;
        ${sparqlEscapeUri(ADMS_STATUS)} ${sparqlEscapeUri(STATUS.scheduled)} ;
        ${sparqlEscapeUri(TASK + 'operation')} ${sparqlEscapeUri(JOB_OPERATION)} ;
        ${sparqlEscapeUri(DCT + 'created')} ${now} ;
        ${sparqlEscapeUri(DCT + 'modified')} ${now} .
      ${creatorTriple}
      ${questionTriple}
      ${sparqlEscapeUri(taskUri)} a ${sparqlEscapeUri(TASK_TASK)} ;
        ${sparqlEscapeUri(MU_UUID)} ${sparqlEscapeString(taskId)} ;
        ${sparqlEscapeUri(DCT + 'isPartOf')} ${sparqlEscapeUri(jobUri)} ;
        ${sparqlEscapeUri(ADMS_STATUS)} ${sparqlEscapeUri(STATUS.scheduled)} ;
        ${sparqlEscapeUri(TASK + 'operation')} ${sparqlEscapeUri(TASK_OPERATION)} ;
        ${sparqlEscapeUri(TASK + 'index')} ${sparqlEscapeString('0')} ;
        ${sparqlEscapeUri(DCT + 'created')} ${now} ;
        ${sparqlEscapeUri(DCT + 'modified')} ${now} ;
        ${sparqlEscapeUri(TASK + 'resultsContainer')} ${sparqlEscapeUri(containerUri)} .
      ${sparqlEscapeUri(containerUri)} a ${sparqlEscapeUri(DATA_CONTAINER)} ;
        ${sparqlEscapeUri(MU_UUID)} ${sparqlEscapeString(containerId)} .
    }`);

  return { jobUri, taskUri, containerUri };
}

export async function setStatus(updateFn, uri, status) {
  const s = STATUS[status];
  if (!s) throw new Error(`unknown job status "${status}"`);
  const now = sparqlEscapeDateTime(new Date());
  await withScope(updateFn)(`
    DELETE {
      ${sparqlEscapeUri(uri)} ${sparqlEscapeUri(ADMS_STATUS)} ?old ;
        ${sparqlEscapeUri(DCT + 'modified')} ?modified .
    }
    INSERT {
      ${sparqlEscapeUri(uri)} ${sparqlEscapeUri(ADMS_STATUS)} ${sparqlEscapeUri(s)} ;
        ${sparqlEscapeUri(DCT + 'modified')} ${now} .
    }
    WHERE {
      ${sparqlEscapeUri(uri)} ${sparqlEscapeUri(ADMS_STATUS)} ?old .
      OPTIONAL { ${sparqlEscapeUri(uri)} ${sparqlEscapeUri(DCT + 'modified')} ?modified . }
    }`);
}

export async function touch(updateFn, taskUri) {
  const now = sparqlEscapeDateTime(new Date());
  await withScope(updateFn)(`
    DELETE {
      ${sparqlEscapeUri(taskUri)} ${sparqlEscapeUri(DCT + 'modified')} ?modified .
    }
    INSERT {
      ${sparqlEscapeUri(taskUri)} ${sparqlEscapeUri(DCT + 'modified')} ${now} .
    }
    WHERE {
      OPTIONAL { ${sparqlEscapeUri(taskUri)} ${sparqlEscapeUri(DCT + 'modified')} ?modified . }
    }`);
}

// Link the finished CSV to the task's result container. The container is
// created with the job; the file URI is the logical file from registerFile.
export async function attachResult(updateFn, taskUri, fileUri) {
  await withScope(updateFn)(`
    INSERT {
      ?container ${sparqlEscapeUri(TASK + 'hasFile')} ${sparqlEscapeUri(fileUri)} .
    }
    WHERE {
      ${sparqlEscapeUri(taskUri)} ${sparqlEscapeUri(TASK + 'resultsContainer')} ?container .
    }`);
}

// An oslc:Error with the message, job and task both failed.
export async function fail(updateFn, jobUri, taskUri, message) {
  const errorId = randomUUID();
  const errorUri = `http://redpencil.data.gift/id/jobs/error/${errorId}`;
  const now = sparqlEscapeDateTime(new Date());
  await withScope(updateFn)(`
    DELETE {
      ${sparqlEscapeUri(jobUri)} ${sparqlEscapeUri(ADMS_STATUS)} ?js .
      ${sparqlEscapeUri(taskUri)} ${sparqlEscapeUri(ADMS_STATUS)} ?ts .
    }
    INSERT DATA {
      ${sparqlEscapeUri(errorUri)} a ${sparqlEscapeUri(OSLC_ERROR_URI)} ;
        ${sparqlEscapeUri(MU_UUID)} ${sparqlEscapeString(errorId)} ;
        ${sparqlEscapeUri(OSLC_MESSAGE)} ${sparqlEscapeString(message)} ;
        ${sparqlEscapeUri(DCT + 'created')} ${now} .
      ${sparqlEscapeUri(taskUri)} ${sparqlEscapeUri(TASK + 'error')} ${sparqlEscapeUri(errorUri)} ;
        ${sparqlEscapeUri(ADMS_STATUS)} ${sparqlEscapeUri(STATUS.failed)} ;
        ${sparqlEscapeUri(DCT + 'modified')} ${now} .
      ${sparqlEscapeUri(jobUri)} ${sparqlEscapeUri(ADMS_STATUS)} ${sparqlEscapeUri(STATUS.failed)} ;
        ${sparqlEscapeUri(DCT + 'modified')} ${now} .
    }
    WHERE {
      ${sparqlEscapeUri(jobUri)} ${sparqlEscapeUri(ADMS_STATUS)} ?js .
      ${sparqlEscapeUri(taskUri)} ${sparqlEscapeUri(ADMS_STATUS)} ?ts .
    }`);
}