// AP Invoice Validation console - Express backend.
//
// The browser only ever talks to this server. This server is the only thing
// that holds the Opus service key and the only thing that calls Opus.
//
// Flow:
//   1. Clerk uploads Invoice / PO / Goods Receipt PDFs  -> /api/upload-url (+ direct PUT) or /api/upload
//   2. Clerk submits                                    -> /api/cases  (POST: /job/initiate + /job/execute)
//   3. Browser polls                                    -> /api/cases/:id (this server asks Opus)
//   4. If the 3-way match has exceptions, Opus PUSHES the Human Task to
//                                                          /api/opus-webhook/human-review
//      (the Human Task node must be set to off-platform with that webhook URL)
//   5. Approver opens the review queue, decides         -> /api/reviews/:id (POST: callback to Opus)
//   6. Workflow resumes, applies decisions, finishes    -> outputs shown on the case page

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

const store = require('./lib/store');
const auth = require('./lib/auth');
const opus = require('./lib/opus');

// ---------------------------------------------------------------------------
// Workflow contract: AP Invoice Validation (read from the Opus builder, v1.4)
// ---------------------------------------------------------------------------

const INPUT_VARS = {
  invoice: process.env.OPUS_INPUT_INVOICE || 'workflow_input_fc7cbfofm',
  purchaseOrder: process.env.OPUS_INPUT_PURCHASE_ORDER || 'workflow_input_8upjan24d',
  goodsReceipt: process.env.OPUS_INPUT_GOODS_RECEIPT || 'workflow_input_6t6ox3vk4',
};

const OUTPUT_VARS = {
  paymentObject: process.env.OPUS_OUTPUT_PAYMENT_OBJECT || 'workflow_output_ktpjr7h2v',
  auditTrail: process.env.OPUS_OUTPUT_AUDIT_TRAIL || 'workflow_output_zx8kqm9p1',
  justificationSummary: process.env.OPUS_OUTPUT_JUSTIFICATION_SUMMARY || 'workflow_output_jb2nmeq6z',
};

// The Human Task node and the two things it is given to show the reviewer.
// These are the node's own INPUT variable ids, which is how Opus keys the
// dispatch's `inputs` object.
const HUMAN_NODE_ID = process.env.OPUS_HUMAN_NODE_ID || '5b8d6961-fdc1-4c35-ab2c-a195671b2b58';
const REVIEW_INPUT_VARS = {
  exceptionBrief: process.env.OPUS_REVIEW_INPUT_EXCEPTION_BRIEF || 'workflow_input_1xarf585r',
  analystPresentation: process.env.OPUS_REVIEW_INPUT_ANALYST_PRESENTATION || 'workflow_input_7sy7k0gel',
};

// The Human Task's single output ("Human Response", free text). Opus has been
// seen regenerating these ids whenever the node is edited, so the id is taken
// from each dispatch's expected_output_schema first; this is only the fallback.
const REVIEW_OUTPUT_FALLBACK = process.env.OPUS_REVIEW_OUTPUT_RESPONSE || 'workflow_output_ojzd94z8j';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ALLOW_SELF_REVIEW = String(process.env.ALLOW_SELF_REVIEW || '').toLowerCase() === 'true';
const REVIEW_TIMEOUT_MINUTES = Number(process.env.REVIEW_TIMEOUT_MINUTES) || 10;
// Demo mode (on unless DEMO_MODE=false): the login page offers one-click
// Demo Clerk / Demo Approver / Demo Admin accounts. Turn it off for real use.
const DEMO_MODE = String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'false';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const FAILURE = ['FAILED', 'CANCELLED', 'TIMED_OUT'];

function missingEnv() {
  const missing = [];
  if (!opus.OPUS_SERVICE_KEY) missing.push('OPUS_SERVICE_KEY');
  if (!opus.OPUS_WORKSPACE_ID) missing.push('OPUS_WORKSPACE_ID');
  if (!auth.sessionSecretConfigured()) missing.push('SESSION_SECRET (32+ characters, or set OPUS_SERVICE_KEY)');
  if (!store.durable) missing.push('Redis / KV store (KV_REST_API_URL + KV_REST_API_TOKEN, or REDIS_URL)');
  return missing;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// The Opus webhook is registered BEFORE the session/CSRF middleware: it is
// called by Opus's servers, not a browser, and carries no session.
app.post(['/api/opus-webhook/human-review', '/api/opus-webhook/human-review/:key'], handleDispatch);

app.use('/api', auth.loadUser, auth.requireAjaxHeader);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Health and config
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  const missing = missingEnv();
  res.json({ ok: missing.length === 0, missing, storage: store.kind });
});

