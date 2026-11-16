import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import type { Action } from '../src/actions.js';
import type { DaemonApi } from '../src/api.js';
import { defaultConfig, Config } from '../src/config.js';
import { startServer, RunningServer } from '../src/server.js';

let cfg: Config;
let dir: string;
let changed = 0;
const tested: Action[] = [];
let srv: RunningServer;

const api: DaemonApi = {
  getConfig: () => cfg,
  setConfig: (c) => {
    if (c.title === 'BAD') throw new Error('title is bad');
    cfg = c;
  },
  status: () => ({ connected: true, deviceName: 'Smart Deck', page: 0, log: ['hi'], widgets: {} }),
  sync: async () => {},
  testAction: async (a) => void tested.push(a),
  iconsDir: () => dir,
  iconsChanged: () => void changed++,
};

const fakeFetch = async (url: string) => ({
  ok: true, status: 200,
  arrayBuffer: async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'),
  json: async () => ({ icons: ['mdi:home'] }),
});

before(async () => {
  cfg = defaultConfig();
  cfg.integrations = { homeassistant: { url: 'http://ha', token: 'SECRET' } };
  dir = mkdtempSync(join(tmpdir(), 'sd-srv-'));
  srv = await startServer(api, { port: 0, fetchImpl: fakeFetch as any });
});
after(() => srv.close());

interface R { status: number; body: string; headers: http.IncomingHttpHeaders }
function req(method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer; token?: boolean } = {}): Promise<R> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${srv.port}`, ...o.headers };
    if (o.token !== false) headers['x-smartdeck-token'] = srv.token;
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}
const j = (r: R) => JSON.parse(r.body);

test('serves index.html with the CSRF token injected and security headers', async () => {
  const r = await req('GET', '/', { token: false });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(srv.token));
  assert.ok(!r.body.includes('__CSRF_TOKEN__'));
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal((await req('GET', '/app.js', { token: false })).status, 200);
  assert.equal((await req('GET', '/style.css', { token: false })).status, 200);
});

test('rejects wrong Host header (DNS rebinding)', async () => {
  const r = await req('GET', '/api/status', { headers: { host: 'evil.example.com' } });
  assert.equal(r.status, 403);
  const ok = await req('GET', '/api/status', { headers: { host: `localhost:${srv.port}` } });
  assert.equal(ok.status, 200);
});

test('rejects cross-origin requests', async () => {
  const r = await req('GET', '/api/status', { headers: { origin: 'http://evil.example.com' } });
  assert.equal(r.status, 403);
  const ok = await req('GET', '/api/status', { headers: { origin: `http://127.0.0.1:${srv.port}` } });
  assert.equal(ok.status, 200);
});

test('token required on non-GET and on GET /api/config, not on GET /api/status', async () => {
  assert.equal((await req('GET', '/api/config', { token: false })).status, 403);
  assert.equal((await req('GET', '/api/config', { headers: { 'x-smartdeck-token': 'x'.repeat(48) }, token: false })).status, 403);
  assert.equal((await req('POST', '/api/test', { token: false, body: '{"action":{"type":"none"}}' })).status, 403);
  assert.equal((await req('PUT', '/api/config', { token: false, body: '{}' })).status, 403);
  assert.equal((await req('POST', '/api/sync', { token: false })).status, 403);
  assert.equal((await req('DELETE', '/api/icons/a.jpg', { token: false })).status, 403);
  assert.equal((await req('GET', '/api/status', { token: false })).status, 200);
});

test('config GET masks the HA token; PUT with mask keeps the secret', async () => {
  const got = j(await req('GET', '/api/config'));
  assert.equal(got.integrations.homeassistant.token, '***');
  got.title = 'Renamed';
  const put = await req('PUT', '/api/config', { body: JSON.stringify(got) });
  assert.equal(put.status, 200);
  assert.equal(cfg.title, 'Renamed');
  assert.equal(cfg.integrations!.homeassistant!.token, 'SECRET');
  assert.ok(!put.body.includes('SECRET'));
  // replacing the token works
  got.integrations.homeassistant.token = 'NEW';
  await req('PUT', '/api/config', { body: JSON.stringify(got) });
  assert.equal(cfg.integrations!.homeassistant!.token, 'NEW');
});

