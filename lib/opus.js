// Thin client for the Opus Jobs API. Only the server ever calls this; the
// service key never reaches the browser.

const OPUS_BASE_URL = (process.env.OPUS_BASE_URL || 'https://operator.opus.com').replace(/\/+$/, '');
const OPUS_SERVICE_KEY = process.env.OPUS_SERVICE_KEY;
const OPUS_WORKSPACE_ID = process.env.OPUS_WORKSPACE_ID;
const OPUS_WORKFLOW_ID = process.env.OPUS_WORKFLOW_ID || 'a4d8bb6a-4dab-4562-8ad9-f034d1d794da';

// /job/execute rejects an empty callbackUrl, but this app polls instead of
// using job callbacks, so any valid URL will do. It is never called.
const OPUS_CALLBACK_URL = process.env.OPUS_CALLBACK_URL || 'https://example.com/opus-callback';

// Read responses as text first: a gateway error returns an HTML page and a bare
// res.json() would hide the status code behind a parse error.
async function readBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

async function opusFetch(reqPath, options = {}, { retries = 3, timeoutMs = 20000 } = {}) {
  const url = `${OPUS_BASE_URL}${reqPath}`;
  const headers = {
    'x-service-key': OPUS_SERVICE_KEY || '',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (netErr) {
      if (attempt < retries) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }
      const err = new Error(`Could not reach Opus (${options.method || 'GET'} ${reqPath}): ${netErr.message}`);
      err.status = 502;
      throw err;
    }

    if (res.ok) {
      const { json, text } = await readBody(res);
      return json !== null ? json : text;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }

    const { text } = await readBody(res);
    const err = new Error(`Opus ${options.method || 'GET'} ${reqPath} failed: ${res.status} ${text.slice(0, 500)}`);
    err.status = res.status;
    err.opus = true;
    throw err;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Files must be uploaded into the SAME workspace the workflow lives in, or the
// workflow's agents get 403 Forbidden when they try to read them. The
// workspace is read from the workflow itself; OPUS_WORKSPACE_ID is only a
// fallback for when that lookup fails.
let workspaceCache = null; // { id, source, envMismatch }

function pickWorkspaceId(wf) {
  if (!wf || typeof wf !== 'object') return null;
  const cands = [wf.workspaceId, wf.workspace_id, wf.workspace && wf.workspace.id,
    wf.workflow && (wf.workflow.workspaceId || wf.workflow.workspace_id), wf.data && (wf.data.workspaceId || wf.data.workspace_id)];
  return cands.find((x) => typeof x === 'string' && x.length > 8) || null;
}

async function resolveWorkspace() {
  if (workspaceCache && workspaceCache.source === 'workflow') return workspaceCache;
  let fromWorkflow = null;
  try {
    fromWorkflow = pickWorkspaceId(await getWorkflow());
  } catch (e) {
    console.error('workflow workspace lookup failed', e.message);
  }
  if (fromWorkflow) {
    workspaceCache = {
      id: fromWorkflow,
      source: 'workflow',
      envMismatch: Boolean(OPUS_WORKSPACE_ID && OPUS_WORKSPACE_ID !== fromWorkflow),
    };
    if (workspaceCache.envMismatch) {
      console.warn(`OPUS_WORKSPACE_ID (${OPUS_WORKSPACE_ID}) differs from the workflow's workspace (${fromWorkflow}); using the workflow's.`);
    }
  } else {
    workspaceCache = { id: OPUS_WORKSPACE_ID || null, source: OPUS_WORKSPACE_ID ? 'env' : 'none', envMismatch: false };
  }
  return workspaceCache;
}

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', txt: 'text/plain' };

// How files are uploaded. The defaults follow the Opus docs; an admin can
// change them at runtime (stored in Redis) when Opus changes its storage
// rules, without a redeploy. cfg = { scope, dotExt, type, withWorkspace, withWorkflow }
const DEFAULT_UPLOAD = { scope: 'workspace', dotExt: true, type: 'mime', withWorkspace: true, withWorkflow: true };

async function presignUpload(originalName, cfg) {
  const c = { ...DEFAULT_UPLOAD, ...(cfg || {}) };
  const ext = (String(originalName).split('.').pop() || 'pdf').toLowerCase();
  const body = { fileExtension: (c.dotExt ? '.' : '') + ext, originalName };
  if (c.scope && c.scope !== 'none') body.accessScope = c.scope;
  if (c.withWorkspace) body.workspaceId = (await resolveWorkspace()).id;
  if (c.withWorkflow) body.workflowId = OPUS_WORKFLOW_ID;
  if (c.api === 'v1') {
    // v1 File API: accessScope is "workspace" or "unlisted" only.
    if (body.accessScope && !['workspace', 'unlisted'].includes(body.accessScope)) body.accessScope = 'workspace';
    return opusFetch('/api/v1/file/upload/presigned', { method: 'POST', body: JSON.stringify(body) });
  }
  return opusFetch('/job/file/upload', { method: 'POST', body: JSON.stringify(body) }); // -> { presignedUrl, fileUrl }
}

async function putToPresigned(presignedUrl, buffer, fileName, cfg) {
  const c = { ...DEFAULT_UPLOAD, ...(cfg || {}) };
  const ext = String(fileName || 'file.pdf').split('.').pop().toLowerCase();
  const type = c.type === 'mime' ? MIME[ext] || 'application/octet-stream' : c.type && c.type !== 'none' ? c.type : null;
  let res = await fetch(presignedUrl, { method: 'PUT', body: buffer, headers: type ? { 'Content-Type': type } : {} });
  if (type && (res.status === 403 || res.status === 400)) {
    await readBody(res).catch(() => null);
    res = await fetch(presignedUrl, { method: 'PUT', body: buffer });
  }
  if (!res.ok) {
    const { text } = await readBody(res);
    const err = new Error(`Upload to storage failed: ${res.status} ${text.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
}

// ---- v0 Jobs API and v1 Case API -------------------------------------------
// Opus now documents a v1 Case API (/api/v1/case...) beside the older v0 Jobs
// API (/job/...). Every call takes the API a run was started with; when it is
// not known, a numeric id is a v0 job and anything else a v1 case.
const apiOf = (id, api) => api || (/^\d+$/.test(String(id)) ? 'v0' : 'v1');

async function startJob(title, payload, api) {
  if (api === 'v1') {
    const init = await opusFetch('/api/v1/case', { method: 'POST', body: JSON.stringify({ workflowId: OPUS_WORKFLOW_ID, title }) });
    const caseId = init && (init.caseId || init.id);
    if (!caseId) throw new Error('Opus did not return a caseId.');
    const v1payload = {};
    for (const [k, v] of Object.entries(payload)) v1payload[k] = { value: v.value, type: v.type, ...(v.displayName ? { displayName: v.displayName } : {}) };
    const ex = await opusFetch(`/api/v1/case/${encodeURIComponent(caseId)}/execute`, { method: 'POST', body: JSON.stringify({ payload: v1payload }) });
    if (ex && ex.success === false) throw new Error('Opus could not start the case: ' + JSON.stringify(ex.error || ex).slice(0, 300));
    return String(caseId);
  }
  const v0payload = {};
  for (const [k, v] of Object.entries(payload)) v0payload[k] = { value: v.value, type: v.type };
  payload = v0payload;
  const init = await opusFetch('/job/initiate', {
    method: 'POST',
    body: JSON.stringify({ workflowId: OPUS_WORKFLOW_ID, title }),
  });
  const jobExecutionId = init && init.jobExecutionId;
  if (!jobExecutionId) throw new Error('Opus did not return a jobExecutionId.');
  await opusFetch('/job/execute', {
    method: 'POST',
    body: JSON.stringify({ jobExecutionId, jobPayloadSchemaInstance: payload, callbackUrl: OPUS_CALLBACK_URL }),
  });
  return String(jobExecutionId);
}

// v1 audit is camelCase; the rest of the app reads the v0 (snake_case) shape.
function normalizeAudit(a) {
  if (!a || typeof a !== 'object' || a.nb_nodes !== undefined || a.audit && a.audit.nodes_execution_data) return a;
  const nodes = (a.audit && (a.audit.nodesExecutionData || a.audit.nodes_execution_data)) || {};
  const out = {};
  for (const [k, n] of Object.entries(nodes)) {
    out[k] = {
      execution_status: n.executionStatus ?? n.execution_status,
      execution_start_time: n.executionStartTime ?? n.execution_start_time,
      execution_time: n.executionTime ?? n.execution_time,
      execution_index: n.executionIndex ?? n.execution_index,
      execution_input: (n.executionInput ?? n.execution_input) || [],
      execution_output: (n.executionOutput ?? n.execution_output) || [],
    };
  }
  return {
    nb_nodes: a.totalNodeCount, running_node: a.runningNode || '', next_node_to_execute: a.nextNode || '',
    remaining_nodes_to_execute: a.remainingNodesToExecute || [], executed_nodes: a.executedNodes || [],
    nb_executed_nodes: a.executedNodeCount, failed_nodes: a.failedNodes || [], nb_failed_nodes: a.failedNodeCount,
    audit: { nodes_execution_data: out }, _api: 'v1',
  };
}

const getStatus = (id, api) => opusFetch(apiOf(id, api) === 'v1' ? `/api/v1/case/${encodeURIComponent(id)}/status` : `/job/${encodeURIComponent(id)}/status`);
const getResults = (id, api) => opusFetch(apiOf(id, api) === 'v1' ? `/api/v1/case/${encodeURIComponent(id)}/results` : `/job/${encodeURIComponent(id)}/results`);
const getAudit = async (id, api) => (apiOf(id, api) === 'v1'
  ? normalizeAudit(await opusFetch(`/api/v1/case/${encodeURIComponent(id)}/audit`))
  : opusFetch(`/job/${encodeURIComponent(id)}/audit`));
// v1 has no job-details call; callers already treat null as "not known".
const getJob = async (id, api) => (apiOf(id, api) === 'v1' ? null : opusFetch(`/job/${encodeURIComponent(id)}`));
const getWorkflow = () => opusFetch(`/workflow/${OPUS_WORKFLOW_ID}`, {}, { retries: 1, timeoutMs: 8000 });

module.exports = {
  OPUS_BASE_URL,
  OPUS_SERVICE_KEY,
  OPUS_WORKSPACE_ID,
  OPUS_WORKFLOW_ID,
  opusFetch,
  presignUpload,
  putToPresigned,
  startJob,
  getStatus,
  getResults,
  getAudit,
  getJob,
  getWorkflow,
  resolveWorkspace,
  readBody,
  DEFAULT_UPLOAD,
  normalizeAudit,
  apiOf,
};
