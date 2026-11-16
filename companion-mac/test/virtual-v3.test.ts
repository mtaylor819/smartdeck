import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createConnection, Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeckEmulator } from '../src/virtual/emulator.js';
import { startVirtualDeck } from '../src/virtual/index.js';

// ---------------------------------------------------------------- helpers
const tmp = () => mkdtempSync(join(tmpdir(), 'vdeck-v3-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HA_TOKEN = 'ha-secret-token-XYZ-123';

async function waitFor(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

const THEME = { bg_color: '000000', btn_color: '333333', text_color: 'ffffff', stroke_color: '555555', shadow_color: '000000' };
const HA_ST = { entity: 'light.desk', on: '1a8f3c', off: '333333', label_on: 'ON', label_off: 'OFF', interval: 10 };

const CONFIG = {
  title: 'V3', grid: { cols: 3, rows: 2 }, theme: THEME,
  pages: [
    {
      name: 'Main',
      buttons: [
        { label: 'Desk', type: 'ha', ha: { service: 'light.toggle', entity: 'light.desk', data: { brightness: 90 } }, ha_state: HA_ST },
        { label: 'Fan', type: 'ha', ha: { service: 'switch.toggle', entity: 'switch.fan' }, ha_state: { entity: 'switch.fan', on: '00aa00' } },
        { label: 'Key', type: 'key', combo: 'cmd+c' },
        { label: 'BT2', type: 'blehost', slot: 2 },
        { label: 'BTn', type: 'blehost', slot: 'next' },
        { label: 'BT9', type: 'blehost', slot: 9 },
      ],
    },
    { name: 'Two', buttons: [{ label: 'Other', type: 'ha', ha_state: { entity: 'sensor.other' } }] },
  ],
};

function emu(opts: Record<string, unknown> = {}, config: unknown = CONFIG) {
  const clock = { t: 1_000_000 };
  const out: string[] = [];
  const dir = tmp();
  writeFileSync(join(dir, 'esp_config.json'), JSON.stringify(config));
  const deck = new DeckEmulator({ dataDir: dir, now: () => clock.t, token: 'tok-12345678', haRepollMs: 15, haTimeoutMs: 500, ...opts });
  deck.on('out', (d: string) => out.push(...d.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '')));
  const send = (...lines: string[]) => deck.feed(Buffer.from(lines.map((l) => l + '\n').join('')));
  return { deck, out, clock, dir, send, take: () => out.splice(0, out.length) };
}

interface Req { method: string; url: string; auth?: string; body: string; headers: IncomingMessage['headers'] }
/** Mock Home Assistant. `states` maps entity -> state; unknown entities 404; 'sensor.hang' never answers. */
async function mockHa(states: Record<string, string> = {}, delayMs = 0) {
  const requests: Req[] = [];
  let inflight = 0, maxInflight = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString(), headers: req.headers });
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      if (delayMs) await sleep(delayMs);
      inflight--;
      const m = /^\/api\/states\/(.+)$/.exec(req.url ?? '');
      if (m) {
        const ent = decodeURIComponent(m[1]);
        if (ent === 'sensor.hang') return; // never answers
        if (ent === 'sensor.garbage') { res.writeHead(200); return res.end('not json'); }
        if (!(ent in states)) { res.writeHead(404); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ entity_id: ent, state: states[ent] }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port, url: `http://127.0.0.1:${port}`, requests, states,
    max: () => maxInflight,
    gets: (ent?: string) => requests.filter((r) => r.method === 'GET' && (!ent || r.url === `/api/states/${ent}`)),
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

/** Provision WiFi + HA like the Mac app does over USB. */
function provision(l: ReturnType<typeof emu>, ha: { url: string }, extra: Record<string, unknown> = {}) {
  l.send(`SET_NET:${JSON.stringify({ ssid: 'HomeNet', ha_url: ha.url, ha_token: HA_TOKEN, ...extra })}`);
  assert.equal(l.take()[0], 'NET_SET:ok');
  // SET_NET is a host line, so the host counts as present for 15 s; let that lapse like a Mac that stopped talking
  l.clock.t += 16_000;
}

const status = (line: string) => JSON.parse(line.slice('NET_STATUS:'.length));
const netStatus = (l: ReturnType<typeof emu>) => { l.clock.t += 5000; l.send('GET_NET'); return status(l.take().find((x) => x.startsWith('NET_STATUS:'))!); };

// ---------------------------------------------------------------- caps / NET_STATUS
test('NET_STATUS carries caps, ble_slot and ble_slots, and still no secrets', () => {
  const l = emu();
  l.send(`SET_NET:${JSON.stringify({ ssid: 'Net', pass: 'wifi-pass-123', token: 'link-token-999', ha_url: 'http://ha.local:8123', ha_token: HA_TOKEN })}`);
  const first = l.take();
  l.send('GET_NET');
  const lines = l.take();
  const st = status(lines[0]);
  assert.deepEqual(st.caps, ['btn_live', 'ha_state', 'ble_hosts']);
  assert.equal(st.ble_slot, 1);
  assert.deepEqual(st.ble_slots, ['Host 1', 'Host 2', 'Host 3']);
  const all = JSON.stringify([first, lines, l.deck.state, l.deck.snapshot(), l.deck.state.log]);
  for (const secret of ['wifi-pass-123', 'link-token-999', HA_TOKEN]) assert.ok(!all.includes(secret), `leaked ${secret}`);
});

// ---------------------------------------------------------------- SET_BTN_LIVE
test('SET_BTN_LIVE: stores a normalised override, sends no reply, counts as host presence', () => {
  const l = emu();
  l.send('SET_BTN_LIVE:0:1:{"label":"CPU 42%","btnColor":"FF0000","labelColor":"FFFFFF","labelSize":20,"icon":"cpu.jpg"}');
  assert.deepEqual(l.take(), [], 'no serial spam');
  assert.deepEqual(l.deck.state.live['0:1'], { label: 'CPU 42%', btnColor: 'ff0000', labelColor: 'ffffff', labelSize: 20, icon: 'cpu.jpg' });
  assert.equal(l.deck.hostActive(), true);
});

test('SET_BTN_LIVE: RAM only. The SD config, DUMP_CONFIG and prefs never see it', () => {
  const l = emu();
  const before = readFileSync(join(l.dir, 'esp_config.json'), 'utf8');
  l.send('DUMP_CONFIG'); const dumpBefore = l.take();
  l.send('SET_BTN_LIVE:0:0:{"label":"LIVE-ONLY-LABEL","btnColor":"123456"}');
  l.send('SET_BRIGHTNESS:50'); l.take(); // forces a prefs write after the live update
  assert.equal(readFileSync(join(l.dir, 'esp_config.json'), 'utf8'), before);
  l.send('DUMP_CONFIG');
  assert.deepEqual(l.take(), dumpBefore);
  assert.ok(!readFileSync(join(l.dir, 'prefs.json'), 'utf8').includes('LIVE-ONLY-LABEL'));
  assert.equal(l.deck.state.config.pages[0].buttons[0]!.label, 'Desk', 'stored config untouched');
});

test('SET_BTN_LIVE never wakes a sleeping deck; overrides survive page changes and wake', () => {
  const l = emu();
  l.send('SET_SLEEP:1'); l.take();
  l.clock.t += 61_000; l.deck.tick();
  assert.equal(l.deck.state.sleep.sleeping, true);
  l.send('SET_BTN_LIVE:0:2:{"label":"zzz"}');
  assert.equal(l.deck.state.sleep.sleeping, true, 'still asleep');
  assert.equal(l.deck.state.live['0:2'].label, 'zzz', 'applied at next draw');
  l.deck.touchWake();
  assert.equal(l.deck.state.sleep.sleeping, false);
  assert.equal(l.deck.state.live['0:2'].label, 'zzz', 'survives wake');
  l.send('SET_PAGE:1'); l.send('SET_PAGE:0'); l.take();
  assert.equal(l.deck.state.live['0:2'].label, 'zzz', 'survives page changes');
});

test('SET_BTN_LIVE: lost on reboot', async () => {
  const l = emu({ rebootDelayMs: 5, bootMs: 20 });
  l.send('SET_BTN_LIVE:0:0:{"label":"temp"}');
  assert.ok(l.deck.state.live['0:0']);
  l.deck.reboot();
  await waitFor(() => l.deck.state.rebooting);
  await waitFor(() => !l.deck.state.rebooting);
  assert.deepEqual(l.deck.state.live, {});
});

test('SET_BTN_LIVE: later updates merge keys; the table drops the oldest entry when full', () => {
  const l = emu({ liveCapacity: 3 });
  l.send('SET_BTN_LIVE:0:0:{"label":"a"}', 'SET_BTN_LIVE:0:0:{"btnColor":"112233"}');
  assert.deepEqual(l.deck.state.live['0:0'], { label: 'a', btnColor: '112233' });
  l.send('SET_BTN_LIVE:0:1:{"label":"b"}', 'SET_BTN_LIVE:0:2:{"label":"c"}');
  l.send('SET_BTN_LIVE:0:0:{"label":"a2"}'); // refreshes 0:0 (now the newest)
  l.send('SET_BTN_LIVE:0:3:{"label":"d"}'); // table full -> 0:1 (oldest) goes
  assert.deepEqual(Object.keys(l.deck.state.live).sort(), ['0:0', '0:2', '0:3']);
  assert.equal(l.deck.state.live['0:0'].label, 'a2');
});

test('SET_BTN_LIVE: default capacity is at least 24 buttons', () => {
  const l = emu({}, { ...CONFIG, grid: { cols: 6, rows: 3 } });
  for (let i = 0; i < 18; i++) l.send(`SET_BTN_LIVE:0:${i}:{"label":"p0b${i}"}`);
  for (let i = 0; i < 12; i++) l.send(`SET_BTN_LIVE:1:${i}:{"label":"p1b${i}"}`);
  assert.equal(Object.keys(l.deck.state.live).length, 30);
});

test('SET_BTN_LIVE: invalid input is rejected whole (atomic), silently on the wire, noted in the deck log', () => {
  const bad = [
    '0:0:{"label":"' + 'x'.repeat(25) + '"}', '0:0:{"btnColor":"red"}', '0:0:{"btnColor":"12345"}', '0:0:{"labelColor":"#ff0000"}',
    '0:0:{"labelSize":7}', '0:0:{"labelSize":41}', '0:0:{"labelSize":12.5}', '0:0:{"labelSize":"12"}',
    '0:0:{"icon":"../x.jpg"}', '0:0:{"icon":".hidden"}', '0:0:{"icon":"a/b.jpg"}', '0:0:{"label":5}',
    '9:0:{"label":"x"}', '-1:0:{"label":"x"}', '0:6:{"label":"x"}', '0:-1:{"label":"x"}', '0:x:{"label":"x"}',
    '0:0:{nope', '0:0:[1,2]', '0:0:"str"', '0:0:null', '0:0', '0:0:{"label":"ok","btnColor":"nothex"}', // valid label must not slip through
    '0:0:{"label":"' + 'y'.repeat(600) + '"}',
  ];
  for (const b of bad) {
    const l = emu();
    l.send(`SET_BTN_LIVE:${b}`);
    assert.deepEqual(l.take(), [], `no reply for ${b.slice(0, 40)}`);
    assert.deepEqual(l.deck.state.live, {}, `nothing stored for ${b.slice(0, 40)}`);
    assert.match(l.deck.state.log.at(-1)!, /SET_BTN_LIVE rejected/, b.slice(0, 40));
  }
  const l = emu();
  l.send('SET_BTN_LIVE:0:0:{"label":"x","bogus":1}');
  assert.deepEqual(l.deck.state.live['0:0'], { label: 'x' }, 'unknown keys are ignored');
  l.send('SET_BTN_LIVE:0:5:{}');
  assert.equal(l.deck.state.live['0:5'], undefined, 'empty object stores nothing');
});

// ---------------------------------------------------------------- on-deck Home Assistant state
test('ha_state: polls with Bearer auth, applies on/off/unavailable styling through the live table', async () => {
  const ha = await mockHa({ 'light.desk': 'on', 'switch.fan': 'off' });
  const l = emu();
  try {
    provision(l, ha);
    l.deck.tick(); await l.deck.idle();
    assert.equal(ha.requests.length, 2);
    assert.ok(ha.requests.every((r) => r.method === 'GET' && r.auth === `Bearer ${HA_TOKEN}`));
    assert.deepEqual(ha.requests.map((r) => r.url), ['/api/states/light.desk', '/api/states/switch.fan']);
    assert.deepEqual(l.deck.state.live['0:0'], { btnColor: '1a8f3c', label: 'ON' });
    assert.equal(l.deck.state.live['0:1'], undefined, 'fan is off but has no off colour/label: keeps its own look');
    assert.equal(l.deck.state.haState['light.desk'].state, 'on');

    ha.states['light.desk'] = 'off'; ha.states['switch.fan'] = 'on';
    l.clock.t += 10_001; l.deck.tick(); await l.deck.idle();
    assert.deepEqual(l.deck.state.live['0:0'], { btnColor: '333333', label: 'OFF' });
    assert.deepEqual(l.deck.state.live['0:1'], { btnColor: '00aa00' }, 'on colour set, label never overridden');

    ha.states['switch.fan'] = 'off'; // back to "off" with no colour: the earlier override must go away
    l.clock.t += 10_001; l.deck.tick(); await l.deck.idle();
    assert.equal(l.deck.state.live['0:1'], undefined);

    delete ha.states['light.desk']; // 404 -> unavailable
    l.clock.t += 10_001; l.deck.tick(); await l.deck.idle();
    assert.deepEqual(l.deck.state.live['0:0'], { btnColor: '3a3a3a', label: '?' });
  } finally { await ha.close(); }
});

test('ha_state: interval rules (default 10 s, minimum 5 s) and no re-poll before they elapse', async () => {
  const ha = await mockHa({ 'light.desk': 'on', 'switch.fan': 'on' });
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.pages[0].buttons[0].ha_state.interval = 1; // below the minimum -> 5 s
  delete cfg.pages[0].buttons[1].ha_state.interval; // default -> 10 s
  const l = emu({}, cfg);
  try {
    provision(l, ha);
    l.deck.tick(); await l.deck.idle();
    assert.equal(ha.gets('light.desk').length, 1);
    l.clock.t += 4_000; l.deck.tick(); await l.deck.idle();
    assert.equal(ha.gets('light.desk').length, 1, 'not yet (4 s < 5 s)');
    l.clock.t += 1_001; l.deck.tick(); await l.deck.idle();
    assert.equal(ha.gets('light.desk').length, 2, 'due after 5 s');
    assert.equal(ha.gets('switch.fan').length, 1, 'default interval is 10 s, so not due yet');
    l.clock.t += 5_000; l.deck.tick(); await l.deck.idle();
    assert.equal(ha.gets('switch.fan').length, 2);
  } finally { await ha.close(); }
});

test('ha_state: at most 8 buttons, one request at a time, current page only (new page polls immediately)', async () => {
  const many = { ...CONFIG, grid: { cols: 4, rows: 3 }, pages: [
    { name: 'Many', buttons: Array.from({ length: 10 }, (_, i) => ({ label: `E${i}`, type: 'ha', ha_state: { entity: `light.e${i}` } })) },
    CONFIG.pages[1],
  ] };
  const ha = await mockHa(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`light.e${i}`, 'on'])), 10);
  ha.states['sensor.other'] = 'off';
  const l = emu({}, many);
  try {
    provision(l, ha);
    l.deck.tick(); await l.deck.idle();
    assert.equal(ha.gets().length, 8, 'capped at 8');
    assert.equal(ha.max(), 1, 'sequential, never concurrent');
    assert.equal(ha.gets('light.e9').length, 0);
    ha.requests.length = 0;
    l.send('SET_PAGE:1'); l.take();
    l.clock.t += 16_000; // SET_PAGE is a host line; let the host presence lapse again
    l.deck.tick(); await l.deck.idle();
    assert.deepEqual(ha.requests.map((r) => r.url), ['/api/states/sensor.other'], 'only the new page, polled right away');
  } finally { await ha.close(); }
});

