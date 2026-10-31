// Loopback HTTP and WebSocket. Exact Host and Origin checks stop other sites, including DNS
// rebinding, from reading the village. The socket only ever sends: any inbound message closes it.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { VillageSnapshot } from '../shared/types.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};
export const BIND_HOST = '127.0.0.1';

export interface VillageServer {
  server: Server;
  port: number;
  publish(snapshot: VillageSnapshot): void;
  close(): Promise<void>;
}

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}
export function allowedOrigins(port: number): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

function securityHeaders(port: number): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob: data:", "font-src 'self'",
      `connect-src 'self' blob: data: ws://127.0.0.1:${port} ws://localhost:${port}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function isSocketPath(url: string | undefined): boolean {
  try {
    return new URL(url ?? '/', 'http://x').pathname === '/ws';
  } catch {
    return false;
  }
}

export function createVillageServer(opts: { clientDir: string; port: number }): Promise<VillageServer> {
  const root = resolve(opts.clientDir);
  let last: string | null = null;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  let port = opts.port;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const headers = securityHeaders(port);
    const fail = (code: number) => { res.writeHead(code, { ...headers, 'Content-Type': 'text/plain' }); res.end(); };
    if (!allowedHosts(port).has(req.headers.host ?? '')) return fail(403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405);
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return fail(400);
    }
    if (path.includes('\0')) return fail(400);
    const file = resolve(join(root, normalize(path === '/' ? '/index.html' : path)));
    if (file !== root && !file.startsWith(root + sep)) return fail(403);
    try {
      const info = await stat(file);
      if (!info.isFile()) return fail(404);
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      fail(404);
    }
  };

  const server = createHttp((req, res) => void handle(req, res));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const ok = allowedHosts(port).has(req.headers.host ?? '') && allowedOrigins(port).has(req.headers.origin ?? '') && isSocketPath(req.url);
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', () => ws.close(1008, 'read-only'));
      ws.on('error', () => ws.terminate());
      if (last) ws.send(last);
    });
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, BIND_HOST, () => {
      port = (server.address() as AddressInfo).port;
      server.removeListener('error', fail);
      server.on('error', (err) => console.error('server error:', err.message));
      ok({
        server,
        port,
        publish(snapshot) {
          const text = JSON.stringify(snapshot);
          last = text;
          for (const c of sockets.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
        },
        close: () => new Promise((done) => {
          for (const c of sockets.clients) c.terminate();
          sockets.close();
          server.close(() => done());
        }),
      });
    });
  });
}
