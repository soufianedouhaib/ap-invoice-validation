// Payables Hub (Finance Shared Services) - Express backend.
// Runs the AP Invoice Validation workflow; that name stays server-side.
//
// The browser only ever talks to this server. This server is the only thing
// that holds the Opus service key and the only thing that calls Opus.
//
// Flow:
//   1. Clerk uploads Invoice / PO / Goods Receipt PDFs  -> /api/upload (server proxies the bytes to Opus)
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
// How long an approver has to answer a review, in minutes: 60, so a review
// survives a coffee break. Keep the review task's own timeout in the workflow
// at least this long, or the workflow stops waiting first. Older variables
// (REVIEW_TIMEOUT_MINUTES, OPUS_REVIEW_TIMEOUT_MINUTES) are ignored on purpose:
// stale values were left in Vercel. REVIEW_TIME_LIMIT_MINUTES overrides.
const REVIEW_TIMEOUT_MINUTES = Number(process.env.REVIEW_TIME_LIMIT_MINUTES) || 60;
// A pending review this far past its limit can no longer be answered and is
// dropped from the queue.
const REVIEW_GRACE_MINUTES = 2;
const CALLBACK_VALUE_FORMAT = String(process.env.CALLBACK_VALUE_FORMAT || 'bare').toLowerCase();
// Demo mode (on unless DEMO_MODE=false): the login page offers one-click
// Demo Clerk / Demo Approver / Demo Admin accounts. Turn it off for real use.
const DEMO_MODE = String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'false';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const FAILURE = ['FAILED', 'CANCELLED', 'TIMED_OUT'];

// Where each role lands after signing in.
const HOME = { clerk: '/overview.html', approver: '/reviews.html', admin: '/' };
const homeFor = (u) => (u && HOME[u.role]) || '/';

function missingEnv() {
  const missing = [];
  if (!opus.OPUS_SERVICE_KEY) missing.push('OPUS_SERVICE_KEY');
  // OPUS_WORKSPACE_ID is optional now: the workspace is read from the workflow.
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

// ---------------------------------------------------------------------------
// Vendor display names. The vendor master inside the workflow still carries a
// few real brand names; the hub shows an invented name instead, everywhere it
// sends data to a browser (case records, payment object, audit trail, review
// brief, reports, CSV). VENDOR_DISPLAY_NAMES (JSON, {"Real name": "Shown name"})
// adds to or overrides the built-in list.
// ---------------------------------------------------------------------------
const VENDOR_ALIASES = (() => {
  const base = { 'Magic Planet Equipment Ltd': 'Leisure Equipment Ltd', 'Magic Planet': 'Leisure Equipment' };
  try { Object.assign(base, JSON.parse(process.env.VENDOR_DISPLAY_NAMES || '{}')); } catch (e) { console.error('VENDOR_DISPLAY_NAMES is not valid JSON'); }
  return Object.entries(base).filter(([from, to]) => from && to && from !== to)
    .map(([from, to]) => [new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi'), to]);
})();
function displayNames(text) {
  if (typeof text !== 'string' || !VENDOR_ALIASES.length) return text;
  return VENDOR_ALIASES.reduce((t, [re, to]) => t.replace(re, to), text);
}
app.use('/api', (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (!VENDOR_ALIASES.length || body === undefined) return json(body);
    try { return json(JSON.parse(displayNames(JSON.stringify(body)))); } catch (e) { return json(body); }
  };
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Health and config
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  const missing = missingEnv();
  res.json({ ok: missing.length === 0, missing, storage: store.kind });
});

app.get('/api/config', auth.requireRole('admin'), wrap(async (req, res) => {
  const ws = opus.OPUS_SERVICE_KEY ? await opus.resolveWorkspace().catch(() => null) : null;
  const org = opus.OPUS_SERVICE_KEY ? await resolveOrg(null).catch(() => ({ id: null, source: 'none' })) : { id: ORG_ID_ENV || null, source: ORG_ID_ENV ? 'env' : 'none' };
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    orgId: org.id,
    orgSource: org.source,
    opusHost: opus.OPUS_BASE_URL,
    workflowId: opus.OPUS_WORKFLOW_ID,
    workspaceConfigured: Boolean(ws && ws.id),
    workspaceId: ws ? ws.id : null,
    workspaceSource: ws ? ws.source : 'none',
    workspaceEnvMismatch: Boolean(ws && ws.envMismatch),
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
}));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const out = { user: auth.publicUser(req.user), home: homeFor(req.user),
    reviewTimeoutMinutes: REVIEW_TIMEOUT_MINUTES,
    support: { workflowId: opus.OPUS_WORKFLOW_ID, email: process.env.SUPPORT_EMAIL || 'support@opus.com' } };
  if (ORG_ID_ENV) out.support.orgId = ORG_ID_ENV;
  if (req.user.role === 'admin') out.setupWarnings = missingEnv();
  res.json(out);
});

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  if (!auth.sessionSecretConfigured()) {
    return res.status(503).json({ error: 'Sign-in is not configured yet. Ask IT to finish the setup.' });
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
  res.json({ user: auth.publicUser(user), home: homeFor(user) });
}));

// The sign-in list: the three one-click demo accounts, then every other
// active user an admin has added (they sign in with their password). Read
// live from the user store, so adds and edits show up straight away.
app.get('/api/demo', wrap(async (req, res) => {
  if (!DEMO_MODE) return res.json({ enabled: false, accounts: [] });
  const users = await auth.listUsers().catch(() => []);
  const demoEmails = new Set(auth.DEMO_ACCOUNTS.map((a) => a.email));
  const demo = auth.DEMO_ACCOUNTS.map((a) => {
    const u = users.find((x) => x.email === a.email);
    return { kind: 'quick', role: a.role, shownRole: (u && u.role) || a.role, name: (u && u.name) || a.name, email: a.email, active: !u || u.active !== false };
  }).filter((a) => a.active);
  const others = users
    .filter((u) => !demoEmails.has(u.email) && u.active !== false && !u.removed && !/@demo\.local$/i.test(u.email))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((u) => ({ kind: 'user', role: u.role, name: u.name, email: u.email }));
  res.json({ enabled: true, accounts: demo.concat(others) });
}));