test('ha_state: bad entity ids are never requested (no path injection)', async () => {
  const cfg = { ...CONFIG, pages: [{ name: 'Bad', buttons: ['../../etc/passwd', 'light', 'Light.Desk', 'light.a b', ''].map((e) => ({ type: 'ha', ha_state: { entity: e } })) }] };
  const ha = await mockHa();
  const l = emu({}, cfg);
  try {
    provision(l, ha);
    l.deck.tick(); await l.deck.idle();
    assert.equal(ha.requests.length, 0);
  } finally { await ha.close(); }
});

test('ha_state: only polls while eligible (awake, WiFi up, HA configured, no host unless standalone=always)', async () => {
  const ha = await mockHa({ 'light.desk': 'on', 'switch.fan': 'on' });
  try {
    // no WiFi (no ssid) -> nothing
    let l = emu();
    l.send(`SET_NET:${JSON.stringify({ ha_url: ha.url, ha_token: HA_TOKEN })}`); l.take();
    l.deck.tick(); await l.deck.idle();
    // WiFi but no token
    l = emu();
    l.send(`SET_NET:${JSON.stringify({ ssid: 'Net', ha_url: ha.url })}`); l.take();
    l.deck.tick(); await l.deck.idle();
    // WiFi switched off
    l = emu(); provision(l, ha, { wifi: false });
    l.deck.tick(); await l.deck.idle();
    // asleep
    l = emu(); provision(l, ha);
    l.deck.sleepNow();
    l.deck.tick(); await l.deck.idle();
    // host present + standalone auto
    l = emu(); provision(l, ha); l.send('HB');
    l.deck.tick(); await l.deck.idle();
    assert.equal(ha.requests.length, 0, 'none of the above may poll');

    // host present but standalone=always -> polls
    l = emu(); provision(l, ha, { standalone: 'always' }); l.send('HB');
    l.deck.tick(); await l.deck.idle();
    assert.equal(ha.requests.length, 2);
    // host stops talking for >15 s (auto) -> polls again, and waking after sleep polls immediately
    ha.requests.length = 0;
    l = emu(); provision(l, ha); l.send('HB'); l.clock.t += 16_000;
    l.deck.tick(); await l.deck.idle();
    assert.equal(ha.requests.length, 2);
    ha.requests.length = 0;
    l.deck.sleepNow(); l.deck.touchWake(); l.deck.tick(); await l.deck.idle();
    assert.equal(ha.requests.length, 2, 'poll right after waking');
  } finally { await ha.close(); }
});

