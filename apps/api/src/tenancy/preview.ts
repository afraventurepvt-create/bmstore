import type { Response } from 'express';

/**
 * Stores in BUILDING status are served only as previews: never indexed, visibly marked.
 *  - every response gets `X-Robots-Tag: noindex, nofollow` (search engines honour it for any content type),
 *  - HTML responses additionally get a <meta name="robots"> tag in <head> and a small "Preview" ribbon after <body>.
 * The HTML injection wraps res.write/res.end so it applies to any renderer (template engine, static file, string).
 */
export const PREVIEW_ROBOTS_HEADER = 'noindex, nofollow';
export const PREVIEW_META_TAG = '<meta name="robots" content="noindex, nofollow">';
export const PREVIEW_RIBBON_HTML =
  '<div data-bmstore-preview style="position:fixed;top:12px;right:-44px;z-index:2147483647;transform:rotate(45deg);' +
  'background:#b45309;color:#fff;font:600 12px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;' +
  'padding:8px 56px;box-shadow:0 2px 6px rgba(0,0,0,.25);pointer-events:none">Preview</div>';

export function markPreview(res: Response) {
  res.setHeader('X-Robots-Tag', PREVIEW_ROBOTS_HEADER);
  const chunks: Buffer[] = [];
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const isHtml = () => String(res.getHeader('content-type') ?? '').toLowerCase().includes('text/html');
  const collect = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null) return;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'));
  };
  (res as any).write = (chunk: unknown, encoding?: unknown, cb?: unknown) => {
    if (!isHtml()) return write(chunk as any, encoding as any, cb as any);
    collect(chunk, encoding);
    if (typeof encoding === 'function') (encoding as () => void)();
    else if (typeof cb === 'function') (cb as () => void)();
    return true;
  };
  (res as any).end = (chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (!isHtml()) return end(chunk as any, encoding as any, cb as any);
    collect(chunk, encoding);
    const body = injectPreview(Buffer.concat(chunks).toString('utf8'));
    res.removeHeader('content-length');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    return end(body, 'utf8', (typeof encoding === 'function' ? encoding : cb) as any);
  };
}

/** Pure: add the meta tag and the ribbon to an HTML document (idempotent). */
export function injectPreview(html: string): string {
  let out = html;
  if (!out.includes(PREVIEW_META_TAG)) {
    out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}${PREVIEW_META_TAG}`) : `${PREVIEW_META_TAG}${out}`;
  }
  if (!out.includes('data-bmstore-preview')) {
    out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => `${m}${PREVIEW_RIBBON_HTML}`) : `${out}${PREVIEW_RIBBON_HTML}`;
  }
  return out;
}