app.get('/api/config', auth.requireRole('admin'), (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    opusHost: opus.OPUS_BASE_URL,
    workflowId: opus.OPUS_WORKFLOW_ID,
    workspaceConfigured: Boolean(opus.OPUS_WORKSPACE_ID),
    serviceKeyConfigured: Boolean(opus.OPUS_SERVICE_KEY),
    storage: store.kind,
    storageDurable: store.durable,
    webhookUrl: `${base}/api/opus-webhook/human-review${WEBHOOK_SECRET ? '/<WEBHOOK_SECRET>' : ''}`,
    webhookSecretConfigured: Boolean(WEBHOOK_SECRET),
    allowSelfReview: ALLOW_SELF_REVIEW,
    demoMode: DEMO_MODE,
    sessionSecretDerived: auth.sessionSecretIsDerived(),
    reviewTimeoutMinutes: REVIEW_TIMEOUT_MINUTES,
    inputs: INPUT_VARS,
    outputs: OUTPUT_VARS,
    humanNodeId: HUMAN_NODE_ID,
    reviewInputs: REVIEW_INPUT_VARS,
    reviewOutputFallback: REVIEW_OUTPUT_FALLBACK,
    missing: missingEnv(),
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const out = { user: auth.publicUser(req.user) };
  if (req.user.role === 'admin') out.setupWarnings = missingEnv();
  res.json(out);
});

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  if (!auth.sessionSecretConfigured()) {
    return res.status(503).json({ error: 'Sign-in is not configured yet: SESSION_SECRET is missing or too short.' });
  }

  const key = `ap:login-fail:${auth.normEmail(email)}`;
  const fails = Number(await store.get(key)) || 0;
  if (fails >= 8) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });

  let user = await auth.findUserByEmail(email);
  if (!user) user = await auth.maybeBootstrapAdmin(email, password);

  if (!user || user.active === false || !auth.verifyPassword(password, user.passwordHash)) {
    await store.incr(key, 15 * 60);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  await store.del(key);
  auth.setSessionCookie(req, res, user);
  res.json({ user: auth.publicUser(user) });
}));

app.get('/api/demo', (req, res) => {
  res.json({ enabled: DEMO_MODE, accounts: DEMO_MODE ? auth.DEMO_ACCOUNTS.map((a) => ({ role: a.role, name: a.name })) : [] });
});