test('ha_state: timeouts, 404s and garbage bodies all show as unavailable ("?" on dim grey)', async () => {
  const ha = await mockHa({});
  const cfg = { ...CONFIG, pages: [{ name: 'X', buttons: ['sensor.hang', 'sensor.garbage', 'sensor.missing'].map((e) => ({ type: 'ha', ha_state: { entity: e, on: '00ff00' } })) }] };
  const l = emu({ haTimeoutMs: 60 }, cfg);
  try {
    provision(l, ha);
    const t0 = Date.now();
    l.deck.tick(); await l.deck.idle();
    assert.ok(Date.now() - t0 < 1500, 'the hanging request must time out');
    for (const k of ['0:0', '0:1', '0:2']) assert.deepEqual(l.deck.state.live[k], { btnColor: '3a3a3a', label: '?' }, k);
  } finally { await ha.close(); }
});

// ---------------------------------------------------------------- standalone ha / http presses
test('standalone `ha` press: POSTs the service call with Bearer auth, logs the result, then re-polls the entity', async () => {
  const ha = await mockHa({ 'light.desk': 'off' });
  const l = emu();
  try {
    provision(l, ha);
    l.deck.tick(); await l.deck.idle();
    ha.requests.length = 0;
    assert.equal(l.deck.touch(0).action, 'standalone');
    assert.deepEqual(l.take(), [], 'nothing is sent to a host');
    await l.deck.idle();
    const post = ha.requests[0];
    assert.equal(post.method, 'POST');
    assert.equal(post.url, '/api/services/light/toggle');
    assert.equal(post.auth, `Bearer ${HA_TOKEN}`);
    assert.deepEqual(JSON.parse(post.body), { entity_id: 'light.desk', brightness: 90 });
    assert.match(l.deck.state.log.join('\n'), /ha light\.toggle light\.desk -> HTTP 200/);
    ha.states['light.desk'] = 'on';
    await waitFor(() => ha.gets('light.desk').length === 1); // the ~700 ms re-poll (15 ms in tests)
    await l.deck.idle();
    assert.deepEqual(l.deck.state.live['0:0'], { btnColor: '1a8f3c', label: 'ON' }, 'the new state is shown without waiting for the interval');
  } finally { await ha.close(); }
});

