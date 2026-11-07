'use strict';
// Self-contained test: fake API on a random port, tls-ask on another, assert decisions.
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

const TENANTS = { 'acme.store.example.com': 'acme', 'shop.client.com': 'client' };
const SUSPENDED = new Set(['bad.store.example.com']);

const api = http.createServer((req, res) => {
  const host = (req.headers.host || '').toLowerCase();
  if (req.url !== '/health') { res.writeHead(404); return res.end(); }
  if (SUSPENDED.has(host)) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"statusCode":403,"message":"Store suspended"}'); }
  if (TENANTS[host]) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, tenant: TENANTS[host] })); }
  if (host === 'store.example.com' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^(www|api|admin|cdn)\.store\.example\.com$/.test(host)) {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"tenant":null}');
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"statusCode":404,"message":"Store not found"}');
});

function get(port, p) {
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiPort = api.address().port;
  const askPort = 18080 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(askPort), API_UPSTREAM: `http://127.0.0.1:${apiPort}`, ROOT_DOMAIN: 'store.example.com' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', () => {});
  for (let i = 0; i < 50; i++) { try { if ((await get(askPort, '/healthz')) === 200) break; } catch {} await sleep(50); }

  const cases = [
    ['acme.store.example.com', 200, 'active tenant subdomain'],
    ['shop.client.com', 200, 'custom domain tenant'],
    ['bad.store.example.com', 200, 'suspended tenant still gets a cert'],
    ['nope.store.example.com', 403, 'unknown subdomain'],
    ['evil.example.org', 403, 'unknown custom domain'],
    ['store.example.com', 403, 'root domain is not a tenant'],
    ['api.store.example.com', 403, 'reserved platform subdomain'],
    ['console.store.example.com', 403, 'reserved (console)'],
    ['a.b.store.example.com', 403, 'nested labels'],
    ['1.2.3.4', 403, 'ip address'],
    ['localhost', 403, 'single label'],
    ['bad_name.client.com', 403, 'underscore'],
    ['', 403, 'empty'],
    ['x'.repeat(70) + '.client.com', 403, 'label too long'],
  ];
  let failed = 0;
  for (const [domain, want, label] of cases) {
    const got = await get(askPort, '/ask?domain=' + encodeURIComponent(domain));
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(40)} ${domain || '(empty)'} -> ${got} (want ${want})`);
  }
  assert.strictEqual(await get(askPort, '/ask?domain=acme.store.example.com'), 200, 'cached positive');
  assert.strictEqual(await get(askPort, '/other'), 404);
  child.kill('SIGTERM');
  api.close();
  if (failed) { console.error(`${failed} case(s) failed`); process.exit(1); }
  console.log('all tls-ask cases passed');
})().catch((e) => { console.error(e); process.exit(1); });
