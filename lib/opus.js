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

async function presignUpload(originalName) {
  const ext = (String(originalName).split('.').pop() || 'pdf').toLowerCase();
  const ws = await resolveWorkspace();
  return opusFetch('/job/file/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileExtension: ext,
      originalName,
      accessScope: 'workspace',
      workspaceId: ws.id,
      workflowId: OPUS_WORKFLOW_ID,
    }),
  }); // -> { presignedUrl, fileUrl }
}

// No Content-Type header on the presigned PUT: sending one causes a 403.
async function putToPresigned(presignedUrl, buffer) {
  const res = await fetch(presignedUrl, { method: 'PUT', body: buffer });
  if (!res.ok) {
    const { text } = await readBody(res);
    const err = new Error(`Upload to storage failed: ${res.status} ${text.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
}

async function startJob(title, payload) {
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

const getStatus = (id) => opusFetch(`/job/${encodeURIComponent(id)}/status`);
const getResults = (id) => opusFetch(`/job/${encodeURIComponent(id)}/results`);
const getAudit = (id) => opusFetch(`/job/${encodeURIComponent(id)}/audit`);
const getJob = (id) => opusFetch(`/job/${encodeURIComponent(id)}`);
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
};