test('`ha` press with a host present goes to the host as BTN (the deck does not act)', async () => {
  const ha = await mockHa({});
  const l = emu();
  try {
    provision(l, ha); l.send('HB');
    assert.equal(l.deck.touch(0).action, 'btn');
    assert.deepEqual(l.take(), ['BTN:0:0']);
    await l.deck.idle();
    assert.equal(ha.requests.length, 0);
  } finally { await ha.close(); }
});

test('standalone `ha` press: not configured / bad service are refused without any request', async () => {
  const ha = await mockHa({});
  const bad = { ...CONFIG, pages: [{ name: 'B', buttons: [
    { type: 'ha', ha: { service: 'light.toggle', entity: 'light.x' } }, // not configured yet
    { type: 'ha', ha: { service: '../x' } }, { type: 'ha', ha: { service: 'a.b/c' } }, { type: 'ha', ha: {} },
  ] }] };
  const l = emu({}, bad);
  try {
    assert.equal(l.deck.touch(0).action, 'standalone'); await l.deck.idle();
    assert.match(l.deck.state.log.at(-1)!, /ha: not configured/);
    provision(l, ha);
    for (const i of [1, 2, 3]) { l.deck.touch(i); await l.deck.idle(); assert.match(l.deck.state.log.at(-1)!, /ha: bad service name/); }
    assert.equal(ha.requests.length, 0);
  } finally { await ha.close(); }
});

