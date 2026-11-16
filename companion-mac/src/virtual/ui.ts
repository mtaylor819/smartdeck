// Web UI for the virtual deck: renders the 800x480 panel in a browser and acts as its touch panel and knob.
// Same hardening as src/server.ts: 127.0.0.1 only, Host/Origin checks, per-process CSRF token on every POST, strict CSP.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeckEmulator } from './emulator.js';

export interface VirtualUi {
  port: number;
  url: string;
  token: string;
  close(): Promise<void>;
}

const ICON_RE = /^[A-Za-z0-9._-]+\.jpe?g$/i;
const STATIC: Record<string, string> = {
  '/app.js': 'application/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
};

function assetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '..', '..', 'ui-virtual'), join(here, '..', 'ui-virtual')]) if (existsSync(join(c, 'index.html'))) return c;
  throw new Error('ui-virtual/ directory not found');
}

class HttpError extends Error { constructor(public status: number, m: string) { super(m); } }

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 16384) { reject(new HttpError(413, 'too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}

const num = (v: unknown, name: string, lo = -1e6, hi = 1e6): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `${name} must be a number in ${lo}..${hi}`);
  return v;
};

export function startVirtualUi(deck: DeckEmulator, dataDir: string, opts: { port: number; host?: string }): Promise<VirtualUi> {
  const host = opts.host ?? '127.0.0.1';
  const dir = assetsDir();
  const token = randomBytes(24).toString('hex');
  let boundPort = 0;

  const tokenOk = (req: IncomingMessage) => {
    const got = req.headers['x-smartdeck-token'];
    return typeof got === 'string' && got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token));
  };
  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, obj: unknown) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const hostHdr = req.headers.host ?? '';
    if (hostHdr !== `127.0.0.1:${boundPort}` && hostHdr !== `localhost:${boundPort}`) return json(res, 403, { error: 'bad host' });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${hostHdr}`) return json(res, 403, { error: 'bad origin' });
    const url = new URL(req.url ?? '/', `http://${hostHdr}`);
    const path = url.pathname, method = req.method ?? 'GET';
    try {
      if (method === 'GET' && (path === '/' || path === '/index.html'))
        return send(res, 200, readFileSync(join(dir, 'index.html'), 'utf8').replace('__CSRF_TOKEN__', token), 'text/html; charset=utf-8');
      if (method === 'GET' && STATIC[path]) return send(res, 200, readFileSync(join(dir, path.slice(1))), STATIC[path]);
      if (method === 'GET' && path.startsWith('/icons/')) {
        const name = decodeURIComponent(path.slice('/icons/'.length));
        if (!ICON_RE.test(name)) return json(res, 400, { error: 'invalid icon name' });
        const f = join(dataDir, name);
        if (!existsSync(f)) return json(res, 404, { error: 'not found' });
        return send(res, 200, readFileSync(f), 'image/jpeg');
      }
      if (method === 'GET' && path === '/api/state') return json(res, 200, deck.snapshot());
      if (method === 'POST' && path.startsWith('/api/')) {
        if (!tokenOk(req)) return json(res, 403, { error: 'bad token' });
        const b = await readJson(req);
        switch (path) {
          case '/api/touch': return json(res, 200, deck.touch(num(b.index, 'index', 0, 255), b.holdMs === undefined ? 80 : num(b.holdMs, 'holdMs', 0, 60000)));
          case '/api/swipe': return json(res, 200, deck.swipe(num(b.dx, 'dx'), num(b.dy, 'dy'), num(b.ms, 'ms', 0, 60000)));
          case '/api/knob': deck.knob(num(b.raw, 'raw', 0, 4095)); return json(res, 200, { ok: true });
          case '/api/ack': return json(res, 200, { acked: deck.ackAlert() });
          case '/api/wake': deck.touchWake(); return json(res, 200, { ok: true });
          case '/api/sleep': deck.sleepNow(); return json(res, 200, { ok: true });
          case '/api/ble': deck.setBlePeer(typeof b.peer === 'string' ? b.peer : ''); return json(res, 200, { ok: true });
          case '/api/lux': deck.setLux(num(b.lux, 'lux', 0, 200000)); return json(res, 200, { ok: true });
          case '/api/ble-slot': {
            // same effect as pressing a `blehost` button on the deck
            if (!(b.slot === 1 || b.slot === 2 || b.slot === 3 || b.slot === 'next')) throw new HttpError(400, 'slot must be 1, 2, 3 or "next"');
            return json(res, 200, deck.bleHost(b.slot));
          }
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      return json(res, 500, { error: 'internal error' });
    }
  };

  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ port: boundPort, url: `http://127.0.0.1:${boundPort}/`, token, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}