app.post('/api/demo-login', wrap(async (req, res) => {
  if (!DEMO_MODE) return res.status(404).json({ error: 'Quick sign-in is switched off.' });
  if (!auth.sessionSecretConfigured()) {
    return res.status(503).json({ error: 'Sign-in is not configured yet. Ask IT to finish the setup.' });
  }
  const user = await auth.ensureDemoUser((req.body || {}).role);
  auth.setSessionCookie(req, res, user);
  res.json({ user: auth.publicUser(user), home: homeFor(user) });
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
  res.json({ users: (await auth.listUsers()).filter((u) => !u.removed).map(auth.publicUser) });
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

// Deleting a user signs them out everywhere (sessions are checked against the
// user store on every request). Their past cases stay, under their name.
app.delete('/api/users/:id', auth.requireRole('admin'), wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const u = await auth.deleteUser(req.params.id);
  console.log(`[users] ${req.user.email} deleted ${u.email}`);
  res.json({ ok: true, deleted: auth.publicUser(u) });
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

// Which Opus API new runs use: 'v0' (Jobs, /job/...) or 'v1' (Case, /api/v1/case...).
// Each case remembers the API it was started with, so old runs keep polling the
// right endpoints. An admin can switch it at runtime.
const API_MODE_KEY = 'ap:api-mode';
let apiModeCache = null;
async function apiMode() {
  if (apiModeCache && Date.now() - apiModeCache.at < 15000) return apiModeCache.mode;
  const stored = await store.get(API_MODE_KEY).catch(() => null);
  const mode = stored === 'v0' || stored === 'v1' ? stored : (process.env.OPUS_API_VERSION === 'v0' ? 'v0' : 'v1');
  apiModeCache = { at: Date.now(), mode };
  return mode;
}

const UPLOAD_CFG_KEY = 'ap:upload-config';
let uploadCfgCache = null;
async function uploadConfig() {
  if (uploadCfgCache && Date.now() - uploadCfgCache.at < 15000) return { ...uploadCfgCache.cfg, api: await apiMode() };
  const cfg = (await store.get(UPLOAD_CFG_KEY).catch(() => null)) || {};
  uploadCfgCache = { at: Date.now(), cfg };
  return { ...cfg, api: await apiMode() };
}

app.post('/api/upload-url', auth.requireRole(...SUBMIT_ROLES), wrap(async (req, res) => {
  const { fileName, size } = req.body || {};
  if (!fileName || !/\.pdf$/i.test(fileName)) return res.status(400).json({ error: 'Only PDF files are accepted.' });
  if (Number(size) > MAX_FILE_BYTES) return res.status(400).json({ error: 'Each file must be 10 MB or smaller.' });
  const { presignedUrl, fileUrl } = await opus.presignUpload(fileName, await uploadConfig());
  if (!presignedUrl || !fileUrl) throw new Error('Opus did not return an upload URL.');
  res.json({ presignedUrl, fileUrl });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

app.post('/api/upload', auth.requireRole(...SUBMIT_ROLES), upload.single('file'), wrap(async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file received.' });
  const isPdf = file.buffer.slice(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf) return res.status(400).json({ error: `${file.originalname} is not a PDF.` });
  const cfg = await uploadConfig();
  const { presignedUrl, fileUrl } = await opus.presignUpload(file.originalname || 'document.pdf', cfg);
  await opus.putToPresigned(presignedUrl, file.buffer, file.originalname || 'document.pdf', cfg);
  res.json({ fileUrl });
}));

// Admin diagnostics for file uploads. Opus has changed its storage rules more
// than once; these let an admin find a combination its document readers can
// open, and switch the app to it at runtime, without a redeploy.
//   POST /api/admin/upload-test   multipart: file + any of scope, dotExt, type,
//                                 withWorkspace, withWorkflow, raw (JSON body
//                                 override), run=yes (start a job reading it)
//   GET  /api/admin/probe?url=    what Opus storage returns for a file URL
//   GET/POST /api/admin/upload-config   the settings real uploads use
const bool = (v, d) => (v === undefined || v === '' ? d : v === true || v === 'true' || v === 'yes' || v === '1');
const CANVAS_FILES = {
  invoice: 'https://files.opus.com/media/private/uploaded/media_85479e75-24f3-44ba-bb4a-c81492a49796.pdf',
  purchaseOrder: 'https://files.opus.com/media/private/uploaded/media_d188be7c-b7cd-48ea-8770-484fd5e83e7b.pdf',
  goodsReceipt: 'https://files.opus.com/media/private/uploaded/media_9cbc76a4-084f-4a58-8b23-b337e419d968.pdf',
};

async function probe(url) {
  const out = {};
  for (const [label, headers] of [['withKey', { 'x-service-key': opus.OPUS_SERVICE_KEY }], ['anonymous', {}]]) {
    try {
      const g = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const buf = Buffer.from(await g.arrayBuffer());
      out[label] = { status: g.status, type: g.headers.get('content-type'), location: g.headers.get('location'), bytes: buf.length, head: buf.slice(0, 120).toString('latin1') };
    } catch (e) { out[label] = { error: e.message }; }
  }
  return out;
}

app.get('/api/admin/probe', auth.requireRole('admin'), wrap(async (req, res) => {
  res.json(await probe(String(req.query.url || '')));
}));

app.get('/api/admin/upload-config', auth.requireRole('admin'), wrap(async (req, res) => {
  res.json({ defaults: opus.DEFAULT_UPLOAD, stored: (await store.get(UPLOAD_CFG_KEY)) || null });
}));
app.post('/api/admin/upload-config', auth.requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.reset) { await store.del(UPLOAD_CFG_KEY); uploadCfgCache = null; return res.json({ stored: null }); }
  const cfg = {
    scope: typeof b.scope === 'string' ? b.scope : opus.DEFAULT_UPLOAD.scope,
    dotExt: bool(b.dotExt, true), type: typeof b.type === 'string' ? b.type : 'mime',
    withWorkspace: bool(b.withWorkspace, true), withWorkflow: bool(b.withWorkflow, true),
  };
  await store.set(UPLOAD_CFG_KEY, cfg);
  uploadCfgCache = null;
  console.log(`[upload-config] ${req.user.email} set ${JSON.stringify(cfg)}`);
  res.json({ stored: cfg });
}));

app.get('/api/admin/api-mode', auth.requireRole('admin'), wrap(async (req, res) => {
  res.json({ mode: await apiMode(), stored: (await store.get(API_MODE_KEY)) || null });
}));
app.post('/api/admin/api-mode', auth.requireRole('admin'), wrap(async (req, res) => {
  const m = req.body && req.body.mode;
  if (m !== 'v0' && m !== 'v1') return res.status(400).json({ error: 'mode must be v0 or v1' });
  await store.set(API_MODE_KEY, m);
  apiModeCache = null;
  console.log(`[api-mode] ${req.user.email} set ${m}`);
  res.json({ mode: m });
}));

// Three files in, one full run out: the real path a clerk takes, on a chosen API.
app.post('/api/admin/full-test', auth.requireRole('admin'), upload.fields([{ name: 'invoice' }, { name: 'purchaseOrder' }, { name: 'goodsReceipt' }]), wrap(async (req, res) => {
  const api = req.body && (req.body.api === 'v0' || req.body.api === 'v1') ? req.body.api : await apiMode();
  const cfg = { ...(await store.get(UPLOAD_CFG_KEY).catch(() => null) || {}), api };
  const out = { api, uploads: {} };
  try {
    const payload = {};
    for (const [key, label] of [['invoice', 'Invoice'], ['purchaseOrder', 'Purchase Order'], ['goodsReceipt', 'Goods Receipt']]) {
      const f = req.files && req.files[key] && req.files[key][0];
      if (!f) return res.status(400).json({ error: 'missing file ' + key });
      const p = await opus.presignUpload(f.originalname, cfg);
      await opus.putToPresigned(p.presignedUrl, f.buffer, f.originalname, cfg);
      out.uploads[key] = p.fileUrl;
      payload[INPUT_VARS[key]] = { value: p.fileUrl, type: 'file', displayName: label };
    }
    out.jobId = await opus.startJob('Full diagnostic (' + api + ')', payload, api);
  } catch (e) { out.error = e.message; }
  res.json(out);
}));

app.post('/api/admin/upload-test', auth.requireRole('admin'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const q = req.body || {};
  const cfg = {
    scope: q.scope || 'workspace', dotExt: bool(q.dotExt, true), type: q.type || 'mime',
    withWorkspace: bool(q.withWorkspace, true), withWorkflow: bool(q.withWorkflow, true),
    api: q.api === 'v0' || q.api === 'v1' ? q.api : await apiMode(),
  };
  const out = { cfg, bytes: req.file.size };
  try {
    let p;
    if (q.raw) {
      out.rawBody = JSON.parse(q.raw);
      p = await opus.opusFetch('/job/file/upload', { method: 'POST', body: q.raw }, { retries: 0 });
    } else {
      p = await opus.presignUpload(req.file.originalname, cfg);
    }
    out.presign = { keys: Object.keys(p || {}), host: String(p.presignedUrl).split('?')[0], fileUrl: p.fileUrl, extra: Object.fromEntries(Object.entries(p).filter(([k]) => !['presignedUrl', 'fileUrl'].includes(k))) };
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const type = cfg.type === 'mime' ? (ext === 'pdf' ? 'application/pdf' : 'application/octet-stream') : cfg.type !== 'none' ? cfg.type : null;
    const put = await fetch(p.presignedUrl, { method: q.method || 'PUT', body: req.file.buffer, headers: type ? { 'Content-Type': type } : {} });
    out.put = { status: put.status, body: (await put.text()).slice(0, 300), headers: Object.fromEntries([...put.headers].filter(([k]) => !/cookie/i.test(k))) };
    out.probe = await probe(p.fileUrl);
    if (bool(q.run, false)) {
      const payload = {
        [INPUT_VARS.invoice]: { value: p.fileUrl, type: 'file' },
        [INPUT_VARS.purchaseOrder]: { value: CANVAS_FILES.purchaseOrder, type: 'file' },
        [INPUT_VARS.goodsReceipt]: { value: CANVAS_FILES.goodsReceipt, type: 'file' },
      };
      out.jobId = await opus.startJob('Upload diagnostic', payload, cfg.api);
    }
  } catch (e) { out.error = e.message; }
  res.json(out);
}));

// What did the invoice reader say for a diagnostic job?
app.get('/api/admin/job-readers/:id', auth.requireRole('admin'), wrap(async (req, res) => {
  const api = req.query.api || undefined;
  const [st, audit] = await Promise.all([opus.getStatus(req.params.id, api), opus.getAudit(req.params.id, api).catch((e) => ({ error: e.message }))]);
  const nodes = (audit && audit.audit && audit.audit.nodes_execution_data) || {};
  res.json({
    status: st && st.status,
    readers: Object.fromEntries(Object.entries(nodes).filter(([k]) => /extractor/i.test(k)).map(([k, n]) => [k, {
      status: n.execution_status, ms: n.execution_time, output: String(n.execution_output && n.execution_output[0] && n.execution_output[0].value).slice(0, 300),
    }])),
  });
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

async function allCasesRaw() {
  const ids = await store.smembers(CASES_SET);
  const cases = await Promise.all(ids.map((id) => getCase(id)));
  return cases.filter(Boolean).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

// Runs made while setting the system up: upload diagnostics, client test
// documents, files uploaded under storage names. Never shown anywhere; the
// admin clean-up deletes them for good.
const TEST_CASE_RE = /\bDIAG|diagnostic|MAFR|al[\s-]*maya|media_[0-9a-f]{8}-[0-9a-f]{4}/i;
function isTestCase(c) {
  if (!c) return false;
  const files = c.files || {};
  const hay = [c.reference, c.note, c.title, ...Object.values(files).map((f) => f && f.name),
    JSON.stringify(c.summary || {}), JSON.stringify(c.prelim || {})].join(' ');
  if (TEST_CASE_RE.test(hay)) return true;
  try { return /MAFR|al[\s-]*maya/i.test(JSON.stringify(c.outputs || {})); } catch (e) { return false; }
}

async function allCases() {
  return (await allCasesRaw()).filter((c) => !isTestCase(c));
}

// The same vendor invoice submitted twice. The first submission that did not
// fail is the original; later ones are duplicates (kept, flagged, and left
// out of the payment run). Keyed on vendor + invoice number as read.
function invoiceKey(c) {
  const s = rowSummary(c);
  const v = realValue(s.vendor), n = realValue(s.invoiceNumber);
  return v && n ? displayNames(v).toLowerCase().replace(/\s+/g, ' ') + '|' + n.toLowerCase() : null;
}
function duplicateMap(cases) {
  const first = new Map(), dup = new Map();
  for (const c of cases.slice().sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))) {
    if (FAILURE.includes(c.status)) continue;
    const k = invoiceKey(c);
    if (!k) continue;
    if (first.has(k)) dup.set(c.jobId, first.get(k)); else first.set(k, c);
  }
  return dup; // jobId -> original case
}

function canSeeCase(user, c) {
  if (!c) return false;
  if (user.role === 'approver' || user.role === 'admin') return true;
  return c.submittedBy && c.submittedBy.id === user.id;
}

function displayStatus(c) {
  if (TERMINAL.includes(c.status)) return c.status;
  if (c.review && c.review.status === 'pending') return 'WAITING_REVIEW';
  // Opus says the run is parked at the review step, even if the review has not
  // reached this app (e.g. the node is still an in-platform Human Task).
  if (c.atReviewStep) return 'WAITING_REVIEW';
  return c.status;
}

// Is the run currently parked at the human-review node? Read from the Opus
// audit: the running/next node name, or a node whose execution status is
// sleeping/waiting (an in-platform Human Task shows as SLEEPING).
const REVIEW_NODE_PATTERN = /human|review|approv|off.?platform/i;
function reviewStepFromAudit(audit) {
  if (!audit || typeof audit !== 'object') return null;
  const nodes = (audit.audit && audit.audit.nodes_execution_data) || {};
  for (const [name, n] of Object.entries(nodes)) {
    const st = String((n && n.execution_status) || '').toUpperCase();
    if (['SLEEPING', 'WAITING', 'WAITING_REVIEW', 'PENDING_REVIEW', 'DISPATCHED', 'PAUSED'].includes(st)) {
      return { node: name, opusStatus: st };
    }
  }
  const running = nodeName(audit.running_node) || '';
  if (running && REVIEW_NODE_PATTERN.test(running)) return { node: running, opusStatus: 'RUNNING' };
  return null;
}

// When the paused review node started, in ms (null if unknown).
function reviewStartedAt(audit) {
  const nodes = (audit && audit.audit && audit.audit.nodes_execution_data) || {};
  for (const n of Object.values(nodes)) {
    const st = String((n && n.execution_status) || '').toUpperCase();
    if (['SLEEPING', 'WAITING', 'WAITING_REVIEW', 'PENDING_REVIEW', 'DISPATCHED', 'PAUSED', 'RUNNING'].includes(st) && n.execution_start_time) {
      const t = Number(n.execution_start_time);
      return t > 1e12 ? t : t * 1000;
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Early case details. The payment object only exists at the end, but the
// vendor, invoice number and invoice total are known as soon as the 3-way
// match has run (from the job audit) or the review arrives (from the brief).
// ---------------------------------------------------------------------------

const HELD_RE = /held|hold|query|reject|disput|block/;

function prelimFrom(obj) {
  const o = parseMaybeJson(obj);
  if (!o || typeof o !== 'object') return null;
  const vendor = findKey(o, ['vendor_name', 'supplier_name']);
  const invoiceNumber = findKey(o, ['invoice_number', 'invoice_no']);
  if (!vendor && !invoiceNumber) return null;
  const total = toNumber(findKey(o, ['invoice_total', 'total_amount', 'grand_total', 'invoice_amount']));
  const ccy = findKey(o, ['currency', 'currency_code']);
  const vendorId = findKey(o, ['vendor_id']);
  const licence = findKey(o, ['trade_license', 'trade_licence', 'license_number']);
  const vs = findKey(o, ['vendor_status']);
  const po = findKey(o, ['po_number', 'po_number_referenced', 'purchase_order_number']);
  const gr = findKey(o, ['gr_number', 'grn_number', 'goods_receipt_number']);
  const rec = o.vendor && typeof o.vendor === 'object' ? o.vendor : null;
  const status = vs && typeof vs === 'object' ? vs.actual || vs.value || null : typeof vs === 'string' ? vs : rec && typeof rec.status === 'string' ? rec.status : null;
  return {
    vendorId: typeof vendorId === 'string' ? vendorId : null,
    tradeLicense: typeof licence === 'string' ? licence : null,
    vendorStatus: typeof status === 'string' && /^[A-Z_]+$/i.test(status) && !/^(pass|fail)$/i.test(status) ? status.toUpperCase() : null,
    vendor: typeof vendor === 'string' ? vendor : null,
    invoiceNumber: invoiceNumber !== undefined && typeof invoiceNumber !== 'object' ? String(invoiceNumber) : null,
    invoiceTotal: typeof total === 'number' && total > 0 ? total : null,
    currency: typeof ccy === 'string' ? ccy.toUpperCase() : null,
    poNumber: typeof po === 'string' || typeof po === 'number' ? realValue(String(po)) : null,
    grNumber: typeof gr === 'string' || typeof gr === 'number' ? realValue(String(gr)) : null,
  };
}

function mergePrelim(a, b) {
  if (!b) return a || null;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) if (v !== null && v !== undefined && (out[k] === null || out[k] === undefined)) out[k] = v;
  return out;
}

// From the audit: the Vendor Lookup's normalized data, or any extractor
// output that names the vendor and invoice.
function prelimFromAudit(audit) {
  const nodes = audit && audit.audit && audit.audit.nodes_execution_data;
  let best = null;
  for (const [name, n] of Object.entries(nodes || {})) {
    if (String((n && n.execution_status) || '').toUpperCase() !== 'COMPLETED') continue;
    for (const o of (n && n.execution_output) || []) {
      const p = prelimFrom(o && o.value);
      if (p) best = /vendor|match/i.test(name) ? mergePrelim(p, best) : mergePrelim(best, p);
    }
  }
  return best;
}

const fmtMoney = (n, ccy) => `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${ccy ? ' ' + ccy : ''}`;

function rowSummary(c) {
  const s = { ...(c.summary || {}) };
  const p = c.prelim || {};
  for (const k of ['vendor', 'invoiceNumber', 'currency', 'invoiceTotal', 'vendorId']) if (s[k] === null || s[k] === undefined || (typeof s[k] === 'string' && !realValue(s[k]))) s[k] = p[k] ?? null;
  s.vendor = realValue(s.vendor);
  s.invoiceNumber = realValue(s.invoiceNumber);
  const decision = String(s.outcome || '').toLowerCase();
  if (c.status === 'COMPLETED' && (s.amount === null || s.amount === undefined) && HELD_RE.test(decision) && s.invoiceTotal) {
    s.displayAmount = fmtMoney(s.invoiceTotal, s.currency);
    s.displayNote = 'held';
  } else if (s.submittedTotal) {
    s.displayAmount = s.submittedTotal;
  } else if (s.invoiceTotal) {
    s.displayAmount = fmtMoney(s.invoiceTotal, s.currency);
    s.displayNote = 'invoice total';
  }
  return s;
}

// Older cases never stored early details. The review brief still has them,
// and for a finished case the Opus audit does (read once, then kept).
async function ensurePrelim(c) {
  let prelim = c.prelim || null;
  const complete = (x) => x && x.invoiceTotal && x.vendorId && x.vendorStatus && x.poNumber;
  if (complete(prelim)) return c;
  if (c.review && c.review.dispatchId && !(prelim && prelim.briefChecked)) {
    const d = await store.get(DISPATCH_KEY(c.review.dispatchId)).catch(() => null);
    prelim = { ...mergePrelim(prelim, d ? prelimFrom(reviewInputsFor(d).exceptionBrief) : null), briefChecked: true };
  }
  if (!complete(prelim) && TERMINAL.includes(c.status) && !(prelim && prelim.auditChecked) && opus.OPUS_SERVICE_KEY) {
    const audit = await opus.getAudit(c.jobId, c.api).catch(() => null);
    prelim = { ...mergePrelim(prelim, prelimFromAudit(audit)), auditChecked: true };
  }
  if (!prelim || JSON.stringify(prelim) === JSON.stringify(c.prelim || null)) return c;
  await patchCase(c.jobId, { prelim });
  return { ...c, prelim };
}

// The workflow's outputs, completed for display with what the console knows
// from earlier in the run: the vendor id, licence and status the vendor
// lookup found but the payment record left blank. Only blanks are filled;
// nothing the workflow wrote is changed.
function enrichOutputs(outputs, c) {
  if (!outputs) return outputs;
  const p = c.prelim || {};
  const out = { ...outputs };
  const fill = (obj, key, value) => {
    if (obj && typeof obj === 'object' && value && (obj[key] === null || obj[key] === undefined || obj[key] === '')) obj[key] = value;
  };
  const pay = parseMaybeJson(out.paymentObject);
  if (pay && typeof pay === 'object' && !Array.isArray(pay)) {
    const copy = { ...pay };
    fill(copy, 'vendor_id', p.vendorId);
    out.paymentObject = copy;
  }
  const aud = parseMaybeJson(out.auditTrail);
  if (aud && typeof aud === 'object' && !Array.isArray(aud)) {
    const copy = { ...aud };
    if (copy.vendor && typeof copy.vendor === 'object') {
      copy.vendor = { ...copy.vendor };
      fill(copy.vendor, 'vendor_id', p.vendorId);
      fill(copy.vendor, 'trade_license', p.tradeLicense);
      fill(copy.vendor, 'status', p.vendorStatus);
    }
    out.auditTrail = copy;
  }
  if (typeof out.justificationSummary === 'string') {
    let t = out.justificationSummary;
    const ref = p.tradeLicense || p.vendorId;
    if (ref) t = t.replace(/\((?:—|–|-)\)/g, '(' + ref + ')');
    if (p.vendorStatus) t = t.replace(/(\*\*Status:\*\*\s*|Status:\s*)(?:—|–)/g, '$1' + p.vendorStatus);
    out.justificationSummary = t;
  }
  return out;
}

// Who someone is on screen: name and email only, under their current name.
function person(p) {
  const q = auth.currentPerson(p);
  return q ? { name: q.name, email: q.email } : null;
}

// Extractor placeholders ("Not documented", "N/A") are not vendor names.
const PLACEHOLDER_RE = /^\s*(not\s+(documented|found|read|available|provided|specified|stated)|n\/?a|none|null|unknown|-+|—)\s*$/i;
const realValue = (v) => (typeof v === 'string' && v.trim() && !PLACEHOLDER_RE.test(v) ? v.trim() : null);

// The one projection from a stored case to what every screen shows.
function toRow(c) {
  return {
    jobId: c.jobId,
    reference: c.reference || null,
    note: c.note || null,
    submittedBy: c.submittedBy ? person(c.submittedBy) : null,
    submittedAt: c.submittedAt,
    completedAt: c.completedAt || null,
    status: displayStatus(c),
    files: c.files || {},
    summary: rowSummary(c),
    hadReview: Boolean(c.review || c.atReviewStep),
    atReviewStep: c.atReviewStep && !TERMINAL.includes(c.status)
      ? { node: c.atReviewStep.node, opusStatus: c.atReviewStep.opusStatus, since: c.atReviewStep.since,
          inApp: Boolean(c.review && c.review.status === 'pending') }
      : null,
    review: c.review
      ? {
          status: c.review.status,
          dispatchId: c.review.dispatchId,
          receivedAt: c.review.receivedAt,
          reviewedBy: c.review.reviewedBy ? person(c.review.reviewedBy) : null,
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
  const invoiceTotal = toNumber(findKey(p, ['invoice_total', 'invoice_amount', 'gross_amount', 'total_amount', 'grand_total']));
  const held = toNumber(findKey(p, ['held_amount', 'amount_held', 'disputed_amount', 'hold_amount', 'amount_on_hold', 'blocked_amount']));
  const disputed = toNumber(findKey(p, ['disputed_count', 'disputes', 'dispute_count']));
  const overrides = toNumber(findKey(p, ['approved_overrides_count', 'overrides_count', 'approved_count']));
  return {
    invoiceTotal: invoiceTotal,
    heldAmount: held,
    disputedCount: disputed,
    overridesCount: overrides,
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
  // Finished cases are not re-fetched, except a failed case recorded before
  // raw Opus details were captured (so its real error can still be looked up).
  if (TERMINAL.includes(c.status) && (c.status === 'COMPLETED' ? c.outputs : c.failure && c.failure.raw)) return { c, progress: null };

  const statusResp = await opus.getStatus(c.jobId, c.api);
  const status = String((statusResp && statusResp.status) || 'UNKNOWN').toUpperCase();
  const changes = { status, lastCheckedAt: new Date().toISOString() };
  let progress = null;

  if (status === 'COMPLETED') {
    const results = await opus.getResults(c.jobId, c.api);
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
      audit = await opus.getAudit(c.jobId, c.api);
    } catch (e) {
      console.error('audit fetch error', e.message);
    }
    let jobDetail = null;
    try {
      jobDetail = await opus.getJob(c.jobId, c.api);
    } catch (e) {
      console.error('job detail fetch error', e.message);
    }
    changes.failure = {
      failedNodes: (audit && audit.failed_nodes) || [],
      nextNodeToExecute: (audit && audit.next_node_to_execute) || null,
      // Raw Opus data, kept so an admin can see the real error on the case page.
      raw: trimForStorage({ audit, job: jobDetail }),
    };
    changes.completedAt = (await finishedAt(c.jobId)) || new Date().toISOString();
    // A review the workflow gave up on can no longer be answered.
    if (c.review && c.review.status === 'pending') {
      changes.review = { ...c.review, status: 'expired' };
      await expireDispatch(c.review.dispatchId);
    }
  } else {
    try {
      const audit = await opus.getAudit(c.jobId, c.api);
      progress = {
        nbNodes: audit.nb_nodes ?? null,
        nbExecutedNodes: audit.nb_executed_nodes ?? null,
        runningNode: nodeName(audit.running_node),
        nextNode: nodeName(audit.next_node_to_execute),
      };
      const early = prelimFromAudit(audit);
      if (early) changes.prelim = mergePrelim(early, c.prelim);
      const step = reviewStepFromAudit(audit);
      if (step) {
        changes.atReviewStep = {
          node: step.node,
          opusStatus: step.opusStatus,
          since: (c.atReviewStep && c.atReviewStep.since) || new Date().toISOString(),
        };
        progress.runningNode = progress.runningNode || step.node;
      } else if (c.atReviewStep) {
        changes.atReviewStep = null;
      }
    } catch (e) {
      console.error('progress audit error', e.message);
    }
  }

  const updated = await patchCase(c.jobId, changes);
  return { c: updated || { ...c, ...changes }, progress };
}

// Keep stored debug data bounded (Redis values, and the page that shows them).
// Reads the extractor outputs in the raw audit and names a known cause.
const FILE_ACCESS_RE = /403|forbidden|could not be (retrieved|accessed)|access (restriction|error|denied)/i;
function failureCause(raw) {
  try {
    const a = raw && raw.audit && (raw.audit.audit || raw.audit);
    const nodes = a && a.nodes_execution_data;
    const list = Array.isArray(nodes) ? nodes : Object.values(nodes || {});
    const blocked = list.some((n) => (n.execution_output || []).some((o) => FILE_ACCESS_RE.test(String(o && o.value))));
    const readersDead = Object.entries(nodes || {}).filter(([k]) => /extractor/i.test(k));
    if (readersDead.length && readersDead.every(([, n]) => String(n.execution_status).toUpperCase() === 'FAILED' &&
        (n.execution_output || []).every((o) => o.value === null || o.value === undefined))) {
      return {
        code: 'READERS_FAILED',
        message: 'The documents could not be read (invoice, PO and goods receipt), so the match stopped at the first step. ' +
          'Upload the files again and resubmit; if it keeps happening, use Report a problem on this page.',
      };
    }
    if (blocked) {
      return {
        code: 'FILE_ACCESS',
        message: 'The uploaded PDFs could not be opened for reading, so nothing was extracted and the 3-way match had no data. ' +
          'Upload the three files again and resubmit.',
      };
    }
  } catch (e) { /* fall through */ }
  return null;
}

function trimForStorage(v) {
  try {
    const s = JSON.stringify(v);
    if (s.length <= 60000) return v;
    return { truncated: true, text: s.slice(0, 60000) };
  } catch {
    return null;
  }
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
  const api = await apiMode();
  payload[INPUT_VARS.invoice].displayName = 'Invoice';
  payload[INPUT_VARS.purchaseOrder].displayName = 'Purchase Order';
  payload[INPUT_VARS.goodsReceipt].displayName = 'Goods Receipt';
  const jobId = await opus.startJob(title, payload, api);

  const c = {
    jobId,
    api,
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
  const dups = duplicateMap(cases);
  res.json({ cases: cases.map((c) => {
    const row = toRow(c);
    const o = dups.get(c.jobId);
    if (o) row.duplicateOf = { jobId: o.jobId, reference: o.reference || rowSummary(o).invoiceNumber || null };
    return row;
  }) });
}));

// Admin: delete one case (e.g. an invoice submitted twice), with its review.
app.delete('/api/cases/:id', auth.requireRole('admin'), wrap(async (req, res) => {
  const c = await getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  if (c.review && c.review.dispatchId) {
    await store.del(DISPATCH_KEY(c.review.dispatchId));
    await store.srem(PENDING_SET, c.review.dispatchId);
  }
  await store.del(CASE_KEY(c.jobId));
  await store.srem(CASES_SET, c.jobId);
  console.log(`[cases] ${req.user.email} deleted case ${c.jobId}`);
  res.json({ ok: true });
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
    current = await ensurePrelim(r.c).catch(() => r.c);
    progress = r.progress;
  } catch (err) {
    console.error('refresh error', err.message);
    refreshError = 'The matching service could not be reached just now. Showing the last known state.';
  }

  res.json({
    case: toRow(current),
    outputs: enrichOutputs(current.outputs || null, current),
    failure: current.failure
      ? { failedNodes: current.failure.failedNodes, nextNodeToExecute: current.failure.nextNodeToExecute,
          cause: failureCause(current.failure.raw),
          raw: req.user.role === 'admin' ? current.failure.raw || null : undefined }
      : null,
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
//   body { output_data: { <output id>: <bare value> }, status: 'success' }   (per developer.opus.com)
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
    prelim: mergePrelim(c.prelim, prelimFrom(reviewInputsFor(record).exceptionBrief)),
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
//   3. in-flight cases paused at the review step (found by status, so the
//      node's name does not matter), dropping ones paused long before
//   4. of those, the one whose reference appears in the exception brief
//   5. else the one that paused closest to when the dispatch arrived
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

  // Which candidates are parked at the review step right now, and since when?
  // Works whatever the review node is called ("Human Task", "AP Approver
  // Review", ...): a paused node is found by its status, not its name.
  const atReview = [];
  const newestFirst = candidates.slice().sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  for (const c of newestFirst.slice(0, 8)) {
    try {
      const audit = await opus.getAudit(c.jobId, c.api);
      const step = reviewStepFromAudit(audit);
      const where = JSON.stringify([audit.running_node, audit.next_node_to_execute]);
      if (step || where.includes(HUMAN_NODE_ID)) atReview.push({ c, startedAt: reviewStartedAt(audit) });
    } catch (e) {
      console.error('audit during match failed', e.message);
    }
  }
  // A case that reached its review step long before this dispatch arrived is
  // waiting on a different review (e.g. an old run on an older version).
  const fresh = atReview.filter((x) => !x.startedAt || Math.abs(receivedAt - x.startedAt) <= 15 * 60000);
  if (fresh.length === 1) return linkDispatch(record, fresh[0].c);

  const pool = (fresh.length ? fresh : atReview.length ? atReview : candidates.map((c) => ({ c })));
  // The exception brief names the invoice, PO and GR; the clerk's reference
  // is usually the invoice number.
  const haystack = JSON.stringify(record.inputs || {}).toLowerCase();
  const byRef = pool.filter((x) => x.c.reference && haystack.includes(x.c.reference.toLowerCase()));
  if (byRef.length === 1) return linkDispatch(record, byRef[0].c);

  // Last resort: the case whose review step started closest to when the
  // dispatch arrived (Opus sends it as the step starts), if it is within 3
  // minutes and clearly closer than the runner-up (by 10 seconds or more).
  const timed = pool.filter((x) => x.startedAt).sort((a, b) => Math.abs(receivedAt - a.startedAt) - Math.abs(receivedAt - b.startedAt));
  const gap = (x) => Math.abs(receivedAt - x.startedAt);
  if (timed.length && gap(timed[0]) <= 3 * 60000 && (timed.length === 1 || gap(timed[1]) - gap(timed[0]) >= 10000)) {
    return linkDispatch(record, timed[0].c);
  }

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

// Finds the brief and the presentation in a dispatch. First by the known
// variable ids; if the review node was replaced (e.g. by an Off-Platform Task,
// which gets new ids), by the display_name Opus sends with each input, and
// finally by type (object = brief, text = presentation).
function findReviewInput(inputs, knownId, namePattern, wantType) {
  if (inputs[knownId] !== undefined) return knownId;
  const entries = Object.entries(inputs);
  const byName = entries.find(([k, v]) => namePattern.test(String((v && v.display_name) || k)));
  if (byName) return byName[0];
  const byType = entries.find(([, v]) => {
    const val = unwrap(v);
    return wantType === 'object' ? val && typeof val === 'object' : typeof val === 'string';
  });
  return byType ? byType[0] : null;
}

function reviewInputsFor(d) {
  const inputs = d.inputs || {};
  const briefKey = findReviewInput(inputs, REVIEW_INPUT_VARS.exceptionBrief, /brief|manifest|exception/i, 'object');
  const presKey = findReviewInput(inputs, REVIEW_INPUT_VARS.analystPresentation, /presentation|markdown|analyst|narrative/i, 'string');
  const brief = briefKey ? unwrap(inputs[briefKey]) : null;
  const presentation = presKey && presKey !== briefKey ? unwrap(inputs[presKey]) : null;
  const known = new Set([briefKey, presKey].filter(Boolean));
  const other = {};
  for (const [k, v] of Object.entries(inputs)) if (!known.has(k)) other[k] = unwrap(v);
  return {
    exceptionBrief: parseMaybeJson(brief) ?? null,
    analystPresentation: typeof presentation === 'string' ? presentation : presentation ? JSON.stringify(presentation, null, 2) : null,
    other,
  };
}

function dispatchRow(d, c) {
  // Not linked to a case yet: the exception brief still names the vendor,
  // invoice and amount, so the approver can see what it is.
  const p = c ? null : prelimFrom(reviewInputsFor(d).exceptionBrief) || {};
  return {
    id: d.id,
    status: d.status,
    receivedAt: d.receivedAt,
    ageMinutes: Math.round((Date.now() - new Date(d.receivedAt).getTime()) / 60000),
    timeoutMinutes: REVIEW_TIMEOUT_MINUTES,
    case: c ? toRow(c) : null,
    linked: Boolean(c),
    details: p ? {
      vendor: realValue(p.vendor), invoiceNumber: realValue(p.invoiceNumber),
      amount: p.invoiceTotal ? fmtMoney(p.invoiceTotal, p.currency) : null,
    } : null,
  };
}

const pastLimit = (d) => Date.now() - new Date(d.receivedAt).getTime() > (REVIEW_TIMEOUT_MINUTES + REVIEW_GRACE_MINUTES) * 60000;

// Reviews that can still be answered. One past its time limit is expired
// (and its case marked so); one never linked to a case and with nothing to
// show (no vendor, no invoice) is not something an approver can act on.
async function openReviews() {
  const ids = await store.smembers(PENDING_SET);
  const linked = [];
  const unmatched = [];
  for (const id of ids) {
    const d = await store.get(DISPATCH_KEY(id));
    if (!d || d.status !== 'pending') { await store.srem(PENDING_SET, id); continue; }
    if (!d.jobId) await matchDispatch(d).catch(() => null);
    const c = d.jobId ? await getCase(d.jobId) : null;
    if (pastLimit(d)) {
      await expireDispatch(d.id);
      if (c && c.review && c.review.status === 'pending') await patchCase(c.jobId, { review: { ...c.review, status: 'expired' } });
      continue;
    }
    if (c && isTestCase(c)) continue;
    const row = dispatchRow(d, c);
    if (c) linked.push(row);
    else if (row.details && (row.details.vendor || row.details.invoiceNumber)) unmatched.push(row);
  }
  const oldest = (a, b) => new Date(a.receivedAt) - new Date(b.receivedAt);
  return { linked: linked.sort(oldest), unmatched: unmatched.sort(oldest) };
}

const REVIEW_ROLES = ['approver', 'admin'];

app.get('/api/reviews', auth.requireRole(...REVIEW_ROLES), wrap(async (req, res) => {
  const open = await openReviews();
  const pending = open.linked;

  const completed = (await allCases())
    .filter((c) => c.review && c.review.status !== 'pending' && !isTestCase(c))
    .sort((a, b) => new Date(b.review.reviewedAt || b.review.receivedAt) - new Date(a.review.reviewedAt || a.review.receivedAt))
    .slice(0, 50)
    .map(toRow);

  const pendingJobIds = new Set(pending.map((p) => p.case && p.case.jobId).filter(Boolean));
  const notDelivered = (await allCases())
    .filter((c) => !TERMINAL.includes(c.status) && c.atReviewStep && !pendingJobIds.has(c.jobId) && !(c.review && c.review.status === 'pending') && !isTestCase(c))
    .map(toRow);

  res.json({ pending, unmatched: open.unmatched, completed, notDelivered: req.user.role === 'admin' ? notDelivered : [] });
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
    // What Opus expects back (field ids/names/types only, never the token).
    outputFields: Object.entries(d.expectedOutputSchema || {}).map(([id, def]) => ({
      id, name: (def && def.display_name) || null,
      type: def && (typeof def.type === 'object' ? def.type && def.type.type : def.type) || null,
      sentAs: id === pickResponseOutputId(d.expectedOutputSchema),
    })),
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
    // Opus docs (Off-Platform Task / Review): send BARE values; Opus applies the
    // declared type itself, and a {value, type} wrapper would be stored as the value.
    // CALLBACK_VALUE_FORMAT=wrapped restores the older KYC-style shape if ever needed.
    const value = CALLBACK_VALUE_FORMAT === 'wrapped' ? { value: response, type } : response;

    const cbRes = await fetch(d.callback.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [d.callback.tokenHeader]: d.callback.token },
      body: JSON.stringify({ output_data: { [outputId]: value }, status: 'success' }),
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
        return res.status(409).json({ error: 'This review can no longer be answered (it has expired or was already answered). The invoice pack will need to be submitted again.' });
      }
      await store.del(lockKey);
      return res.status(502).json({ error: `The decision was not accepted (${cbRes.status}). Nothing was recorded; try again.` });
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
// Support: everything Opus support asks for, gathered for one case.
// The org id is not in the documented API responses, so OPUS_ORG_ID is the
// reliable source; failing that, any organization id field Opus happens to
// return on the workflow or the job is used.
// ---------------------------------------------------------------------------

// Applied AI's Opus organization. OPUS_ORG_ID overrides it for another org.
const ORG_ID_ENV = process.env.OPUS_ORG_ID || process.env.OPUS_ORGANIZATION_ID || 'b99049b2-1fe2-4338-aa11-5c0b2d17351f';
let orgCache = null;

function findOrgId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/^(organi[sz]ation|org)_?id$/i.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length > 2) return String(v);
    if (/^(organi[sz]ation|org)$/i.test(k) && v && typeof v === 'object' && (v.id || v.uuid)) return String(v.id || v.uuid);
  }
  for (const v of Object.values(obj)) {
    const found = v && typeof v === 'object' ? findOrgId(v, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

async function resolveOrg(job) {
  if (ORG_ID_ENV) return { id: ORG_ID_ENV, source: 'env' };
  const fromJob = findOrgId(job);
  if (fromJob) return { id: fromJob, source: 'job' };
  if (orgCache) return orgCache;
  let id = null;
  try { id = findOrgId(await opus.getWorkflow()); } catch (e) { /* not available */ }
  orgCache = { id, source: id ? 'workflow' : 'none' };
  return orgCache;
}

app.get('/api/support', auth.requireUser, wrap(async (req, res) => {
  const org = opus.OPUS_SERVICE_KEY ? await resolveOrg(null).catch(() => ({ id: null, source: 'none' })) : { id: null, source: 'none' };
  res.json({ workflowId: opus.OPUS_WORKFLOW_ID, orgId: org.id, orgSource: org.source });
}));

app.get('/api/cases/:id/support', auth.requireUser, wrap(async (req, res) => {
  const c = await getCase(req.params.id);
  if (!canSeeCase(req.user, c)) return res.status(404).json({ error: 'Case not found.' });

  // Opus's own record of the job: reference id, version, workspace. Cached on
  // the case once the job has finished, since it no longer changes.
  let job = c.opusJob || null;
  if (!job && opus.OPUS_SERVICE_KEY) {
    try {
      const d = await opus.getJob(c.jobId, c.api);
      job = {
        referenceId: d.referenceId || null,
        versionLabel: d.workflowVersionLabel || null,
        versionId: d.workflowVersionId || null,
        workflowName: (d.workflow && d.workflow.name) || null,
        workspace: d.workspace || null,
        orgId: findOrgId(d),
        finishedAt: d.finishedAt || null,
      };
      if (TERMINAL.includes(c.status)) await patchCase(c.jobId, { opusJob: job });
    } catch (e) {
      console.error('support job lookup failed', e.message);
    }
  }
  const org = job && job.orgId ? { id: job.orgId, source: 'job' } : await resolveOrg(null).catch(() => ({ id: null, source: 'none' }));

  const status = displayStatus(c);
  const failed = FAILURE.includes(status);
  const raw = c.failure && c.failure.raw;
  const cause = failed ? failureCause(raw) : null;
  const failedNodes = (c.failure && c.failure.failedNodes || []).map((n) => (typeof n === 'string' ? n : n.name || n.node_name || n.id)).filter(Boolean);

  // The extractors' own words, which say why nothing could be read.
  const warnings = [];
  try {
    const a = raw && raw.audit && (raw.audit.audit || raw.audit);
    const nodes = a && a.nodes_execution_data;
    for (const [name, n] of Object.entries(nodes || {})) {
      for (const o of n.execution_output || []) {
        const v = parseMaybeJson(o && o.value);
        const list = v && typeof v === 'object' && Array.isArray(v.extraction_warnings) ? v.extraction_warnings : [];
        for (const w of list.slice(0, 2)) warnings.push(`${Number.isNaN(Number(name)) ? name : 'Node ' + name}: ${String(w).slice(0, 180)}`);
      }
    }
  } catch (e) { /* none */ }

  let reason = null;
  if (cause) reason = cause.message;
  else if (failed && failedNodes.length) reason = `The run stopped at "${failedNodes[0]}".`;
  else if (failed) reason = 'The run did not finish and no failed step was named.';
  if (c.review && c.review.status === 'expired') reason = 'The approver review was not answered before the time limit. ' + (reason || '');

  res.json({
    workflowId: opus.OPUS_WORKFLOW_ID,
    workflowName: (job && job.workflowName) || 'AP Invoice Validation',
    workflowVersion: job && job.versionLabel,
    orgId: org.id,
    orgSource: org.source,
    workspace: (job && job.workspace) || null,
    caseId: c.jobId,
    reference: c.reference || null,
    executionId: c.jobId,
    executionReferenceId: job && job.referenceId,
    reviewExecutionId: c.review && c.review.dispatchId || null,
    status,
    failed,
    failedAt: failedNodes[0] || null,
    failedNodes,
    reason,
    warnings: [...new Set(warnings)].slice(0, 4),
    submittedAt: c.submittedAt,
    finishedAt: c.completedAt || (job && job.finishedAt) || null,
    submittedBy: c.submittedBy ? c.submittedBy.name : null,
  });
}));

// ---------------------------------------------------------------------------
// Report, export and clean-up
//
// One report for everyone; what it covers follows what the caller may see:
// a clerk gets their own submissions, an approver or admin gets every case.
// ---------------------------------------------------------------------------

const DAY = 86400000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

function caseFigures(c) {
  const status = displayStatus(c);
  const s = { ...(c.summary || {}), ...summarise(c.outputs && c.outputs.paymentObject) };
  const decision = String(s.outcome || '').toLowerCase();
  const completed = status === 'COMPLETED';
  const unfinished = FAILURE.includes(status);
  const reviewed = Boolean(c.review && c.review.status === 'submitted') || /override|review|partial|disput|held|hold/.test(decision);
  const auto = completed && !reviewed && !c.atReviewStep && (/auto/.test(decision) || !c.hadReview);
  const p = c.prelim || {};
  const invoiceTotal = typeof s.invoiceTotal === 'number' ? s.invoiceTotal : typeof p.invoiceTotal === 'number' ? p.invoiceTotal : null;
  if (!s.vendor && p.vendor) s.vendor = p.vendor;
  if (!s.currency && p.currency) s.currency = p.currency;
  const isHeld = HELD_RE.test(decision) && !/partial|approved/.test(decision);
  let approved = completed && typeof s.amount === 'number' && !isHeld ? s.amount : 0;
  let held = 0;
  if (completed) {
    if (typeof s.heldAmount === 'number' && s.heldAmount > 0) held = s.heldAmount;
    else if (isHeld) held = invoiceTotal || (typeof s.amount === 'number' ? s.amount : 0);
    else if (invoiceTotal && typeof s.amount === 'number' && invoiceTotal > s.amount) held = invoiceTotal - s.amount;
  }
  const runtimeMs = completed && c.completedAt ? new Date(c.completedAt) - new Date(c.submittedAt) : null;
  return { status, s, completed, unfinished, reviewed, auto, approved, held, runtimeMs, currency: s.currency || null };
}

// "approve 1 and 3, dispute 2" -> { approve: [1,3], dispute: [2] }
function parseDecision(text) {
  const out = { approve: [], dispute: [] };
  String(text || '').toLowerCase().split(/[,;\n]+(?=\s*(?:approve|dispute|reject|hold))/).forEach((part) => {
    const kind = /^\s*approve/.test(part) ? 'approve' : /^\s*(dispute|reject|hold)/.test(part) ? 'dispute' : null;
    if (!kind) return;
    if (/\ball\b/.test(part)) { out[kind].push('all'); return; }
    (part.match(/\d+/g) || []).forEach((n) => out[kind].push(Number(n)));
  });
  return out;
}

async function exceptionsFor(c) {
  if (!c.review || !c.review.dispatchId) return [];
  const d = await store.get(DISPATCH_KEY(c.review.dispatchId)).catch(() => null);
  if (!d) return [];
  const brief = reviewInputsFor(d).exceptionBrief;
  const list = brief && Array.isArray(brief.exceptions) ? brief.exceptions : [];
  const dec = parseDecision(d.response || (c.review && c.review.response));
  const decided = d.status === 'submitted';
  return list.map((e, i) => {
    const num = Number(e.number || e.num || i + 1);
    let verdict = null;
    if (decided) {
      if (dec.approve.includes('all') || dec.approve.includes(num)) verdict = 'approve';
      else verdict = 'dispute'; // undecided exceptions default to dispute
    }
    return { type: String(e.type || e.exception_type || 'OTHER'), severity: e.severity || null, verdict };
  });
}

function rangeFrom(q) {
  const ok = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  return { from: ok(q.from), to: ok(q.to) };
}

function inRange(c, range) {
  const d = ymd(c.submittedAt);
  return (!range.from || d >= range.from) && (!range.to || d <= range.to);
}

function bump(map, key, label) {
  if (!map.has(key)) map.set(key, { label, approved: 0, held: 0, total: 0, runs: 0, unfinished: 0, approvedCount: 0, heldCount: 0 });
  return map.get(key);
}

app.get('/api/report', auth.requireUser, wrap(async (req, res) => {
  const user = req.user;
  const scope = user.role === 'clerk' ? 'mine' : 'all';
  const range = rangeFrom(req.query);
  let cases = (await allCases()).filter((c) => canSeeCase(user, c) && inRange(c, range));
  // Bring a few stale in-flight cases up to date first, so the figures do not
  // wait for someone to open those cases. Capped to respect Opus rate limits.
  const stale = cases.filter((c) => !TERMINAL.includes(c.status) && Date.now() - new Date(c.lastCheckedAt || 0).getTime() > 30000).slice(0, 6);
  if (stale.length && opus.OPUS_SERVICE_KEY) {
    const fresh = await Promise.all(stale.map((c) => refreshCase(c).then((r) => r.c).catch(() => c)));
    const byId = new Map(fresh.map((c) => [c.jobId, c]));
    cases = cases.map((c) => byId.get(c.jobId) || c);
  }
  cases = await Promise.all(cases.map((c) => (c.status === 'COMPLETED' ? ensurePrelim(c).catch(() => c) : c)));
  // A second submission of the same invoice is not counted twice.
  const dupIds = duplicateMap(cases);
  cases = cases.filter((c) => !dupIds.has(c.jobId));
  const figs = cases.map((c) => ({ c, f: caseFigures(c) }));

  // One currency for the money figures: the most common among finished runs.
  const ccyCount = {};
  figs.forEach(({ f }) => { if (f.completed && f.currency) ccyCount[f.currency] = (ccyCount[f.currency] || 0) + 1; });
  const currency = Object.keys(ccyCount).sort((a, b) => ccyCount[b] - ccyCount[a])[0] || 'AED';
  const money = (f) => !f.currency || f.currency === currency;
  const otherCurrencyRuns = figs.filter(({ f }) => f.completed && !money(f)).length;

  const totals = { approved: { amount: 0, count: 0 }, held: { amount: 0, count: 0 }, partial: 0 };
  let auto = 0, finished = 0, unfinished = 0, inFlight = 0, awaiting = 0, runtimeSum = 0, runtimeRuns = 0;
  const vendors = new Map(), people = new Map(), approvers = new Map(), exc = new Map();
  let turnSum = 0, turnRuns = 0, excApproved = 0, excDisputed = 0, decided = 0;

  for (const { c, f } of figs) {
    if (f.completed) finished++;
    else if (f.unfinished) unfinished++;
    else { inFlight++; if (f.status === 'WAITING_REVIEW') awaiting++; }
    if (f.auto) auto++;
    if (f.completed && money(f)) {
      if (f.approved > 0) { totals.approved.amount += f.approved; totals.approved.count++; }
      if (f.held > 0) { totals.held.amount += f.held; totals.held.count++; }
      if (f.approved > 0 && f.held > 0) totals.partial++;
    }
    if (typeof f.runtimeMs === 'number' && f.runtimeMs >= 0) { runtimeSum += f.runtimeMs; runtimeRuns++; }

    const add = (map, key, label) => {
      const row = bump(map, key, label);
      row.runs++;
      if (f.unfinished) row.unfinished++;
      if (f.completed && money(f)) {
        row.approved += f.approved; row.held += f.held; row.total += f.approved + f.held;
        if (f.approved > 0) row.approvedCount++;
        if (f.held > 0) row.heldCount++;
      }
    };
    // Only invoices whose vendor was actually read count towards a vendor.
    const vendorName = realValue(f.s.vendor);
    if (vendorName) add(vendors, vendorName.toLowerCase(), vendorName);
    if (c.submittedBy) { const sb = person(c.submittedBy); add(people, sb.email || sb.name, sb.name || sb.email); }

    if (c.review && c.review.status === 'submitted') {
      decided++;
      if (c.review.receivedAt && c.review.reviewedAt) { turnSum += new Date(c.review.reviewedAt) - new Date(c.review.receivedAt); turnRuns++; }
    }
    const list = await exceptionsFor(c);
    const rb = c.review && c.review.reviewedBy ? person(c.review.reviewedBy) : null;
    const who = rb ? rb.name || rb.email : null;
    for (const e of list) {
      const row = exc.get(e.type) || { label: e.type, approved: 0, disputed: 0, pending: 0, total: 0 };
      row.total++;
      if (e.verdict === 'approve') { row.approved++; excApproved++; }
      else if (e.verdict === 'dispute') { row.disputed++; excDisputed++; }
      else row.pending++;
      exc.set(e.type, row);
      if (who && e.verdict) {
        const a = approvers.get(who) || { label: who, approved: 0, disputed: 0, total: 0, runs: 0 };
        a[e.verdict === 'approve' ? 'approved' : 'disputed']++;
        a.total++;
        approvers.set(who, a);
      }
    }
    if (who) { const a = approvers.get(who) || { label: who, approved: 0, disputed: 0, total: 0, runs: 0 }; a.runs++; approvers.set(who, a); }
  }

  // Over time: by day when the period is short enough to read that way.
  const times = figs.map(({ c }) => new Date(c.submittedAt).getTime());
  const start = range.from ? Date.parse(range.from) : times.length ? Math.min(...times) : Date.now();
  const endRaw = range.to ? Date.parse(range.to) : times.length ? Math.max(...times) : Date.now();
  const end = Math.min(endRaw, Date.now());
  const byDay = (end - start) / DAY <= 62;
  const keyOf = (t) => (byDay ? ymd(t) : ymd(t).slice(0, 7));
  const points = new Map();
  if (byDay) for (let t = Date.parse(ymd(start)); t <= end; t += DAY) points.set(ymd(t), null);
  else {
    const d = new Date(start); d.setUTCDate(1);
    for (; d.getTime() <= end; d.setUTCMonth(d.getUTCMonth() + 1)) points.set(ymd(d).slice(0, 7), null);
  }
  for (const k of points.keys()) points.set(k, { key: k, approved: { amount: 0, count: 0 }, held: { amount: 0, count: 0 }, runs: 0, unfinished: 0 });
  for (const { c, f } of figs) {
    const k = keyOf(c.submittedAt);
    if (!points.has(k)) points.set(k, { key: k, approved: { amount: 0, count: 0 }, held: { amount: 0, count: 0 }, runs: 0, unfinished: 0 });
    const pnt = points.get(k);
    pnt.runs++;
    if (f.unfinished) pnt.unfinished++;
    if (f.completed && money(f)) {
      if (f.approved > 0) { pnt.approved.amount += f.approved; pnt.approved.count++; }
      if (f.held > 0) { pnt.held.amount += f.held; pnt.held.count++; }
    }
  }
  const sortRows = (m) => [...m.values()].sort((a, b) => b.total - a.total || b.runs - a.runs);

  res.json({
    configured: true,
    scope,
    role: user.role,
    range,
    currency,
    otherCurrencyRuns,
    runs: figs.length,
    totals,
    straightThrough: { rate: finished ? auto / finished : null, auto, finished, reviewed: finished - auto, unfinished, inFlight, awaiting },
    runtime: { averageMs: runtimeRuns ? runtimeSum / runtimeRuns : null, runs: runtimeRuns },
    review: { decided, averageTurnaroundMs: turnRuns ? turnSum / turnRuns : null, exceptionsApproved: excApproved, exceptionsDisputed: excDisputed },
    series: { unit: byDay ? 'day' : 'month', points: [...points.values()].sort((a, b) => (a.key < b.key ? -1 : 1)) },
    vendors: sortRows(vendors),
    people: scope === 'mine' ? [] : sortRows(people),
    approvers: [...approvers.values()].sort((a, b) => b.total - a.total || b.runs - a.runs),
    exceptions: [...exc.values()].sort((a, b) => b.total - a.total),
  });
}));

// ---------------------------------------------------------------------------
// Read-only neighbouring areas (vendors, purchase orders, payment run). The
// source records live in procurement and treasury; these views show what
// this hub has seen on the invoices it matched.
// ---------------------------------------------------------------------------

function fromOutputs(c, names) {
  for (const k of ['paymentObject', 'auditTrail']) {
    const v = findKey(parseMaybeJson(c.outputs && c.outputs[k]), names);
    if (v !== undefined && typeof v !== 'object') return realValue(String(v));
  }
  return null;
}

function matchState(c, f) {
  if (f.unfinished) return 'Did not finish';
  if (f.status === 'WAITING_REVIEW') return 'Awaiting approval';
  if (!f.completed) return 'Matching';
  if (f.held > 0 && f.approved > 0) return 'Part held';
  if (f.held > 0) return 'Held';
  return f.reviewed ? 'Approved after review' : 'Matched';
}

app.get('/api/ledger', auth.requireUser, wrap(async (req, res) => {
  const cases = (await allCases()).filter((c) => canSeeCase(req.user, c));
  const dups = duplicateMap(cases);
  const vendors = new Map();
  const orders = [];
  const byPo = new Map();
  const payments = [];
  for (const c of cases) {
    const f = caseFigures(c);
    const p = c.prelim || {};
    const vendor = realValue(f.s.vendor) || realValue(p.vendor);
    const invoiceNumber = realValue(f.s.invoiceNumber) || realValue(p.invoiceNumber) || c.reference || null;
    const ccy = f.currency || p.currency || null;
    if (dups.has(c.jobId)) continue; // a duplicate submission is not a second invoice
    if (vendor) {
      const key = vendor.toLowerCase();
      const v = vendors.get(key) || { name: vendor, vendorId: null, status: null, invoices: 0, approved: 0, held: 0, currency: ccy, lastInvoiceAt: null };
      v.vendorId = v.vendorId || p.vendorId || fromOutputs(c, ['vendor_id']);
      v.status = v.status || p.vendorStatus || null;
      v.invoices++;
      v.approved += f.approved; v.held += f.held;
      if (!v.lastInvoiceAt || c.submittedAt > v.lastInvoiceAt) v.lastInvoiceAt = c.submittedAt;
      vendors.set(key, v);
    }
    // One row per purchase order: its latest match (cases are newest first).
    const poNumber = p.poNumber || fromOutputs(c, ['po_number', 'po_number_referenced']);
    const row = {
      caseId: c.jobId, poNumber,
      grNumber: p.grNumber || fromOutputs(c, ['gr_number', 'grn_number']),
      vendor, invoiceNumber, state: matchState(c, f), submittedAt: c.submittedAt, invoices: 1,
    };
    const poKey = poNumber ? poNumber.toLowerCase() : null;
    if (poKey && byPo.has(poKey)) byPo.get(poKey).invoices++;
    else if (poKey) { byPo.set(poKey, row); orders.push(row); } // no PO number read: not a purchase order row
    if (f.completed && f.approved > 0) {
      const terms = fromOutputs(c, ['payment_terms', 'terms']);
      const days = terms && /(\d{1,3})/.test(terms) ? Number(terms.match(/(\d{1,3})/)[1]) : null;
      const approvedAt = (c.review && c.review.reviewedAt) || c.completedAt || c.submittedAt;
      payments.push({
        caseId: c.jobId, vendor, invoiceNumber, amount: f.approved, currency: ccy, terms,
        approvedAt, dueAt: days !== null ? new Date(new Date(approvedAt).getTime() + days * DAY).toISOString() : null,
      });
    }
  }
  res.json({
    vendors: [...vendors.values()].sort((a, b) => b.approved + b.held - (a.approved + a.held) || b.invoices - a.invoices),
    orders,
    payments: payments.sort((a, b) => String(a.dueAt || '9').localeCompare(String(b.dueAt || '9'))),
  });
}));

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Guard against formula injection when the file is opened in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

app.get('/api/export.csv', auth.requireRole('approver', 'admin'), wrap(async (req, res) => {
  const range = rangeFrom(req.query);
  const cases = (await allCases()).filter((c) => inRange(c, range));
  const head = ['Case id', 'Reference', 'Status', 'Vendor', 'Invoice number', 'Payable amount', 'Held amount', 'Currency', 'Decision',
    'Submitted by', 'Submitted at', 'Finished at', 'Run time (s)', 'Reviewed by', 'Reviewed at', 'Approver decision'];
  const lines = [head.map(csvCell).join(',')];
  for (const c of cases) {
    const f = caseFigures(c);
    lines.push([c.jobId, c.reference, f.status, f.s.vendor, f.s.invoiceNumber, f.completed ? f.approved : '', f.completed ? f.held : '',
      f.currency, f.s.outcome, c.submittedBy && person(c.submittedBy).name, c.submittedAt, c.completedAt,
      f.runtimeMs !== null ? Math.round(f.runtimeMs / 1000) : '', c.review && c.review.reviewedBy && person(c.review.reviewedBy).name,
      c.review && c.review.reviewedAt, c.review && c.review.response].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payables-invoices-${ymd(Date.now())}.csv"`);
  res.send('﻿' + displayNames(lines.join('\r\n')));
}));

// Admin clean-up of the set-up period: test runs, runs that never finished,
// reviews that expired unanswered, and review requests that never matched a
// case. GET previews, POST deletes. Old quick-access names on the cases that
// stay are rewritten to the current ones.
async function cleanupPlan() {
  const cases = await allCasesRaw();
  const drop = new Map();
  const dups = duplicateMap(cases.filter((c) => !isTestCase(c)));
  for (const c of cases) {
    if (isTestCase(c)) drop.set(c.jobId, 'test');
    else if (dups.has(c.jobId)) drop.set(c.jobId, 'duplicate');
    else if (FAILURE.includes(c.status)) drop.set(c.jobId, 'unfinished');
    else if (c.review && c.review.status === 'expired') drop.set(c.jobId, 'expired');
  }
  const pendingIds = await store.smembers(PENDING_SET);
  const dispatches = [];
  for (const id of pendingIds) {
    const d = await store.get(DISPATCH_KEY(id));
    if (!d) { dispatches.push(id); continue; }
    if (d.status !== 'pending' || drop.has(d.jobId) || pastLimit(d)) dispatches.push(id);
  }
  const count = (k) => [...drop.values()].filter((v) => v === k).length;
  return { cases, drop, dispatches, summary: { test: count('test'), duplicate: count('duplicate'), unfinished: count('unfinished'), expired: count('expired'), reviews: dispatches.length, kept: cases.length - drop.size } };
}

app.get('/api/admin/cleanup', auth.requireRole('admin'), wrap(async (req, res) => {
  res.json((await cleanupPlan()).summary);
}));

app.post('/api/admin/cleanup', auth.requireRole('admin'), wrap(async (req, res) => {
  const plan = await cleanupPlan();
  for (const c of plan.cases) {
    if (plan.drop.has(c.jobId)) {
      if (c.review && c.review.dispatchId) {
        await store.del(DISPATCH_KEY(c.review.dispatchId));
        await store.srem(PENDING_SET, c.review.dispatchId);
      }
      await store.del(CASE_KEY(c.jobId));
      await store.srem(CASES_SET, c.jobId);
      continue;
    }
    const sb = c.submittedBy && auth.currentPerson(c.submittedBy);
    const rb = c.review && c.review.reviewedBy && auth.currentPerson(c.review.reviewedBy);
    if ((sb && sb.email !== c.submittedBy.email) || (rb && rb.email !== c.review.reviewedBy.email)) {
      await patchCase(c.jobId, {
        submittedBy: sb ? { ...c.submittedBy, name: sb.name, email: sb.email } : c.submittedBy,
        review: rb ? { ...c.review, reviewedBy: { ...c.review.reviewedBy, name: rb.name, email: rb.email } } : c.review,
      });
    }
  }
  for (const id of plan.dispatches) {
    await store.del(DISPATCH_KEY(id));
    await store.srem(PENDING_SET, id);
  }
  console.log(`[cleanup] ${req.user.email}: ${JSON.stringify(plan.summary)}`);
  res.json(plan.summary);
}));

// Admin clean-up: keep the three newest cases, delete the rest everywhere
// (case list, report, export) together with their stored reviews.
const KEEP_ON_CLEAR = 3;
app.post('/api/cases/clear', auth.requireRole('admin'), wrap(async (req, res) => {
  const cases = await allCasesRaw(); // newest first
  const drop = cases.slice(KEEP_ON_CLEAR);
  for (const c of drop) {
    if (c.review && c.review.dispatchId) {
      await store.del(DISPATCH_KEY(c.review.dispatchId));
      await store.srem(PENDING_SET, c.review.dispatchId);
    }
    await store.del(CASE_KEY(c.jobId));
    await store.srem(CASES_SET, c.jobId);
  }
  console.log(`[clear] ${req.user.email} cleared ${drop.length} case(s), kept ${cases.length - drop.length}`);
  res.json({ cleared: drop.length, kept: cases.length - drop.length });
}));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each file must be 10 MB or smaller.' });
  const status = err.status && err.status >= 400 && err.status < 600 && !err.opus ? err.status : 500;
  if (status >= 500) console.error('request error', err);
  const message = err.opus ? 'The matching service returned an error. Try again; if it keeps happening, use Report a problem.' : err.message || 'Something went wrong.';
  const isAdmin = req.user && req.user.role === 'admin';
  res.status(status).json({ error: message, detail: err.opus && isAdmin ? err.message : undefined });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Payables Hub on http://localhost:${PORT}  (storage: ${store.kind})`);
    const missing = missingEnv();
    if (missing.length) console.warn('Missing configuration:', missing.join(', '));
  });
}

module.exports = app;