test('standalone `http` press: sends method/body/headers; refuses non-http URLs', async () => {
  const ha = await mockHa({});
  const cfg = { ...CONFIG, pages: [{ name: 'H', buttons: [
    { type: 'http', http: { url: `${ha.url}/hook?a=1`, method: 'POST', body: 'hello', headers: { 'X-Test': 'yes' } } },
    { type: 'http', http: { url: `${ha.url}/plain` } },
    { type: 'http', http: { url: 'file:///etc/passwd' } }, { type: 'http', http: { url: `${ha.url}/x`, method: 'TRACE' } }, { type: 'http', http: {} },
  ] }] };
  const l = emu({}, cfg);
  try {
    l.deck.touch(0); await l.deck.idle();
    l.deck.touch(1); await l.deck.idle();
    const [a, b] = ha.requests;
    assert.equal(a.method, 'POST'); assert.equal(a.url, '/hook?a=1'); assert.equal(a.body, 'hello'); assert.equal(a.headers['x-test'], 'yes');
    assert.equal(b.method, 'GET'); assert.equal(b.url, '/plain');
    assert.match(l.deck.state.log.join('\n'), new RegExp(`http POST 127\\.0\\.0\\.1:${ha.port} -> HTTP 200`));
    for (const i of [2, 3, 4]) { l.deck.touch(i); await l.deck.idle(); }
    assert.equal(ha.requests.length, 2, 'bad url / method never hit the network');
    assert.match(l.deck.state.log.join('\n'), /http: bad url/); assert.match(l.deck.state.log.join('\n'), /http: bad method/);
  } finally { await ha.close(); }
});

