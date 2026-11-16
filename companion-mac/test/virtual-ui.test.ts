import { handshake } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startVirtualDeck } from '../src/virtual/index.js';

const CONFIG = { title: 'UI Deck', grid: { cols: 3, rows: 2 }, pages: [{ name: 'P1', buttons: [{ label: 'A', type: 'key', combo: 'cmd+c' }, { label: 'Go', type: 'goto', page: 2 }] }, { name: 'P2', buttons: [] }] };

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), 'vui-'));
  writeFileSync(join(dataDir, 'esp_config.json'), JSON.stringify(CONFIG));
  writeFileSync(join(dataDir, 'ok.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const v = await startVirtualDeck({ port: 0, uiPort: 0, token: 'ui-test-token', dataDir });
  return v;
}

/** Raw http request so we can set arbitrary Host/Origin headers. */
function req(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    r.end();
  });
}

test('UI: index is served with the CSRF token, strict CSP, and every referenced script/style loads', async () => {
  const v = await start();
  try {
    const r = await req(v.uiUrl);
    assert.equal(r.status, 200);
    assert.match(r.body, new RegExp(`name="csrf-token" content="${v.uiToken}"`));
    assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    for (const m of r.body.matchAll(/(?:src|href)="(\/[^"]+)"/g)) assert.equal((await req(v.uiUrl.replace(/\/$/, '') + m[1])).status, 200, m[1]);
  } finally { await v.close(); }
});

