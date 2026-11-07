import { NextRequest, NextResponse } from 'next/server';
import { apiFetch, setSession } from '@/lib/server/proxy';

export const dynamic = 'force-dynamic';

/** Logs in against the API and stores the token pair in httpOnly cookies. */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const r = await apiFetch(req, '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const res = NextResponse.json(data, { status: r.status });
    const ra = r.headers.get('retry-after');
    if (ra) res.headers.set('retry-after', ra);
    return res;
  }
  const res = NextResponse.json({ ok: true });
  setSession(res, req, data);
  return res;
}