test('Home Assistant details never leak into replies, state, snapshot or the deck log', async () => {
  const ha = await mockHa({ 'light.desk': 'on' });
  const l = emu();
  try {
    provision(l, ha);
    l.deck.tick(); await l.deck.idle();
    l.deck.touch(0); await l.deck.idle(); await sleep(40); await l.deck.idle();
    l.send('GET_NET');
    const everything = JSON.stringify([l.out, l.deck.state, l.deck.snapshot(), l.deck.state.log]);
    assert.ok(!everything.includes(HA_TOKEN), 'token leaked');
    assert.ok(!everything.includes(ha.url), 'HA url leaked');
    assert.equal(l.deck.snapshot().net && (l.deck.snapshot().net as any).hasHaToken, true);
  } finally { await ha.close(); }
});

// ---------------------------------------------------------------- BLE host slots
test('BLE_HOST: refuses while BLE is disabled, rejects bad arguments, and never wakes the deck', () => {
  const l = emu();
  l.send('BLE_HOST:1');
  assert.deepEqual(l.take(), ['BLE_HOST:err:ble_off']);
  l.send('SET_BLE:{"enabled":true}'); l.take();
  for (const a of ['0', '4', '', 'abc', '1.5', '-1', 'NEXT', '12']) {
    l.send(`BLE_HOST:${a}`);
    assert.deepEqual(l.take(), ['BLE_HOST:err:bad_slot'], `arg "${a}"`);
  }
  assert.equal(l.deck.state.ble.slot, 1);
  l.send('SET_SLEEP:1'); l.take(); l.clock.t += 61_000; l.deck.tick();
  assert.equal(l.deck.state.sleep.sleeping, true);
  l.send('BLE_HOST:2'); l.take();
  assert.equal(l.deck.state.sleep.sleeping, true, 'a background host command must not wake the deck');
});

test('BLE_HOST: switches slot, drops the peer, toasts "BT: <name>", persists and reports in NET_STATUS', () => {
  const l = emu();
  l.send('SET_BLE:{"enabled":true,"slots":["Mac","Work PC","iPad"]}');
  assert.equal(l.take()[0], 'BLE_SET:ok');
  l.deck.setBlePeer('MacBook Pro'); l.take();
  assert.equal(netStatus(l).ble, 'connected');
  l.clock.t += 5000;
  l.send('BLE_HOST:2');
  const out = l.take();
  assert.equal(out[0], 'BLE_HOST:2');
  const st = status(out.find((x) => x.startsWith('NET_STATUS:'))!);
  assert.equal(st.ble_slot, 2); assert.deepEqual(st.ble_slots, ['Mac', 'Work PC', 'iPad']);
  assert.equal(st.ble, 'advertising'); assert.equal(st.ble_peer, '', 'switching identity disconnects the old host');
  assert.equal(l.deck.state.toast?.text, 'BT: Work PC');
  const again = new DeckEmulator({ dataDir: l.dir, now: () => l.clock.t });
  assert.equal(again.state.ble.slot, 2, 'persisted');
  assert.deepEqual(again.state.ble.slots, ['Mac', 'Work PC', 'iPad']);
  l.clock.t += 3000; l.deck.tick();
  assert.equal(l.deck.state.toast, null, 'toast expires');
});

