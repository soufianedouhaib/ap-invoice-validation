// Users, roles, password hashing and sessions.
//
// Roles:
//   clerk     submits invoice packs and sees only their own cases
//   approver  sees every case and actions human reviews
//   admin     everything an approver can do, plus user management
//
// Sessions are a signed cookie (HMAC-SHA256 with SESSION_SECRET), so they work
// across serverless instances without a session table. The user record is still
// re-read on every request, so disabling a user or changing their role takes
// effect immediately rather than when the cookie expires.

const crypto = require('crypto');
const store = require('./store');

const ROLES = ['clerk', 'approver', 'admin'];
const COOKIE = 'ap_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const USERS_KEY = 'ap:users';

// ---------- password hashing (scrypt, no native deps) ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters.';
  return null;
}

// ---------- users ----------

async function listUsers() {
  const users = await store.get(USERS_KEY);
  return Array.isArray(users) ? users : [];
}

async function saveUsers(users) {
  await store.set(USERS_KEY, users);
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active !== false, createdAt: u.createdAt };
}

async function findUserByEmail(email) {
  const e = normEmail(email);
  return (await listUsers()).find((u) => u.email === e) || null;
}

async function findUserById(id) {
  return (await listUsers()).find((u) => u.id === id) || null;
}

async function createUser({ email, name, role, password }) {
  const e = normEmail(email);
  if (!e || !e.includes('@')) throw httpError(400, 'A valid email is required.');
  if (!name || !String(name).trim()) throw httpError(400, 'Name is required.');
  if (!ROLES.includes(role)) throw httpError(400, 'Role must be clerk, approver or admin.');
  const problem = passwordProblem(password);
  if (problem) throw httpError(400, problem);

  const users = await listUsers();
  if (users.some((u) => u.email === e)) throw httpError(409, 'A user with that email already exists.');
  const user = {
    id: crypto.randomUUID(),
    email: e,
    name: String(name).trim(),
    role,
    active: true,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await saveUsers(users);
  return user;
}

async function updateUser(id, changes) {
  const users = await listUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) throw httpError(404, 'User not found.');
  const u = { ...users[idx] };
  if (changes.name !== undefined) u.name = String(changes.name).trim() || u.name;
  if (changes.role !== undefined) {
    if (!ROLES.includes(changes.role)) throw httpError(400, 'Invalid role.');
    u.role = changes.role;
  }
  if (changes.active !== undefined) u.active = Boolean(changes.active);
  if (changes.password !== undefined) {
    const problem = passwordProblem(changes.password);
    if (problem) throw httpError(400, problem);
    u.passwordHash = hashPassword(changes.password);
  }
  // Never leave the system without an active admin.
  const remainingAdmins = users.filter((x, i) => (i === idx ? u : x)).filter((x) => x.role === 'admin' && x.active !== false);
  if (!remainingAdmins.length) throw httpError(400, 'There must always be at least one active admin.');
  users[idx] = u;
  await saveUsers(users);
  return u;
}

// First run: if no users exist yet, the BOOTSTRAP_ADMIN_EMAIL / _PASSWORD pair
// creates the first admin on its first successful login. After that the env
// pair does nothing, so it cannot be used as a permanent back door.
async function maybeBootstrapAdmin(email, password) {
  const bEmail = normEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const bPass = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!bEmail || !bPass) return null;
  if ((await listUsers()).length) return null;
  if (normEmail(email) !== bEmail || password !== bPass) return null;
  return createUser({ email: bEmail, name: process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator', role: 'admin', password: bPass });
}

// ---------- sessions ----------

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token || !SESSION_SECRET) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, user) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = sign({ uid: user.id, exp });
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Express middleware: attaches req.user (or null). Never rejects by itself.
async function loadUser(req, res, next) {
  req.user = null;
  try {
    const payload = unsign(readCookie(req, COOKIE));
    if (payload) {
      const u = await findUserById(payload.uid);
      if (u && u.active !== false) req.user = u;
    }
  } catch (err) {
    console.error('session load error', err);
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your role does not allow this.' });
    next();
  };
}

// Mutating requests must carry this header. Browsers cannot add it to a
// cross-site form post, which (with SameSite=Lax) closes off CSRF.
function requireAjaxHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'ap-console') return res.status(400).json({ error: 'Missing request header.' });
  next();
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  ROLES,
  hashPassword,
  verifyPassword,
  listUsers,
  findUserByEmail,
  findUserById,
  createUser,
  updateUser,
  publicUser,
  maybeBootstrapAdmin,
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireUser,
  requireRole,
  requireAjaxHeader,
  httpError,
  normEmail,
  sessionSecretConfigured: () => SESSION_SECRET.length >= 32,
};