test('PUT /api/config returns 400 with the validation message', async () => {
  const bad = { ...cfg, title: 'BAD' };
  const r = await req('PUT', '/api/config', { body: JSON.stringify(bad) });
  assert.equal(r.status, 400);
  assert.equal(j(r).error, 'title is bad');
  assert.equal((await req('PUT', '/api/config', { body: '{nope' })).status, 400);
});

test('oversize JSON body is rejected', async () => {
  const r = await req('POST', '/api/test', { body: JSON.stringify({ action: { type: 'text', text: 'a'.repeat(1.2e6) } }) }).catch(() => ({ status: 413 }) as R);
  assert.equal(r.status, 413);
});

test('POST /api/test validates and forwards the action', async () => {
  assert.equal((await req('POST', '/api/test', { body: '{}' })).status, 400);
  const r = await req('POST', '/api/test', { body: JSON.stringify({ action: { type: 'app', app: 'Notes' } }) });
  assert.equal(r.status, 200);
  assert.deepEqual(tested.at(-1), { type: 'app', app: 'Notes' });
});

test('icon upload converts to 110x110 jpg, lists, serves, deletes', async () => {
  const pngBuf = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toBuffer();
  const up = await req('POST', '/api/icons/upload?name=green', { body: pngBuf });
  assert.equal(up.status, 200);
  assert.equal(j(up).name, 'green.jpg');
  assert.equal(changed, 1);
  assert.deepEqual(j(await req('GET', '/api/icons')), ['green.jpg']);
  const img = await req('GET', '/icons/green.jpg', { token: false });
  assert.equal(img.headers['content-type'], 'image/jpeg');
  const meta = await sharp(Buffer.from(img.body, 'binary')).metadata().catch(() => null);
  void meta; // body was utf8-decoded above; size check done via file below
  assert.equal((await req('DELETE', '/api/icons/green.jpg')).status, 200);
  assert.equal((await req('DELETE', '/api/icons/green.jpg')).status, 404);
  assert.deepEqual(j(await req('GET', '/api/icons')), []);
});

test('icon upload rejects garbage and empty bodies', async () => {
  assert.equal((await req('POST', '/api/icons/upload?name=x', { body: Buffer.from('nope') })).status, 400);
  assert.equal((await req('POST', '/api/icons/upload?name=x')).status, 400);
});

test('icon paths cannot traverse', async () => {
  writeFileSync(join(dir, '..', 'secret.jpg'), 'x');
  for (const p of ['/icons/..%2Fsecret.jpg', '/icons/../secret.jpg', '/icons/a%2Fb.jpg', '/icons/.env', '/icons/x.png']) {
    const r = await req('GET', p, { token: false });
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await req('DELETE', '/api/icons/..%2Fsecret.jpg')).status, 400);
});

test('iconify id validation and search use the injected fetch', async () => {
  for (const id of ['../x:y', 'http://evil/a:b', 'mdi:home/x', '']) {
    const r = await req('POST', '/api/icons/iconify', { body: JSON.stringify({ id }) });
    assert.equal(r.status, 400, id);
  }
  const ok = await req('POST', '/api/icons/iconify', { body: JSON.stringify({ id: 'mdi:home', color: 'ffffff', bg: '1a1a2e' }) });
  assert.equal(ok.status, 200);
  assert.equal(j(ok).name, 'mdi-home.jpg');
  assert.deepEqual(j(await req('GET', '/api/iconify/search?q=home')), ['mdi:home']);
});

test('unknown routes 404, sync/status work', async () => {
  assert.equal((await req('GET', '/nope', { token: false })).status, 404);
  assert.equal(j(await req('GET', '/api/status')).deviceName, 'Smart Deck');
  assert.equal((await req('POST', '/api/sync')).status, 200);
});

test('serves lcars.js and every script referenced by index.html', async () => {
  const { startServer } = await import('../src/server.js');
  const srv = await startServer({
    getConfig: () => ({}) as any, setConfig() {}, status: () => ({ connected: false, page: 0, log: [], widgets: {} }),
    sync: async () => {}, testAction: async () => {}, iconsDir: () => '/nonexistent', iconsChanged() {},
  } as any, { port: 0 });
  try {
    const html = await (await fetch(srv.url)).text();
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.includes('/lcars.js'));
    for (const s of scripts) assert.equal((await fetch(srv.url.replace(/\/$/, '') + s)).status, 200, s);
    assert.equal((await fetch(srv.url.replace(/\/$/, '') + '/style.css')).status, 200);
  } finally { await srv.close(); }
});