test('BLE_HOST:next cycles 1 -> 2 -> 3 -> 1', () => {
  const l = emu();
  l.send('SET_BLE:{"enabled":true}'); l.take();
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) { l.send('BLE_HOST:next'); seen.push(l.take()[0]); }
  assert.deepEqual(seen, ['BLE_HOST:2', 'BLE_HOST:3', 'BLE_HOST:1', 'BLE_HOST:2']);
});

test('SET_BLE slots: 1..3 names of <=12 printable chars; invalid input changes nothing', () => {
  const l = emu();
  l.send('SET_BLE:{"slots":["Only"]}');
  assert.equal(l.take()[0], 'BLE_SET:ok');
  assert.deepEqual(l.deck.state.ble.slots, ['Only', 'Host 2', 'Host 3']);
  const bad = ['["a","b","c","d"]', '[]', '"Mac"', '{}', '[1,2]', '["' + 'x'.repeat(13) + '"]', '[""]', '["a\\u0001b"]', '["ok","\\u00e9"]'];
  for (const b of bad) {
    l.send(`SET_BLE:{"name":"ShouldNotApply","slots":${b}}`);
    assert.deepEqual(l.take(), ['BLE_SET:err:bad_slots'], b);
  }
  assert.equal(l.deck.state.ble.name, 'SmartDeck', 'validation is atomic');
  assert.deepEqual(l.deck.state.ble.slots, ['Only', 'Host 2', 'Host 3']);
  l.send('SET_BLE:{"slots":["Twelve chars","b"]}');
  assert.equal(l.take()[0], 'BLE_SET:ok');
});

test('SET_BLE clear_bonds: true clears all, a slot number clears one; bonds form when a host connects', () => {
  const l = emu();
  l.send('SET_BLE:{"enabled":true}'); l.take();
  l.deck.setBlePeer('Mac'); l.send('BLE_HOST:2'); l.take(); l.deck.setBlePeer('PC');
  assert.deepEqual(l.deck.state.ble.bonds, [true, true, false]);
  assert.equal(netStatus(l).ble, 'connected');
  l.send('SET_BLE:{"clear_bonds":1}');
  assert.equal(l.take()[0], 'BLE_SET:ok');
  assert.deepEqual(l.deck.state.ble.bonds, [false, true, false]);
  assert.equal(l.deck.state.ble.peer, 'PC', 'clearing another slot does not disconnect the current host');
  l.send('SET_BLE:{"clear_bonds":2}'); l.take();
  assert.equal(l.deck.state.ble.peer, '', 'clearing the current slot disconnects it');
  l.deck.setBlePeer('X'); l.send('SET_BLE:{"clear_bonds":true}'); l.take();
  assert.deepEqual(l.deck.state.ble.bonds, [false, false, false]);
  for (const v of ['0', '4', '"x"', 'false', '1.5', 'null']) {
    l.send(`SET_BLE:{"clear_bonds":${v}}`);
    assert.deepEqual(l.take(), ['BLE_SET:err:bad_clear_bonds'], v);
  }
  l.deck.setBlePeer('Z');
  const again = new DeckEmulator({ dataDir: l.dir, now: () => l.clock.t });
  assert.equal(again.state.ble.bonds[again.state.ble.slot - 1], true, 'bonds persist');
});

// ---------------------------------------------------------------- blehost buttons are device-local
test('`blehost` buttons run on the deck even when a host is connected, and are never sent as BTN', () => {
  for (const standalone of ['auto', 'always', 'never']) {
    const l = emu();
    l.send('SET_BLE:{"enabled":true,"slots":["Mac","Work PC","iPad"]}', `SET_NET:{"standalone":"${standalone}"}`, 'HB'); l.take();
    assert.equal(l.deck.hostActive(), true);
    assert.equal(l.deck.touch(3).action, 'blehost'); // slot 2
    assert.deepEqual(l.take().filter((x) => x.startsWith('BTN:')), [], `no BTN (standalone=${standalone})`);
    assert.equal(l.deck.state.ble.slot, 2);
    assert.equal(l.deck.state.toast?.text, 'BT: Work PC');
    l.deck.touch(4); // next -> 3
    assert.equal(l.deck.state.ble.slot, 3);
    l.deck.touch(4); // wraps -> 1
    assert.equal(l.deck.state.ble.slot, 1);
    assert.deepEqual(l.take().filter((x) => x.startsWith('BTN:')), []);
  }
});

