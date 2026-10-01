// Key-value storage used for users, cases and pending reviews.
//
// Works with whichever Redis Vercel injected into the project:
//   - REST credentials (Upstash / Vercel KV):  *_KV_REST_API_URL + *_KV_REST_API_TOKEN
//                                             or *_UPSTASH_REDIS_REST_URL + *_TOKEN
//   - TCP connection string:                  *REDIS_URL
// Vercel prefixes injected variables with the store name (MYSTORE_KV_REST_API_URL),
// so they are matched by SUFFIX, not exact name.
//
// With nothing configured it falls back to an in-memory store. That is fine for
// local testing only: on Vercel each serverless instance would get its own copy,
// so /api/health reports it and the UI shows a warning banner.

function envBySuffix(suffix) {
  const keys = Object.keys(process.env).filter((k) => k === suffix || k.endsWith('_' + suffix));
  // Prefer the exact name, then the shortest prefixed one.
  keys.sort((a, b) => (a === suffix ? -1 : b === suffix ? 1 : a.length - b.length));
  return keys.length ? process.env[keys[0]] : undefined;
}

function parse(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw; // @upstash/redis auto-deserialises JSON
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function createStore() {
  const restUrl = envBySuffix('KV_REST_API_URL') || envBySuffix('UPSTASH_REDIS_REST_URL');
  const restToken = envBySuffix('KV_REST_API_TOKEN') || envBySuffix('UPSTASH_REDIS_REST_TOKEN');
  const tcpUrl = envBySuffix('REDIS_URL') || envBySuffix('KV_URL');

  if (restUrl && restToken) {
    const { Redis } = require('@upstash/redis');
    const r = new Redis({ url: restUrl, token: restToken });
    return {
      kind: 'redis-rest',
      durable: true,
      async get(k) { return parse(await r.get(k)); },
      async set(k, v) { await r.set(k, JSON.stringify(v)); },
      async del(k) { await r.del(k); },
      async sadd(k, m) { await r.sadd(k, String(m)); },
      async srem(k, m) { await r.srem(k, String(m)); },
      async smembers(k) { return ((await r.smembers(k)) || []).map(String); },
      async incr(k, ttlSec) { const n = await r.incr(k); if (ttlSec) await r.expire(k, ttlSec); return n; },
    };
  }

  if (tcpUrl) {
    const IORedis = require('ioredis');
    const r = new IORedis(tcpUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    return {
      kind: 'redis-tcp',
      durable: true,
      async get(k) { return parse(await r.get(k)); },
      async set(k, v) { await r.set(k, JSON.stringify(v)); },
      async del(k) { await r.del(k); },
      async sadd(k, m) { await r.sadd(k, String(m)); },
      async srem(k, m) { await r.srem(k, String(m)); },
      async smembers(k) { return ((await r.smembers(k)) || []).map(String); },
      async incr(k, ttlSec) { const n = await r.incr(k); if (ttlSec) await r.expire(k, ttlSec); return n; },
    };
  }

  const kv = new Map();
  const sets = new Map();
  const set = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  return {
    kind: 'memory',
    durable: false,
    async get(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
    async set(k, v) { kv.set(k, JSON.stringify(v)); },
    async del(k) { kv.delete(k); },
    async sadd(k, m) { set(k).add(String(m)); },
    async srem(k, m) { set(k).delete(String(m)); },
    async smembers(k) { return Array.from(set(k)); },
    async incr(k) { const n = (Number(kv.get(k)) || 0) + 1; kv.set(k, String(n)); return n; },
  };
}

module.exports = createStore();
