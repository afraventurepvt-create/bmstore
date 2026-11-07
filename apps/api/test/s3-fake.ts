/**
 * A tiny S3-compatible object store for tests (path-style: /<bucket>/<key>). Supports PUT, GET, HEAD, DELETE.
 * Ignores authentication (presigned or signed requests alike), which is exactly what a test double should do.
 * Real deployments use MinIO (docker-compose), R2 or S3 through the same AWS SDK client.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

export interface FakeS3 { server: Server; port: number; objects: Map<string, { body: Buffer; contentType: string }>; close(): Promise<void> }

export function startFakeS3(port = 0): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') {
        const declared = req.headers['content-length'];
        if (declared !== undefined && Number(declared) !== body.length) { res.writeHead(400); return res.end('length mismatch'); }
        objects.set(key, { body, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') });
        res.writeHead(200, { ETag: '"fake"' }); return res.end();
      }
      const obj = objects.get(key);
      if (req.method === 'HEAD' || req.method === 'GET') {
        if (!obj) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
        res.writeHead(200, { 'Content-Length': String(obj.body.length), 'Content-Type': obj.contentType, ETag: '"fake"', 'Last-Modified': new Date().toUTCString() });
        return res.end(req.method === 'GET' ? obj.body : undefined);
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as any).port as number;
      resolve({ server, port: p, objects, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
