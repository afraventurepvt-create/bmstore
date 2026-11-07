import { NextRequest, NextResponse } from 'next/server';
import { ACCESS, apiFetch, clearSession, refreshTokens, setSession } from '@/lib/server/proxy';

export const dynamic = 'force-dynamic';

/**
 * Same-origin proxy for the browser: /api/<anything> -> API /<anything>, with the store Host forwarded and the
 * access token taken from the httpOnly cookie. On 401 the refresh token is used once and the request retried.
 * Bodies (JSON, CSV/XLSX bytes) pass through untouched.
 */
async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `/${path.join('/')}${req.nextUrl.search}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const h of ['content-type', 'accept']) { const v = req.headers.get(h); if (v) headers[h] = v; }

  let token = req.cookies.get(ACCESS)?.value ?? null;
  let upstream = await apiFetch(req, target, { method: req.method, headers, body, token });
  let newTokens: { accessToken: string; refreshToken: string } | null = null;
  if (upstream.status === 401 && !target.startsWith('/auth/')) {
    newTokens = await refreshTokens(req);
    if (newTokens) {
      token = newTokens.accessToken;
      upstream = await apiFetch(req, target, { method: req.method, headers, body, token });
    }
  }
  const res = new NextResponse(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status });
  for (const h of ['content-type', 'content-disposition', 'retry-after', 'x-request-id']) { const v = upstream.headers.get(h); if (v) res.headers.set(h, v); }
  if (newTokens) setSession(res, req, newTokens);
  else if (upstream.status === 401) clearSession(res);
  return res;
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
