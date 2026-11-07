import { NextRequest, NextResponse } from 'next/server';
import { REFRESH, apiFetch, clearSession } from '@/lib/server/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const refresh = req.cookies.get(REFRESH)?.value;
  if (refresh) await apiFetch(req, '/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) }).catch(() => undefined);
  const res = NextResponse.json({ ok: true });
  clearSession(res);
  return res;
}