test('`blehost` buttons: BLE off shows "BT: off"; a bad slot shows "BT: ?"; neither changes anything', () => {
  const l = emu();
  l.deck.touch(3);
  assert.equal(l.deck.state.ble.slot, 1);
  assert.equal(l.deck.state.toast?.text, 'BT: off');
  assert.match(l.deck.state.log.at(-1)!, /blehost: ble_off/);
  l.send('SET_BLE:{"enabled":true}'); l.take();
  l.deck.touch(5); // slot 9
  assert.equal(l.deck.state.ble.slot, 1);
  assert.equal(l.deck.state.toast?.text, 'BT: ?');
  assert.deepEqual(l.take().filter((x) => x.startsWith('BTN:')), []);
});

// ---------------------------------------------------------------- over TCP + the browser UI API
class Raw {
  lines: string[] = [];
  private partial = '';
  constructor(public sock: Socket) {
    sock.on('data', (d) => { this.partial += d.toString(); const p = this.partial.split('\n'); this.partial = p.pop() ?? ''; for (const x of p) this.lines.push(x.replace(/\r$/, '')); });
    sock.on('error', () => {});
  }
  static connect(port: number): Promise<Raw> { return new Promise((res, rej) => { const s = createConnection({ port, host: '127.0.0.1' }, () => res(new Raw(s))); s.once('error', rej); }); }
  async next(pred: (l: string) => boolean, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) { const i = this.lines.findIndex(pred); if (i >= 0) return this.lines.splice(0, i + 1).pop()!; if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(this.lines)}`); await sleep(10); }
  }
}

test('over TCP: caps in NET_STATUS, SET_BTN_LIVE is silent, BLE_HOST replies', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'esp_config.json'), JSON.stringify(CONFIG));
  const v = await startVirtualDeck({ port: 0, uiPort: 0, token: 'good-token-1', dataDir: dir });
  try {
    const c = await Raw.connect(v.tcpPort);
    c.sock.write('AUTH:good-token-1\n'); await c.next((l) => l === 'AUTH_OK');
    c.sock.write('GET_NET\n');
    const st = status(await c.next((l) => l.startsWith('NET_STATUS:')));
    assert.deepEqual(st.caps, ['btn_live', 'ha_state', 'ble_hosts']);
    c.sock.write('SET_BTN_LIVE:0:0:{"label":"hi"}\nPING_DECK\n');
    assert.equal(await c.next(() => true), 'PONG_DECK:Smart Deck', 'SET_BTN_LIVE produced no reply before the PONG');
    assert.equal(v.state.live['0:0'].label, 'hi');
    c.sock.write('BLE_HOST:2\n');
    assert.equal(await c.next((l) => l.startsWith('BLE_HOST')), 'BLE_HOST:err:ble_off');
    c.sock.write('SET_BLE:{"enabled":true}\nBLE_HOST:3\n');
    assert.equal(await c.next((l) => l.startsWith('BLE_HOST')), 'BLE_HOST:3');
    c.sock.destroy();
  } finally { await v.close(); }
});

test('UI API: /api/ble-slot needs the CSRF token and a valid slot; /api/state exposes live overrides and the toast', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'esp_config.json'), JSON.stringify(CONFIG));
  const v = await startVirtualDeck({ port: 0, uiPort: 0, token: 'good-token-1', dataDir: dir });
  try {
    const post = (body: unknown, token: string | null) => fetch(`${v.uiUrl}api/ble-slot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-SmartDeck-Token': token } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post({ slot: 2 }, null)).status, 403);
    assert.equal((await post({ slot: 2 }, 'wrong')).status, 403);
    v.deck.feed(Buffer.from('SET_BLE:{"enabled":true,"slots":["Mac","Work PC","iPad"]}\nSET_BTN_LIVE:0:1:{"label":"LIVE"}\n'));
    for (const bad of [4, 0, '2', 'prev', null, 1.5]) assert.equal((await post({ slot: bad }, v.uiToken)).status, 400, String(bad));
    const ok = await post({ slot: 2 }, v.uiToken);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, slot: 2 });
    const st: any = await (await fetch(`${v.uiUrl}api/state`)).json();
    assert.equal(st.toast.text, 'BT: Work PC');
    assert.equal(st.live['0:1'].label, 'LIVE');
    assert.equal(st.ble.slot, 2);
    assert.deepEqual(st.net.status.caps, ['btn_live', 'ha_state', 'ble_hosts']);
    const nx = await (await post({ slot: 'next' }, v.uiToken)).json();
    assert.deepEqual(nx, { ok: true, slot: 3 });
  } finally { await v.close(); }
});