app.post('/api/demo-login', wrap(async (req, res) => {
  if (!DEMO_MODE) return res.status(404).json({ error: 'Demo accounts are switched off.' });
  if (!auth.sessionSecretConfigured()) {
    return res.status(503).json({ error: 'Sign-in is not configured yet: set OPUS_SERVICE_KEY (or SESSION_SECRET) and redeploy.' });
  }
  const user = await auth.ensureDemoUser((req.body || {}).role);
  auth.setSessionCookie(req, res, user);
  res.json({ user: auth.publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/me/password', auth.requireUser, wrap(async (req, res) => {
  const { current, next: nextPassword } = req.body || {};
  if (!auth.verifyPassword(current || '', req.user.passwordHash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  await auth.updateUser(req.user.id, { password: nextPassword });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

app.get('/api/users', auth.requireRole('admin'), wrap(async (req, res) => {
  res.json({ users: (await auth.listUsers()).map(auth.publicUser) });
}));

app.post('/api/users', auth.requireRole('admin'), wrap(async (req, res) => {
  const u = await auth.createUser(req.body || {});
  res.status(201).json({ user: auth.publicUser(u) });
}));

app.patch('/api/users/:id', auth.requireRole('admin'), wrap(async (req, res) => {
  const { name, role, active, password } = req.body || {};
  if (req.params.id === req.user.id && (active === false || (role && role !== 'admin'))) {
    return res.status(400).json({ error: 'You cannot demote or disable your own account.' });
  }
  const u = await auth.updateUser(req.params.id, { name, role, active, password });
  res.json({ user: auth.publicUser(u) });
}));

// ---------------------------------------------------------------------------
// Uploads
//
// Preferred path: the browser asks for a presigned URL and PUTs the file
// straight to Opus storage, so large PDFs never pass through a serverless
// function (Vercel caps request bodies at about 4.5 MB). If the direct PUT is
// blocked (CORS), the browser falls back to /api/upload, which proxies the
// bytes and therefore only works for files under ~4 MB on Vercel.
// ---------------------------------------------------------------------------

const SUBMIT_ROLES = ['clerk', 'admin'];

app.post('/api/upload-url', auth.requireRole(...SUBMIT_ROLES), wrap(async (req, res) => {
  const { fileName, size } = req.body || {};
  if (!fileName || !/\.pdf$/i.test(fileName)) return res.status(400).json({ error: 'Only PDF files are accepted.' });
  if (Number(size) > MAX_FILE_BYTES) return res.status(400).json({ error: 'Each file must be 10 MB or smaller.' });
  const { presignedUrl, fileUrl } = await opus.presignUpload(fileName);
  if (!presignedUrl || !fileUrl) throw new Error('Opus did not return an upload URL.');
  res.json({ presignedUrl, fileUrl });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

app.post('/api/upload', auth.requireRole(...SUBMIT_ROLES), upload.single('file'), wrap(async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file received.' });
  const isPdf = file.buffer.slice(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf) return res.status(400).json({ error: `${file.originalname} is not a PDF.` });
  const { presignedUrl, fileUrl } = await opus.presignUpload(file.originalname || 'document.pdf');
  await opus.putToPresigned(presignedUrl, file.buffer);
  res.json({ fileUrl });
}));

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const CASE_KEY = (id) => `ap:case:${id}`;
const CASES_SET = 'ap:cases';

async function getCase(id) {
  return store.get(CASE_KEY(id));
}

async function saveCase(c) {
  await store.set(CASE_KEY(c.jobId), c);
  await store.sadd(CASES_SET, c.jobId);
}

async function patchCase(id, changes) {
  const c = await getCase(id);
  if (!c) return null;
  const next = { ...c, ...changes };
  await saveCase(next);
  return next;
}

async function allCases() {
  const ids = await store.smembers(CASES_SET);
  const cases = await Promise.all(ids.map((id) => getCase(id)));
  return cases.filter(Boolean).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

function canSeeCase(user, c) {
  if (!c) return false;
  if (user.role === 'approver' || user.role === 'admin') return true;
  return c.submittedBy && c.submittedBy.id === user.id;
}

function displayStatus(c) {
  if (c.review && c.review.status === 'pending' && !TERMINAL.includes(c.status)) return 'WAITING_REVIEW';
  return c.status;
}

// The one projection from a stored case to what every screen shows.
function toRow(c) {
  return {
    jobId: c.jobId,
    reference: c.reference || null,
    note: c.note || null,
    submittedBy: c.submittedBy ? { name: c.submittedBy.name, email: c.submittedBy.email } : null,
    submittedAt: c.submittedAt,
    completedAt: c.completedAt || null,
    status: displayStatus(c),
    files: c.files || {},
    summary: c.summary || {},
    hadReview: Boolean(c.review),
    review: c.review
      ? {
          status: c.review.status,
          dispatchId: c.review.dispatchId,
          receivedAt: c.review.receivedAt,
          reviewedBy: c.review.reviewedBy || null,
          reviewedAt: c.review.reviewedAt || null,
          response: c.review.response || null,
        }
      : null,
  };
}

// --- payment-object summary (best effort; the object's exact shape is set by
//     the Output Assembly code node, so a few likely key names are tried) ---

function findKey(obj, names, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
  const lower = names.map((n) => n.toLowerCase());
  for (const want of lower) {
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === want && v !== null && v !== undefined && v !== '') return v;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findKey(v, names, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === 'object') return toNumber(v.amount !== undefined ? v.amount : v.value);
  return null;
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function summarise(paymentObject) {
  const p = parseMaybeJson(paymentObject);
  if (!p || typeof p !== 'object') return {};
  const amount = toNumber(
    findKey(p, ['payable_amount', 'amount_payable', 'approved_amount', 'payment_amount', 'net_payable', 'total_payable', 'amount_to_pay', 'total_amount', 'invoice_total', 'amount', 'total'])
  );
  const currencyRaw = findKey(p, ['currency', 'currency_code', 'ccy']);
  const currency = typeof currencyRaw === 'string' ? currencyRaw.toUpperCase() : null;
  let vendor = findKey(p, ['vendor_name', 'supplier_name', 'vendor', 'supplier', 'payee']);
  if (vendor && typeof vendor === 'object') vendor = vendor.name || vendor.vendor_name || null;
  const invoiceNumber = findKey(p, ['invoice_number', 'invoice_no', 'invoiceNumber', 'invoice_id', 'invoice_ref']);
  const outcome = findKey(p, ['payment_status', 'payment_decision', 'decision', 'outcome', 'status', 'action']);
  return {
    amount: amount,
    currency,
    submittedTotal: amount !== null && amount !== undefined ? `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ' ' + currency : ''}` : null,
    vendor: typeof vendor === 'string' ? vendor : null,
    invoiceNumber: invoiceNumber !== undefined && typeof invoiceNumber !== 'object' ? String(invoiceNumber) : null,
    outcome: outcome !== undefined && typeof outcome !== 'object' ? String(outcome) : null,
  };
}

// Ask Opus where a case is, persist what changed, return live detail.
async function refreshCase(c) {
  if (TERMINAL.includes(c.status) && (c.status !== 'COMPLETED' || c.outputs)) return { c, progress: null };

  const statusResp = await opus.getStatus(c.jobId);
  const status = String((statusResp && statusResp.status) || 'UNKNOWN').toUpperCase();
  const changes = { status, lastCheckedAt: new Date().toISOString() };
  let progress = null;

  if (status === 'COMPLETED') {
    const results = await opus.getResults(c.jobId);
    const payload = (results && (results.jobResultsPayloadSchema || results.results)) || {};
    const outputs = {};
    for (const [key, varName] of Object.entries(OUTPUT_VARS)) {
      const entry = payload[varName];
      outputs[key] = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry ?? null;
    }
    changes.outputs = outputs;
    changes.summary = summarise(outputs.paymentObject);
    changes.completedAt = (await finishedAt(c.jobId)) || new Date().toISOString();
  } else if (FAILURE.includes(status)) {
    let audit = null;
    try {
      audit = await opus.getAudit(c.jobId);
    } catch (e) {
      console.error('audit fetch error', e.message);
    }
    changes.failure = {
      failedNodes: (audit && audit.failed_nodes) || [],
      nextNodeToExecute: (audit && audit.next_node_to_execute) || null,
    };
    changes.completedAt = (await finishedAt(c.jobId)) || new Date().toISOString();
    // A review the workflow gave up on can no longer be answered.
    if (c.review && c.review.status === 'pending') {
      changes.review = { ...c.review, status: 'expired' };
      await expireDispatch(c.review.dispatchId);
    }
  } else {
    try {
      const audit = await opus.getAudit(c.jobId);
      progress = {
        nbNodes: audit.nb_nodes ?? null,
        nbExecutedNodes: audit.nb_executed_nodes ?? null,
        runningNode: nodeName(audit.running_node),
        nextNode: nodeName(audit.next_node_to_execute),
      };
    } catch (e) {
      console.error('progress audit error', e.message);
    }
  }

  const updated = await patchCase(c.jobId, changes);
  return { c: updated || { ...c, ...changes }, progress };
}

function nodeName(n) {
  if (!n) return null;
  if (typeof n === 'string') return n;
  return n.name || n.node_name || n.label || n.id || null;
}

async function finishedAt(jobId) {
  try {
    const d = await opus.getJob(jobId);
    return (d && d.finishedAt) || null;
  } catch {
    return null;
  }
}

app.post('/api/cases', auth.requireRole(...SUBMIT_ROLES), wrap(async (req, res) => {
  const { files, reference, note } = req.body || {};
  const f = files || {};
  const required = [
    ['invoice', 'Invoice'],
    ['purchaseOrder', 'Purchase Order'],
    ['goodsReceipt', 'Goods Receipt'],
  ];
  for (const [k, label] of required) {
    if (!f[k] || typeof f[k].fileUrl !== 'string' || !/^https:\/\//.test(f[k].fileUrl)) {
      return res.status(400).json({ error: `${label} file is required.` });
    }
  }

  const ref = String(reference || '').trim().slice(0, 80) || null;
  const payload = {
    [INPUT_VARS.invoice]: { value: f.invoice.fileUrl, type: 'file' },
    [INPUT_VARS.purchaseOrder]: { value: f.purchaseOrder.fileUrl, type: 'file' },
    [INPUT_VARS.goodsReceipt]: { value: f.goodsReceipt.fileUrl, type: 'file' },
  };

  const title = `AP Invoice Validation${ref ? ' - ' + ref : ''}`;
  const jobId = await opus.startJob(title, payload);

  const c = {
    jobId,
    reference: ref,
    note: String(note || '').trim().slice(0, 500) || null,
    submittedBy: { id: req.user.id, name: req.user.name, email: req.user.email },
    submittedAt: new Date().toISOString(),
    status: 'IN_PROGRESS',
    files: {
      invoice: { name: String(f.invoice.name || 'invoice.pdf').slice(0, 200) },
      purchaseOrder: { name: String(f.purchaseOrder.name || 'purchase-order.pdf').slice(0, 200) },
      goodsReceipt: { name: String(f.goodsReceipt.name || 'goods-receipt.pdf').slice(0, 200) },
    },
    summary: {},
    review: null,
  };
  await saveCase(c);
  res.status(201).json({ case: toRow(c) });
}));

app.get('/api/cases', auth.requireUser, wrap(async (req, res) => {
  let cases = (await allCases()).filter((c) => canSeeCase(req.user, c));

  // Refresh a few stale in-flight cases so the queue isn't frozen when nobody
  // has a case page open. Capped to stay well under Opus's rate limit.
  const stale = cases
    .filter((c) => !TERMINAL.includes(c.status) && Date.now() - new Date(c.lastCheckedAt || 0).getTime() > 60000)
    .slice(0, 4);
  if (stale.length && opus.OPUS_SERVICE_KEY) {
    const refreshed = await Promise.all(stale.map((c) => refreshCase(c).then((r) => r.c).catch(() => c)));
    const byId = new Map(refreshed.map((c) => [c.jobId, c]));
    cases = cases.map((c) => byId.get(c.jobId) || c);
  }
  res.json({ cases: cases.map(toRow) });
}));

app.get('/api/cases/:id', auth.requireUser, wrap(async (req, res) => {
  const c = await getCase(req.params.id);
  // 404, not 403: a 403 would confirm the case exists.
  if (!canSeeCase(req.user, c)) return res.status(404).json({ error: 'Case not found.' });

  let current = c;
  let progress = null;
  let refreshError = null;
  try {
    const r = await refreshCase(c);
    current = r.c;
    progress = r.progress;
  } catch (err) {
    console.error('refresh error', err.message);
    refreshError = 'Could not reach Opus just now. Showing the last known state.';
  }

  res.json({
    case: toRow(current),
    outputs: current.outputs || null,
    failure: current.failure || null,
    progress,
    refreshError,
  });
}));

// ---------------------------------------------------------------------------
// Off-platform Human Task
//
// Exchange 1 (Opus -> us): POST /api/opus-webhook/human-review
//   { execution_id, workflow_id, workflow_name, inputs,
//     callback: { url, token, token_header }, expected_output_schema }
//   Must be acknowledged with a 2xx within 15 seconds.
//
// Exchange 2 (us -> Opus): POST callback.url with header
//   [callback.token_header]: callback.token
//   body { output_data: { <output id>: { value, type: { type, type_definition } } }, status: 'success' }
//   The token is single-use.
//
// Unlike the KYC console, every dispatch is stored in Redis (not process
// memory), so it survives cold starts and is visible to every serverless
// instance. Dispatches are keyed by Opus's execution_id, which is NOT the
// jobExecutionId we poll with, and are linked to their case by matchDispatch().
// The review queue is driven by the stored dispatches, so a review can always
// be actioned even if the link to its case cannot be established.
// ---------------------------------------------------------------------------

const DISPATCH_KEY = (id) => `ap:dispatch:${id}`;
const PENDING_SET = 'ap:dispatches:pending';

async function handleDispatch(req, res) {
  if (WEBHOOK_SECRET && req.params.key !== WEBHOOK_SECRET && req.query.key !== WEBHOOK_SECRET) {
    return res.status(404).json({ error: 'Not found' });
  }
  const body = req.body || {};
  const id = body.execution_id || body.executionId;
  const callback = body.callback;

  // Never log the callback token.
  console.log(`[hitl-dispatch] execution_id=${id} keys=${Object.keys(body).join(',')} inputs=${Object.keys(body.inputs || {}).join(',')}`);

  if (!id || !callback || !callback.url || !callback.token) {
    // Still 2xx: a non-2xx makes Opus retry, which cannot fix a malformed payload.
    console.error('[hitl-dispatch] malformed dispatch ignored');
    return res.status(200).json({ received: true, warning: 'malformed dispatch ignored' });
  }

  try {
    const existing = await store.get(DISPATCH_KEY(id));
    if (existing && existing.status === 'submitted') {
      // A redelivery of something we already answered.
      return res.status(200).json({ received: true, duplicate: true });
    }
    const record = {
      id: String(id),
      receivedAt: (existing && existing.receivedAt) || new Date().toISOString(),
      workflowId: body.workflow_id || null,
      workflowName: body.workflow_name || null,
      inputs: body.inputs || {},
      expectedOutputSchema: body.expected_output_schema || {},
      callback: { url: callback.url, token: callback.token, tokenHeader: callback.token_header || 'X-Opus-Callback-Token' },
      // Any field Opus might use to name the parent job, kept for matching.
      jobHints: [body.job_execution_id, body.jobExecutionId, body.job_id, body.jobId, body.parent_execution_id]
        .filter((x) => x !== undefined && x !== null)
        .map(String),
      jobId: (existing && existing.jobId) || null,
      status: 'pending',
    };
    await store.set(DISPATCH_KEY(id), record);
    await store.sadd(PENDING_SET, record.id);

    // Try to link it to its case, but never risk the 15-second ack deadline.
    await Promise.race([matchDispatch(record).catch((e) => console.error('match error', e.message)), sleep(6000)]);
  } catch (err) {
    console.error('[hitl-dispatch] store error', err);
    // 5xx so Opus retries: losing a dispatch would strand the case.
    return res.status(503).json({ error: 'temporarily unavailable' });
  }
  res.status(200).json({ received: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function linkDispatch(record, c) {
  record.jobId = c.jobId;
  await store.set(DISPATCH_KEY(record.id), record);
  await patchCase(c.jobId, {
    review: {
      status: 'pending',
      dispatchId: record.id,
      receivedAt: record.receivedAt,
    },
  });
  return c.jobId;
}

// Which case does this dispatch belong to?
//   1. an explicit job id in the dispatch, or execution_id == a case id
//   2. the only in-flight case without a review
//   3. in-flight cases whose Opus audit shows them sitting at the Human Task
//   4. of those, the one whose reference appears in the exception brief
async function matchDispatch(record) {
  if (record.jobId) return record.jobId;

  for (const hint of [...record.jobHints, record.id]) {
    const c = await getCase(hint);
    if (c) return linkDispatch(record, c);
  }

  const receivedAt = new Date(record.receivedAt).getTime();
  let candidates = (await allCases()).filter(
    (c) => !TERMINAL.includes(c.status) && !(c.review && c.review.status === 'pending') && new Date(c.submittedAt).getTime() <= receivedAt
  );
  // Cases that already had a review answered can't be waiting on this one.
  candidates = candidates.filter((c) => !(c.review && c.review.status === 'submitted'));
  if (candidates.length === 1) return linkDispatch(record, candidates[0]);
  if (!candidates.length) return null;

  const atHuman = [];
  for (const c of candidates.slice(0, 6)) {
    try {
      const audit = await opus.getAudit(c.jobId);
      const where = JSON.stringify([audit.running_node, audit.next_node_to_execute]);
      if (where.includes(HUMAN_NODE_ID) || /human task/i.test(where)) atHuman.push(c);
    } catch (e) {
      console.error('audit during match failed', e.message);
    }
  }
  if (atHuman.length === 1) return linkDispatch(record, atHuman[0]);

  const pool = atHuman.length ? atHuman : candidates;
  const haystack = JSON.stringify(record.inputs || {}).toLowerCase();
  const byRef = pool.filter((c) => c.reference && haystack.includes(c.reference.toLowerCase()));
  if (byRef.length === 1) return linkDispatch(record, byRef[0]);

  return null;
}

async function expireDispatch(id) {
  if (!id) return;
  const d = await store.get(DISPATCH_KEY(id));
  if (d && d.status === 'pending') {
    d.status = 'expired';
    await store.set(DISPATCH_KEY(id), d);
  }
  await store.srem(PENDING_SET, id);
}

function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value;
  return v;
}

function reviewInputsFor(d) {
  const inputs = d.inputs || {};
  const brief = unwrap(inputs[REVIEW_INPUT_VARS.exceptionBrief]);
  const presentation = unwrap(inputs[REVIEW_INPUT_VARS.analystPresentation]);
  const known = new Set(Object.values(REVIEW_INPUT_VARS));
  const other = {};
  for (const [k, v] of Object.entries(inputs)) if (!known.has(k)) other[k] = unwrap(v);
  return {
    exceptionBrief: parseMaybeJson(brief) ?? null,
    analystPresentation: typeof presentation === 'string' ? presentation : presentation ? JSON.stringify(presentation, null, 2) : null,
    other,
  };
}

function dispatchRow(d, c) {
  return {
    id: d.id,
    status: d.status,
    receivedAt: d.receivedAt,
    ageMinutes: Math.round((Date.now() - new Date(d.receivedAt).getTime()) / 60000),
    timeoutMinutes: REVIEW_TIMEOUT_MINUTES,
    case: c ? toRow(c) : null,
    linked: Boolean(c),
  };
}

const REVIEW_ROLES = ['approver', 'admin'];

app.get('/api/reviews', auth.requireRole(...REVIEW_ROLES), wrap(async (req, res) => {
  const ids = await store.smembers(PENDING_SET);
  const pending = [];
  for (const id of ids) {
    const d = await store.get(DISPATCH_KEY(id));
    if (!d || d.status !== 'pending') {
      await store.srem(PENDING_SET, id);
      continue;
    }
    if (!d.jobId) await matchDispatch(d).catch(() => null);
    const c = d.jobId ? await getCase(d.jobId) : null;
    pending.push(dispatchRow(d, c));
  }
  pending.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));

  const completed = (await allCases())
    .filter((c) => c.review && c.review.status !== 'pending')
    .sort((a, b) => new Date(b.review.reviewedAt || b.review.receivedAt) - new Date(a.review.reviewedAt || a.review.receivedAt))
    .slice(0, 50)
    .map(toRow);

  res.json({ pending, completed });
}));

app.get('/api/reviews/:id', auth.requireRole(...REVIEW_ROLES), wrap(async (req, res) => {
  const d = await store.get(DISPATCH_KEY(req.params.id));
  if (!d) return res.status(404).json({ error: 'Review not found.' });
  if (!d.jobId && d.status === 'pending') await matchDispatch(d).catch(() => null);
  const c = d.jobId ? await getCase(d.jobId) : null;
  const selfReview = Boolean(c && c.submittedBy && c.submittedBy.id === req.user.id);
  res.json({
    review: dispatchRow(d, c),
    inputs: reviewInputsFor(d),
    response: d.response || null,
    reviewedBy: d.reviewedBy || null,
    reviewedAt: d.reviewedAt || null,
    blockedReason: selfReview && !ALLOW_SELF_REVIEW ? 'You submitted this invoice, so another approver has to review it.' : null,
  });
}));

app.post('/api/reviews/:id', auth.requireRole(...REVIEW_ROLES), wrap(async (req, res) => {
  const d = await store.get(DISPATCH_KEY(req.params.id));
  if (!d) return res.status(404).json({ error: 'Review not found.' });
  if (d.status !== 'pending') {
    return res.status(409).json({ error: d.status === 'submitted' ? 'This review has already been submitted.' : 'This review has expired and can no longer be answered.' });
  }

  const response = String((req.body && req.body.response) || '').trim();
  if (!response) return res.status(400).json({ error: 'Write a decision before submitting.' });
  if (response.length > 5000) return res.status(400).json({ error: 'The decision is too long (5,000 characters max).' });

  if (!d.jobId) await matchDispatch(d).catch(() => null);
  const c = d.jobId ? await getCase(d.jobId) : null;
  if (c && c.submittedBy && c.submittedBy.id === req.user.id && !ALLOW_SELF_REVIEW) {
    return res.status(403).json({ error: 'You submitted this invoice, so another approver has to review it.' });
  }

  // Claim the dispatch before calling Opus so two approvers can't both submit.
  const lockKey = `ap:dispatch-lock:${d.id}`;
  const n = await store.incr(lockKey, 120);
  if (n > 1) return res.status(409).json({ error: 'Another approver is submitting this review right now.' });

  try {
    const outputId = pickResponseOutputId(d.expectedOutputSchema);
    const declared = d.expectedOutputSchema && d.expectedOutputSchema[outputId];
    const declaredType = declared && declared.type;
    const type = declaredType && typeof declaredType === 'object' ? declaredType : { type: typeof declaredType === 'string' && declaredType ? declaredType : 'str', type_definition: null };

    const cbRes = await fetch(d.callback.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [d.callback.tokenHeader]: d.callback.token },
      body: JSON.stringify({ output_data: { [outputId]: { value: response, type } }, status: 'success' }),
      signal: AbortSignal.timeout(20000),
    });

    if (!cbRes.ok) {
      const { text } = await opus.readBody(cbRes);
      console.error(`[hitl-callback] ${d.id} failed ${cbRes.status} ${text.slice(0, 300)}`);
      if (cbRes.status === 401 || cbRes.status === 404 || cbRes.status === 410) {
        d.status = 'expired';
        await store.set(DISPATCH_KEY(d.id), d);
        await store.srem(PENDING_SET, d.id);
        if (c) await patchCase(c.jobId, { review: { ...(c.review || {}), status: 'expired' } });
        return res.status(409).json({ error: 'Opus no longer accepts an answer for this review (it has expired or was already answered). The case will need to be resubmitted.' });
      }
      await store.del(lockKey);
      return res.status(502).json({ error: `Opus rejected the decision (${cbRes.status}). Nothing was recorded; try again.` });
    }
  } catch (err) {
    await store.del(lockKey);
    throw err;
  }

  const reviewedAt = new Date().toISOString();
  const reviewedBy = { id: req.user.id, name: req.user.name, email: req.user.email };
  d.status = 'submitted';
  d.response = response;
  d.reviewedBy = reviewedBy;
  d.reviewedAt = reviewedAt;
  delete d.callback; // single-use token, no reason to keep it
  await store.set(DISPATCH_KEY(d.id), d);
  await store.srem(PENDING_SET, d.id);

  if (c) {
    await patchCase(c.jobId, {
      status: TERMINAL.includes(c.status) ? c.status : 'IN_PROGRESS',
      review: {
        status: 'submitted',
        dispatchId: d.id,
        receivedAt: d.receivedAt,
        reviewedBy: { name: reviewedBy.name, email: reviewedBy.email },
        reviewedAt,
        response,
      },
    });
  }
  res.json({ ok: true, jobId: c ? c.jobId : null });
}));

function pickResponseOutputId(schema) {
  const entries = Object.entries(schema || {});
  if (!entries.length) return REVIEW_OUTPUT_FALLBACK;
  const typeName = (def) => (def && typeof def.type === 'object' ? def.type.type : def && def.type) || '';
  const named = entries.find(([, def]) => /response/i.test((def && def.display_name) || ''));
  if (named) return named[0];
  const str = entries.find(([, def]) => /^str/i.test(typeName(def)));
  if (str) return str[0];
  return entries[0][0];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each file must be 10 MB or smaller.' });
  const status = err.status && err.status >= 400 && err.status < 600 && !err.opus ? err.status : 500;
  if (status >= 500) console.error('request error', err);
  const message = err.opus ? 'Opus returned an error. Check Settings, then try again.' : err.message || 'Something went wrong.';
  res.status(status).json({ error: message, detail: err.opus ? err.message : undefined });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AP Invoice console on http://localhost:${PORT}  (storage: ${store.kind})`);
    const missing = missingEnv();
    if (missing.length) console.warn('Missing configuration:', missing.join(', '));
  });
}

module.exports = app;
