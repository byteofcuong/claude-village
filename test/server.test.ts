import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createVillageServer, type VillageServer } from '../src/server/server.js';
import type { VillageSnapshot } from '../src/shared/types.js';

let dir: string;
let vs: VillageServer;
const snap: VillageSnapshot = { at: 1, houses: [], tent: null, hiddenHouses: 0 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cv-srv-'));
  await mkdir(join(dir, 'client'));
  await writeFile(join(dir, 'client', 'index.html'), '<h1>village</h1>');
  await writeFile(join(dir, 'secret.txt'), 'outside');
  vs = await createVillageServer({ clientDir: join(dir, 'client'), port: 0 });
});
afterEach(async () => {
  await vs.close();
  await rm(dir, { recursive: true, force: true });
});

const http = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((ok, no) => {
  const req = request({ host: '127.0.0.1', port: vs.port, path, method, headers: { host: `127.0.0.1:${vs.port}`, ...headers } }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
  });
  req.on('error', no);
  req.end();
});

const connect = (headers: Record<string, string>) => new Promise<{ ws: WebSocket; opened: boolean; first?: string }>((ok) => {
  const ws = new WebSocket(`ws://127.0.0.1:${vs.port}/ws`, { headers, origin: headers['origin'] });
  ws.once('open', () => ok({ ws, opened: true }));
  ws.once('error', () => ok({ ws, opened: false }));
});
const good = () => ({ host: `127.0.0.1:${vs.port}`, origin: `http://127.0.0.1:${vs.port}` });

describe('http', () => {
  it('binds to loopback only', () => {
    expect((vs.server.address() as { address: string }).address).toBe('127.0.0.1');
  });
  it('serves files with security headers and no CORS', async () => {
    const r = await http('/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('village');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('rejects a wrong Host, which stops DNS rebinding', async () => {
    expect((await http('/', { host: 'evil.example' })).status).toBe(403);
    expect((await http('/', { host: `evil.example:${vs.port}` })).status).toBe(403);
    expect((await http('/', { host: '127.0.0.1:1' })).status).toBe(403);
    expect((await http('/', { host: `localhost:${vs.port}` })).status).toBe(200);
  });
  it('blocks traversal, including encoded forms', async () => {
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt']) {
      const r = await http(p);
      expect(r.body).not.toContain('outside');
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect((await http('/a%00b')).status).toBe(400);
    expect((await http('/%E0%A4%A')).status).toBe(400);
  });
  it('allows only reads', async () => {
    expect((await http('/', {}, 'POST')).status).toBe(405);
    const head = await http('/', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await http('/missing.js')).status).toBe(404);
  });
});

describe('websocket', () => {
  it('accepts the app origin and sends the latest snapshot', async () => {
    vs.publish(snap);
    const ws = new WebSocket(`ws://127.0.0.1:${vs.port}/ws`, { origin: good().origin });
    const text = await new Promise<string>((ok, no) => { ws.once('message', (d) => ok(String(d))); ws.once('error', no); });
    expect(JSON.parse(text)).toEqual(snap);
    ws.terminate();
  });
  it('rejects a wrong or missing Origin and a wrong Host', async () => {
    expect((await connect({ origin: 'http://evil.example' })).opened).toBe(false);
    expect((await connect({ origin: `http://127.0.0.1:${vs.port}.evil.example` })).opened).toBe(false);
    expect((await connect({})).opened).toBe(false);
    expect((await connect({ origin: good().origin, host: 'evil.example' })).opened).toBe(false);
  });
  it('closes the socket when a client sends anything', async () => {
    const { ws, opened } = await connect({ origin: good().origin });
    expect(opened).toBe(true);
    const code = await new Promise<number>((ok) => { ws.once('close', (c) => ok(c)); ws.send('do something'); });
    expect(code).toBe(1008);
  });
  it('survives a malformed upgrade URL', async () => {
    await new Promise<void>((ok) => {
      const req = request({ host: '127.0.0.1', port: vs.port, path: '//', headers: { host: good().host, origin: good().origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('response', () => ok());
      req.on('upgrade', () => ok());
      req.on('error', () => ok());
      req.end();
    });
    expect((await http('/')).status).toBe(200);
  });
  it('closes the socket on an oversized frame', async () => {
    const { ws, opened } = await connect({ origin: good().origin });
    expect(opened).toBe(true);
    const code = await new Promise<number>((ok) => { ws.on('error', () => undefined); ws.once('close', (c) => ok(c)); ws.send('x'.repeat(5000)); });
    expect(code).not.toBe(1000);
  });
  it('refuses other socket paths', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${vs.port}/other`, { origin: good().origin });
    expect(await new Promise((ok) => { ws.once('open', () => ok(true)); ws.once('error', () => ok(false)); })).toBe(false);
  });
});
