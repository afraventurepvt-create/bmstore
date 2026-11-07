'use client';

/** Browser-side client for the same-origin proxy (/api/...). Errors carry the API's plain-language message. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); }
}

function messageOf(body: any, status: number): string {
  const m = body?.message;
  if (Array.isArray(m)) return m.join('. ');
  if (typeof m === 'string') return m;
  if (status === 401) return 'Please sign in again';
  if (status === 403) return 'You do not have permission for that';
  if (status === 404) return 'Not found';
  if (status === 429) return 'Too many attempts, please wait a minute';
  return 'Something went wrong. Please try again';
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.json); }
  const r = await fetch(`/api${path}`, { ...init, headers, body, credentials: 'same-origin' });
  if (r.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  const data = text ? safeJson(text) : null;
  if (!r.ok) throw new ApiError(r.status, messageOf(data, r.status), data);
  return data as T;
}
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return t; } };

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Upload images: presign -> PUT -> complete -> poll until READY. Returns the media rows. */
export async function uploadImages(files: File[], kind = 'product', onProgress?: (done: number, total: number) => void) {
  const pre = await api<{ files: Array<{ id: string; uploadUrl: string; headers: Record<string, string> }> }>('/store/media/presign', {
    method: 'POST', json: { files: files.map((f) => ({ filename: f.name, contentType: f.type, size: f.size, kind })) },
  });
  let done = 0;
  await Promise.all(pre.files.map(async (p, i) => {
    const r = await fetch(p.uploadUrl, { method: 'PUT', headers: p.headers, body: files[i] });
    if (!r.ok) throw new ApiError(r.status, `Could not upload ${files[i].name}`);
    onProgress?.(++done, files.length);
  }));
  const ids = pre.files.map((p) => p.id);
  const done2 = await api<{ results: Array<{ id: string; status: string; reason?: string }> }>('/store/media/complete', { method: 'POST', json: { ids } });
  const bad = done2.results.find((r) => r.status === 'FAILED' || r.status === 'NOT_FOUND');
  if (bad) throw new ApiError(400, bad.reason ?? 'Upload failed');
  // wait for the worker (usually a second or two)
  const out: any[] = [];
  for (const id of ids) {
    for (let i = 0; i < 40; i++) {
      const m = await api(`/store/media/${id}`);
      if (m.status === 'READY') { out.push(m); break; }
      if (m.status === 'FAILED') throw new ApiError(400, m.error ?? 'Could not process the image');
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  return out;
}
