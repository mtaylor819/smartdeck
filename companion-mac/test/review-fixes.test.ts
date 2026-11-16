import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmd } from '../src/protocol.js';
import { defaultConfig, validate, Config } from '../src/config.js';
import { startServer } from '../src/server.js';

test('SET_BRIGHTNESS refuses NaN (the firmware would read it as 0 = black screen)', () => {
  assert.throws(() => cmd.setBrightness(NaN), /number/);
  assert.throws(() => cmd.setBrightness(undefined as any), /number/);
  assert.equal(cmd.setBrightness(80), 'SET_BRIGHTNESS:80');
  assert.equal(cmd.setBrightness(250), 'SET_BRIGHTNESS:100');
});

test('config validation rejects missing/invalid brightness', () => {
  for (const b of [undefined, null, NaN, -1, 101, '80'])
    assert.throws(() => validate({ ...defaultConfig(), brightness: b as any }), /brightness/);
  validate({ ...defaultConfig(), brightness: 0 }); // 0 is legitimate
});

function fakeApi(initial: Config) {
  let cfg = initial;
  const saved: Config[] = [];
  return {
    saved,
    api: {
      getConfig: () => cfg, setConfig: (n: Config) => { validate(n); cfg = n; saved.push(n); },
      status: () => ({ connected: false, page: 0, log: [], widgets: {} }),
      sync: async () => {}, testAction: async () => {}, iconsDir: () => '/nonexistent', iconsChanged() {},
    } as any,
  };
}

async function session(initial: Config) {
  const f = fakeApi(initial);
  const srv = await startServer(f.api, { port: 0 });
  const html = await (await fetch(srv.url)).text();
  const token = /name="csrf-token" content="([^"]+)"/.exec(html)![1];
  const put = (body: unknown) => fetch(srv.url.replace(/\/$/, '') + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-SmartDeck-Token': token }, body: JSON.stringify(body) });
  const get = async () => (await fetch(srv.url.replace(/\/$/, '') + '/api/config', { headers: { 'X-SmartDeck-Token': token } })).json() as Promise<Config>;
  return { ...f, srv, put, get };
}

test('server rejects "***abc" typed onto a masked placeholder, keeps real secrets on exact "***"', async () => {
  const c = defaultConfig();
  c.device = { wifi: { ssid: 'Home', password: 'real-wifi-pass' }, token: 'real-token-123', ha: { url: 'http://h', token: 'real-ha-token' } };
  c.integrations = { homeassistant: { url: 'http://h', token: 'real-int-token' } };
  const s = await session(c);
  try {
    const masked = await s.get();
    assert.equal(masked.device!.wifi!.password, '***');
    assert.ok(!JSON.stringify(masked).includes('real-wifi-pass'));
    // untouched round trip keeps the real values
    assert.equal((await s.put(masked)).status, 200);
    assert.equal(s.saved.at(-1)!.device!.wifi!.password, 'real-wifi-pass');
    assert.equal(s.saved.at(-1)!.integrations!.homeassistant!.token, 'real-int-token');
    // garbage typed after the placeholder is refused, nothing is saved
    const before = s.saved.length;
    for (const [path, val] of [['wifi.password', '***abc'], ['token', '***x'], ['ha.token', '***']] as const) {
      const bad: any = JSON.parse(JSON.stringify(masked));
      if (path === 'wifi.password') bad.device.wifi.password = val;
      else if (path === 'token') bad.device.token = val;
      else bad.integrations.homeassistant.token = '***tail';
      const r = await s.put(bad);
      assert.equal(r.status, 400, `${path} ${val}`);
      assert.match(((await r.json()) as any).error, /placeholder|\*\*\*/);
    }
    assert.equal(s.saved.length, before);
    // a genuinely new secret is accepted
    const ok: any = JSON.parse(JSON.stringify(masked)); ok.device.token = 'brand-new-token';
    assert.equal((await s.put(ok)).status, 200);
    assert.equal(s.saved.at(-1)!.device!.token, 'brand-new-token');
  } finally { await s.srv.close(); }
});

