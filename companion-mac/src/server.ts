import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonApi } from './api.js';
import type { Config } from './config.js';
import {
  deleteIcon, FetchLike, ICON_FILE_RE, listIcons, saveIcon, saveIconifyIcon, searchIconify,
} from './icons.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Injected in tests so nothing touches the network. */
  fetchImpl?: FetchLike;
}

export interface RunningServer {
  port: number;
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 5 * 1024 * 1024;
const MASK = '***';

/** ui/ lives next to src/ (tsx) or next to dist/ (compiled): look in ../ui relative to this module. */
function uiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '..', 'ui'), join(here, 'ui')]) if (existsSync(join(c, 'index.html'))) return c;
  throw new Error('ui/ directory not found');
}

const STATIC: Record<string, string> = {
  '/app.js': 'application/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
};

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req, MAX_JSON);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function maskConfig(c: Config): Config {
  const copy = JSON.parse(JSON.stringify(c)) as Config;
  const ha = copy.integrations?.homeassistant;
  if (ha?.token) ha.token = MASK;
  return copy;
}

function unmaskConfig(next: Config, current: Config): Config {
  const ha = next.integrations?.homeassistant;
  if (ha && ha.token === MASK) {
    const old = current.integrations?.homeassistant?.token;
    if (old) ha.token = old;
    else delete ha.token;
  }
  return next;
}

export async function startServer(api: DaemonApi, opts: ServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u) => fetch(u) as any);
  const token = randomBytes(24).toString('hex');
  const dir = uiDir();
  let boundPort = 0;

  const tokenOk = (req: IncomingMessage): boolean => {
    const got = req.headers['x-smartdeck-token'];
    if (typeof got !== 'string' || got.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(got), Buffer.from(token));
  };

  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, obj: unknown) =>
    send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding defence: only our own host:port is acceptable.
    const hostHdr = req.headers.host ?? '';
    if (hostHdr !== `127.0.0.1:${boundPort}` && hostHdr !== `localhost:${boundPort}`)
      return json(res, 403, { error: 'bad host' });
    // CSRF defence: browsers send Origin on cross-origin and on same-origin non-GET requests.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${hostHdr}`) return json(res, 403, { error: 'bad origin' });

    const url = new URL(req.url ?? '/', `http://${hostHdr}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = readFileSync(join(dir, 'index.html'), 'utf8').replace('__CSRF_TOKEN__', token);
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (method === 'GET' && STATIC[path]) return send(res, 200, readFileSync(join(dir, path.slice(1))), STATIC[path]);

      if (method === 'GET' && path.startsWith('/icons/')) {
        const name = decodeURIComponent(path.slice('/icons/'.length));
        if (!ICON_FILE_RE.test(name)) return json(res, 400, { error: 'invalid icon name' });
        const f = join(api.iconsDir(), name);
        if (!existsSync(f)) return json(res, 404, { error: 'not found' });
        return send(res, 200, readFileSync(f), 'image/jpeg');
      }

      if (path.startsWith('/api/')) {
        const needsToken = method !== 'GET' || path === '/api/config';
        if (needsToken && !tokenOk(req)) return json(res, 403, { error: 'bad token' });

        if (method === 'GET' && path === '/api/config') return json(res, 200, maskConfig(api.getConfig()));
        if (method === 'PUT' && path === '/api/config') {
          const next = unmaskConfig((await readJson(req)) as Config, api.getConfig());
          try {
            api.setConfig(next);
          } catch (e) {
            return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
          return json(res, 200, maskConfig(api.getConfig()));
        }
        if (method === 'GET' && path === '/api/status') return json(res, 200, api.status());
        if (method === 'POST' && path === '/api/sync') {
          try {
            await api.sync();
          } catch (e) {
            return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
          }
          return json(res, 200, { ok: true });
        }
        if (method === 'POST' && path === '/api/test') {
          const body = await readJson(req);
          if (!body || typeof body.action !== 'object' || body.action === null || typeof body.action.type !== 'string')
            return json(res, 400, { error: 'action required' });
          try {
            await api.testAction(body.action);
          } catch (e) {
            return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return json(res, 200, { ok: true });
        }
        if (method === 'GET' && path === '/api/icons') return json(res, 200, listIcons(api.iconsDir()));
        if (method === 'POST' && path === '/api/icons/upload') {
          const name = url.searchParams.get('name') ?? '';
          const bgHex = url.searchParams.get('bg') ?? undefined;
          const data = await readBody(req, MAX_UPLOAD);
          if (!data.length) return json(res, 400, { error: 'empty upload' });
          let file: string;
          try {
            file = await saveIcon(api.iconsDir(), name, data, bgHex);
          } catch (e) {
            return json(res, 400, { error: e instanceof Error ? e.message : 'could not read image' });
          }
          api.iconsChanged();
          return json(res, 200, { name: file });
        }
        if (method === 'DELETE' && path.startsWith('/api/icons/')) {
          const name = decodeURIComponent(path.slice('/api/icons/'.length));
          if (!ICON_FILE_RE.test(name)) return json(res, 400, { error: 'invalid icon name' });
          const ok = deleteIcon(api.iconsDir(), name);
          if (ok) api.iconsChanged();
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
        }
        if (method === 'GET' && path === '/api/iconify/search') {
          try {
            return json(res, 200, await searchIconify(url.searchParams.get('q') ?? '', fetchImpl));
          } catch (e) {
            return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (method === 'POST' && path === '/api/icons/iconify') {
          const body = await readJson(req);
          try {
            const file = await saveIconifyIcon(
              api.iconsDir(),
              { id: String(body.id ?? ''), color: body.color, bg: body.bg, name: body.name },
              fetchImpl,
            );
            api.iconsChanged();
            return json(res, 200, { name: file });
          } catch (e) {
            return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7777, host, () => resolve());
  });
  const addr = server.address();
  boundPort = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    token,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
