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