test('UI: Host header (DNS rebinding) and cross-origin requests are rejected', async () => {
  const v = await start();
  try {
    const port = new URL(v.uiUrl).port;
    assert.equal((await req(v.uiUrl, { headers: { Host: 'evil.example.com' } })).status, 403);
    assert.equal((await req(v.uiUrl + 'api/state', { headers: { Host: `evil.example.com:${port}` } })).status, 403);
    assert.equal((await req(v.uiUrl + 'api/state', { headers: { Origin: 'http://evil.example.com' } })).status, 403);
    assert.equal((await req(v.uiUrl + 'api/state', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  } finally { await v.close(); }
});

test('UI: every POST needs the CSRF token; bad bodies are 400', async () => {
  const v = await start();
  try {
    const post = (path: string, body: unknown, token?: string) =>
      req(v.uiUrl + path.slice(1), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-SmartDeck-Token': token } : {}) }, body });
    assert.equal((await post('/api/touch', { index: 0 })).status, 403);
    assert.equal((await post('/api/touch', { index: 0 }, 'wrong')).status, 403);
    assert.equal((await post('/api/ack', {})).status, 403);
    assert.equal((await post('/api/touch', { index: 0 }, v.uiToken)).status, 200);
    assert.equal((await post('/api/touch', { index: 'x' }, v.uiToken)).status, 400);
    assert.equal((await post('/api/knob', { raw: 99999 }, v.uiToken)).status, 400);
    assert.equal((await post('/api/lux', { lux: -1 }, v.uiToken)).status, 400);
    assert.equal((await req(v.uiUrl + 'api/touch', { method: 'POST', headers: { 'X-SmartDeck-Token': v.uiToken }, body: '{bad' })).status, 400);
    assert.equal((await post('/api/nope', {}, v.uiToken)).status, 404);
  } finally { await v.close(); }
});

test('UI: icon route serves JPGs from the SD dir and rejects traversal / non-jpg names', async () => {
  const v = await start();
  try {
    const ok = await req(v.uiUrl + 'icons/ok.jpg');
    assert.equal(ok.status, 200); assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal((await req(v.uiUrl + 'icons/missing.jpg')).status, 404);
    assert.equal((await req(v.uiUrl + 'icons/..%2Fesp_config.json')).status, 400);
    assert.equal((await req(v.uiUrl + 'icons/esp_config.json')).status, 400);
    assert.equal((await req(v.uiUrl + 'icons/..%2F..%2Fetc%2Fpasswd.jpg')).status, 400);
  } finally { await v.close(); }
});

test('UI: /api/state exposes the deck and never any secrets', async () => {
  const v = await start();
  try {
    v.deck.feed(Buffer.from('SET_NET:{"ssid":"Net","pass":"wifi-secret-pw","token":"tok-secret-1234","ha_token":"ha-secret-token"}\n'));
    const r = await req(v.uiUrl + 'api/state');
    const s = JSON.parse(r.body);
    assert.equal(s.config.title, 'UI Deck'); assert.equal(s.net.hasPass, true); assert.equal(s.net.ssid, 'Net');
    for (const secret of ['wifi-secret-pw', 'tok-secret-1234', 'ha-secret-token']) assert.ok(!r.body.includes(secret), secret);
  } finally { await v.close(); }
});

test('UI hooks drive the deck: touch -> BTN to the TCP host, swipe changes page, goto button, wake', async () => {
  const v = await start();
  try {
    const sock = createConnection({ port: v.tcpPort, host: '127.0.0.1' });
    const lines: string[] = [];
    sock.on('data', (d) => lines.push(...d.toString().split('\n').map((l) => l.trim()).filter(Boolean)));
    await handshake(sock, 'ui-test-token', 'HB\n');
    await new Promise((r) => setTimeout(r, 100));
    const post = (path: string, body: unknown) => req(v.uiUrl + path.slice(1), { method: 'POST', headers: { 'X-SmartDeck-Token': v.uiToken }, body });
    await post('/api/touch', { index: 0 });
    await post('/api/touch', { index: 1 }); // goto page 2
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(lines.includes('BTN:0:0'), JSON.stringify(lines));
    assert.ok(lines.includes('PAGE_CHANGED:1'));
    const sw = JSON.parse((await post('/api/swipe', { dx: 250, dy: 5, ms: 200 })).body);
    assert.deepEqual(sw, { recognized: true, changed: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(lines.includes('PAGE_CHANGED:0'));
    assert.equal(v.state.page, 0);
    sock.destroy();
  } finally { await v.close(); }
});

test('UI: "Sleep now" dims the deck, DIAG leaves it asleep, touch wakes it without pressing a button', async () => {
  const v = await start();
  try {
    const post = (path: string, body: unknown = {}) => req(v.uiUrl + path.slice(1), { method: 'POST', headers: { 'X-SmartDeck-Token': v.uiToken }, body });
    await post('/api/sleep');
    assert.equal(v.state.sleep.sleeping, true);
    v.deck.feed(Buffer.from('DIAG:1:2:3:4:5:6:h\n'));
    assert.equal(v.state.sleep.sleeping, true);
    const r = JSON.parse((await post('/api/touch', { index: 0 })).body);
    assert.deepEqual(r, { action: 'swallowed' });
    assert.equal(v.state.sleep.sleeping, false);
  } finally { await v.close(); }
});

test('ALERT end-to-end: host sends ALERT over TCP, UI acknowledges via /api/ack, host receives ALERT_ACK', async () => {
  const v = await start();
  try {
    const sock = createConnection({ port: v.tcpPort, host: '127.0.0.1' });
    const lines: string[] = [];
    sock.on('data', (d) => lines.push(...d.toString().split('\n').map((l) => l.trim()).filter(Boolean)));
    await handshake(sock, 'ui-test-token', 'ALERT:red:30:PRINT FAILED\n');
    await new Promise((r) => setTimeout(r, 100));
    let s = JSON.parse((await req(v.uiUrl + 'api/state')).body);
    assert.equal(s.alert.kind, 'red'); assert.equal(s.alert.text, 'PRINT FAILED');
    const ack = await req(v.uiUrl + 'api/ack', { method: 'POST', headers: { 'X-SmartDeck-Token': v.uiToken }, body: {} });
    assert.deepEqual(JSON.parse(ack.body), { acked: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(lines.includes('ALERT_ACK:red'), JSON.stringify(lines));
    s = JSON.parse((await req(v.uiUrl + 'api/state')).body);
    assert.equal(s.alert, null);
    assert.deepEqual(JSON.parse((await req(v.uiUrl + 'api/ack', { method: 'POST', headers: { 'X-SmartDeck-Token': v.uiToken }, body: {} })).body), { acked: false });
    sock.destroy();
  } finally { await v.close(); }
});
