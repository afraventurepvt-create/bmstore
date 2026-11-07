import http from 'node:http';
import https from 'node:https';
import { NextRequest, NextResponse } from 'next/server';

export const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const ACCESS = 'bm_access';
export const REFRESH = 'bm_refresh';

/** The store host the browser used (the API resolves the tenant from it; its port is ignored there). */
export function storeHost(req: NextRequest) {
  return req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost';
}

const secure = (req: NextRequest) => req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';

export function setSession(res: NextResponse, req: NextRequest, tokens: { accessToken: string; refreshToken: string }) {
  const base = { httpOnly: true, sameSite: 'lax' as const, secure: secure(req), path: '/' };
  res.cookies.set(ACCESS, tokens.accessToken, { ...base, maxAge: 60 * 60 * 24 * 30 }); // kept; the API decides validity (15 min)
  res.cookies.set(REFRESH, tokens.refreshToken, { ...base, maxAge: 60 * 60 * 24 * 30 });
}
export function clearSession(res: NextResponse) {
  res.cookies.set(ACCESS, '', { path: '/', maxAge: 0 });
  res.cookies.set(REFRESH, '', { path: '/', maxAge: 0 });
}

/**
 * Upstream call with the STORE Host header. Node's fetch (undici) refuses to send a custom Host, so this uses
 * http.request, which lets the API resolve the tenant exactly as if the browser had called it directly.
 */
export async function apiFetch(req: NextRequest, path: string, init: { method?: string; headers?: HeadersInit; body?: Buffer | string; token?: string | null } = {}): Promise<Response> {
  const url = new URL(`${API_URL}${path}`);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  headers.host = storeHost(req);
  const xff = req.headers.get('x-forwarded-for');
  if (xff) headers['x-forwarded-for'] = xff;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const body = init.body === undefined ? undefined : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body);
  if (body) headers['content-length'] = String(body.length);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const r = client.request(url, { method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
        const status = res.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: h }));
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/** POST /auth/refresh with the cookie; returns the new pair or null. */
export async function refreshTokens(req: NextRequest): Promise<{ accessToken: string; refreshToken: string } | null> {
  const refresh = req.cookies.get(REFRESH)?.value;
  if (!refresh) return null;
  const r = await apiFetch(req, '/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) });
  if (!r.ok) return null;
  return r.json();
}