test('server returns a clear 400 for a config with no brightness', async () => {
  const s = await session(defaultConfig());
  try {
    const bad: any = JSON.parse(JSON.stringify(await s.get()));
    delete bad.brightness;
    const r = await s.put(bad);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /brightness/);
  } finally { await s.srv.close(); }
});

import { Deck } from '../src/deck.js';
import { ActionExecutor } from '../src/actions.js';
import { FakeTransport, tick } from './helpers.js';
import { parseLine, sanitizeNetStatus } from '../src/protocol.js';
import { toDeviceButton } from '../src/config.js';
import { renderWidget } from '../src/widgets.js';
import { TcpTransport } from '../src/transport.js';

const mkDeck = (t: FakeTransport) => new Deck(t, defaultConfig(), new ActionExecutor(async () => {}), () => {});

test('Deck.send refuses lines with newlines, and anything while an upload is running', async () => {
  const t = new FakeTransport((d, self) => {
    const l = String(d).trim();
    if (l === 'START_UPLOAD') self.deck('READY');
    if (l.startsWith('FILE:')) self.deck('OK_FILE');
    if (l === 'END_UPLOAD') self.deck('DONE_REBOOT');
    if (!l.startsWith('FILE:') && !['START_UPLOAD', 'END_UPLOAD'].includes(l) && typeof d !== 'string') self.deck('OK_DATA');
  });
  const d = mkDeck(t);
  await assert.rejects(d.send('SET_PAGE:1\nSET_NET:{"x":1}'), /newline/);
  const up = d.upload([{ name: 'a.jpg', data: Buffer.from('xyz') }]);
  await assert.rejects(d.send('HB'), /upload in progress/);   // would otherwise land inside the file
  await assert.rejects(d.upload([]), /already in progress/);  // no interleaved uploads
  await up;
  await d.send('HB'); // fine again afterwards
  assert.ok(!t.lines().some((l) => l === 'HB' && t.lines().indexOf(l) < t.lines().indexOf('END_UPLOAD')));
});

test('a link that drops mid-upload rejects cleanly: no unhandled rejection from orphaned waiters', async () => {
  const unhandled: unknown[] = [];
  const h = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', h);
  try {
    const t = new FakeTransport((d, self) => { if (String(d).trim() === 'START_UPLOAD') self.deck('READY'); if (String(d).startsWith('FILE:')) setTimeout(() => self.emit('close'), 5); });
    const d = mkDeck(t);
    await assert.rejects(d.upload([{ name: 'a.jpg', data: Buffer.from('x') }]), /link closed|timed out/);
    await tick(80);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', h); }
});

test('NET_STATUS from the network is sanitised (wrong types cannot crash the daemon)', () => {
  const ev: any = parseLine('NET_STATUS:{"caps":5,"ble_slots":"x","wifi":"hax","rssi":"loud","fw":"v\\u0007' + 'x'.repeat(100) + '","ble":"connected"}');
  assert.equal(ev.type, 'netStatus');
  assert.deepEqual(Object.keys(ev.status).sort(), ['ble', 'fw']);
  assert.equal(ev.status.fw.length, 40);
  assert.ok(!/[\x00-\x1f]/.test(ev.status.fw));
  assert.deepEqual(sanitizeNetStatus({ caps: ['btn_live', 3, 'ha_state'] }).caps, ['btn_live', 'ha_state']);
  assert.deepEqual(sanitizeNetStatus(null), {});
});

test('http headers (Authorization) are not copied into the device JSON', () => {
  const j: any = toDeviceButton({ action: { type: 'http', url: 'http://x', method: 'POST', body: 'b', headers: { Authorization: 'Bearer s3cret' } } });
  assert.deepEqual(j.http, { url: 'http://x', method: 'POST', body: 'b' });
  assert.ok(!JSON.stringify(j).includes('s3cret'));
});

test('widget format treats $& and $1 in values literally', () => {
  assert.equal(renderWidget({ source: 'cpu', format: 'v={value}' }, '$&$1').label, 'v=$&$1');
});

test('an early socket error with no listener does not crash the process', async () => {
  // connect to a closed port: rejects (handled) and must not throw an uncaught 'error' event
  await assert.rejects(TcpTransport.connect('127.0.0.1:1', 'tok-12345678', 800));
});
