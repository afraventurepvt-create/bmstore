'use strict';
/**
 * tls-ask — Caddy on-demand TLS gate.
 *
 * Caddy calls   GET /ask?domain=<host>   before issuing a certificate for a host it has no
 * certificate for. We answer 200 ONLY when the host belongs to an existing tenant, otherwise 403,
 * so nobody can make this server request certificates for arbitrary names (and burn LE rate limits).
 *
 * Source of truth is the API itself: GET /health with Host: <domain>
 *   200 + {tenant: "<slug>"}   -> tenant exists and is active      -> approve
 *   403 (suspended / expired)  -> tenant exists                    -> approve (so the 403 page is served over TLS)
 *   404 (unknown store)        -> deny
 *   200 + {tenant: null}       -> platform host / IP / root domain -> deny (those have explicit Caddy sites)
 * Zero dependencies; runs as a tiny container next to the API.
 */
const http = require('node:http');
const net = require('node:net');

const PORT = Number(process.env.PORT || 8080);
const API = new URL(process.env.API_UPSTREAM || 'http://api:3000');
const ROOT_DOMAIN = String(process.env.ROOT_DOMAIN || '').toLowerCase().replace(/\.$/, '');
const RESERVED = new Set(['www', 'admin', 'api', 'app', 'static', 'cdn', 'mail', 'console', 'media', 'minio']);
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_CACHE = 5000;
const MAX_INFLIGHT = 20;
const API_TIMEOUT_MS = 3000;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const cache = new Map(); // domain -> { ok: boolean, until: number }
let inflight = 0;

function normalize(raw) {
  if (typeof raw !== 'string') return null;
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!d || d.length > 253 || d.length < 3) return null;
  if (net.isIP(d)) return null;
  if (d.includes('..')) return null;
  const labels = d.split('.');
  if (labels.length < 2) return null; // no bare TLDs
  if (!labels.every((l) => LABEL.test(l))) return null;
  if (labels[labels.length - 1].length < 2) return null; // TLDs are at least 2 chars
  return d;
}

function staticDecision(domain) {
  if (!ROOT_DOMAIN) return null;
  if (domain === ROOT_DOMAIN) return false;
  if (domain.endsWith('.' + ROOT_DOMAIN)) {
    const sub = domain.slice(0, -(ROOT_DOMAIN.length + 1));
    if (sub.includes('.')) return false; // nested labels are never tenants
    if (RESERVED.has(sub)) return false; // platform hosts have their own Caddy sites
  }
  return null; // ask the API
}

function askApi(domain) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: API.hostname,
        port: API.port || 80,
        path: '/health',
        method: 'GET',
        headers: { Host: domain, 'User-Agent': 'bmstore-tls-ask', Accept: 'application/json' },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 4096) body += c; });
        res.on('end', () => {
          if (res.statusCode === 403) return resolve({ ok: true, why: 'tenant-inactive' });
          if (res.statusCode === 404) return resolve({ ok: false, why: 'unknown-host' });
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(body);
              return resolve(j && j.tenant ? { ok: true, why: 'tenant' } : { ok: false, why: 'platform-host' });
            } catch { return resolve({ ok: false, why: 'bad-json' }); }
          }
          resolve({ ok: false, why: 'api-status-' + res.statusCode, transient: res.statusCode >= 500 });
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, why: 'api-error:' + (e.code || e.message), transient: true }));
    req.end();
  });
}

function remember(domain, ok) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(domain, { ok, until: Date.now() + (ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
}

function log(obj) { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname !== '/ask' || req.method !== 'GET') { res.writeHead(404); return res.end(); }

  const domain = normalize(url.searchParams.get('domain'));
  if (!domain) { log({ domain: url.searchParams.get('domain'), decision: 'deny', why: 'invalid' }); res.writeHead(403); return res.end('invalid domain'); }

  const fixed = staticDecision(domain);
  if (fixed === false) { log({ domain, decision: 'deny', why: 'reserved' }); res.writeHead(403); return res.end('not a tenant host'); }

  const hit = cache.get(domain);
  if (hit && hit.until > Date.now()) { res.writeHead(hit.ok ? 200 : 403); return res.end(hit.ok ? 'ok' : 'not a tenant host'); }

  if (inflight >= MAX_INFLIGHT) { log({ domain, decision: 'deny', why: 'overloaded' }); res.writeHead(503); return res.end('busy'); }
  inflight++;
  let r;
  try { r = await askApi(domain); } finally { inflight--; }
  if (!r.transient) remember(domain, r.ok);
  log({ domain, decision: r.ok ? 'allow' : 'deny', why: r.why });
  res.writeHead(r.ok ? 200 : r.transient ? 503 : 403, { 'content-type': 'text/plain' });
  res.end(r.ok ? 'ok' : 'not a tenant host');
});

server.listen(PORT, () => log({ msg: 'tls-ask listening', port: PORT, rootDomain: ROOT_DOMAIN, api: API.href }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
