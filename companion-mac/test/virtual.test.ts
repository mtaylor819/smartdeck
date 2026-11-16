import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeckEmulator } from '../src/virtual/emulator.js';
import { startVirtualDeck } from '../src/virtual/index.js';

// ---------------------------------------------------------------- helpers
const tmp = () => mkdtempSync(join(tmpdir(), 'vdeck-test-'));

/** Emulator with a fake clock and captured output (no sockets). */
function emu(opts: Record<string, unknown> = {}) {
  const clock = { t: 1_000_000 };
  const out: string[] = [];
  const dir = tmp();
  const deck = new DeckEmulator({ dataDir: dir, now: () => clock.t, token: 'tok-12345678', ...opts });
  deck.on('out', (d: string) => out.push(...d.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '')));
  const send = (...lines: string[]) => deck.feed(Buffer.from(lines.map((l) => l + '\n').join('')));
  return { deck, out, clock, dir, send, take: () => out.splice(0, out.length) };
}

const CONFIG = {
  title: 'Test Deck', grid: { cols: 3, rows: 2 }, theme: { bg_color: '000000', btn_color: '333333', text_color: 'ffffff', stroke_color: '555555', shadow_color: '000000' },
  pages: [
    { name: 'Main', buttons: [{ label: 'A', type: 'key', combo: 'cmd+c' }, { label: 'Mute', type: 'toggle' }, { label: 'Count', type: 'counter', counterStartValue: 5 }, { label: 'Go', type: 'goto', page: 2 }, { label: 'H', type: 'key', combo: 'x', hold: true }] },
    { name: 'Second', buttons: [{ label: 'Back', type: 'goto', page: 1 }] },
  ],
};

function loaded(opts: Record<string, unknown> = {}) {
  const e = emu(opts);
  writeFileSync(join(e.dir, 'esp_config.json'), JSON.stringify(CONFIG));
  e.deck.loadConfig();
  return e;
}

/** Raw TCP client that collects lines. */
class Client {
  lines: string[] = [];
  closed = false;
  private partial = '';
  private waiters: Array<() => void> = [];
  constructor(public sock: Socket) {
    sock.on('data', (d) => {
      this.partial += d.toString('utf8');
      const parts = this.partial.split('\n');
      this.partial = parts.pop() ?? '';
      for (const p of parts) this.lines.push(p.replace(/\r$/, ''));
      this.waiters.splice(0).forEach((w) => w());
    });
    sock.on('close', () => { this.closed = true; this.waiters.splice(0).forEach((w) => w()); });
    sock.on('error', () => {});
  }
  static connect(port: number): Promise<Client> {
    return new Promise((res, rej) => { const s = createConnection({ port, host: '127.0.0.1' }, () => res(new Client(s))); s.once('error', rej); });
  }
  send(d: string | Buffer) { this.sock.write(d); }
  async wait(pred: (l: string) => boolean, ms = 2000): Promise<string> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.lines.findIndex(pred);
      if (i >= 0) return this.lines.splice(0, i + 1).pop()!;
      if (this.closed || Date.now() > end) throw new Error(`timeout; got: ${JSON.stringify(this.lines)} closed=${this.closed}`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 25); });
    }
  }
  async expect(line: string) { return this.wait((l) => l === line); }
  async untilClosed(ms = 2000) { const end = Date.now() + ms; while (!this.closed && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return this.closed; }
}

async function server(emulator: Record<string, unknown> = {}) {
  const v = await startVirtualDeck({ port: 0, uiPort: 0, token: 'good-token-1', dataDir: tmp(), emulator: { rebootDelayMs: 20, bootMs: 150, ...emulator } });
  return v;
}
async function authed(port: number, token = 'good-token-1') {
  const c = await Client.connect(port);
  c.send(`AUTH:${token}\n`);
  await c.expect('AUTH_OK');
  return c;
}

// ---------------------------------------------------------------- TCP link: AUTH
test('AUTH: good token -> AUTH_OK then the normal protocol works', async () => {
  const v = await server();
  try {
    const c = await authed(v.tcpPort);
    c.send('PING_DECK\n');
    await c.expect('PONG_DECK:Smart Deck');
  } finally { await v.close(); }
});

test('AUTH: bad token / missing AUTH prefix -> AUTH_FAIL and the socket closes', async () => {
  const v = await server();
  try {
    for (const first of ['AUTH:wrong-token\n', 'PING_DECK\n', 'AUTH:\n']) {
      const c = await Client.connect(v.tcpPort);
      c.send(first);
      await c.expect('AUTH_FAIL');
      assert.ok(await c.untilClosed());
    }
  } finally { await v.close(); }
});

test('AUTH: 5 failures lock the link out, even for the right token', async () => {
  const v = await server();
  try {
    for (let i = 0; i < 5; i++) { const c = await Client.connect(v.tcpPort); c.send('AUTH:nope\n'); await c.expect('AUTH_FAIL'); }
    const c = await Client.connect(v.tcpPort);
    c.send('AUTH:good-token-1\n');
    await c.expect('AUTH_FAIL');
  } finally { await v.close(); }
});

test('single client: a newly authenticated client replaces the old one', async () => {
  const v = await server();
  try {
    const a = await authed(v.tcpPort);
    const b = await authed(v.tcpPort);
    assert.ok(await a.untilClosed());
    b.send('PING_DECK\n');
    await b.expect('PONG_DECK:Smart Deck');
  } finally { await v.close(); }
});

test('commands pipelined right behind AUTH in the same packet are processed', async () => {
  const v = await server();
  try {
    const c = await Client.connect(v.tcpPort);
    c.send('AUTH:good-token-1\nPING_DECK\n');
    await c.expect('AUTH_OK');
    await c.expect('PONG_DECK:Smart Deck');
  } finally { await v.close(); }
});

// ---------------------------------------------------------------- upload handshake
test('upload: full handshake, files land on the "SD card", reboot drops the link, deck comes back with the new config', async () => {
  const v = await server();
  try {
    const c = await authed(v.tcpPort);
    const cfg = Buffer.from(JSON.stringify(CONFIG));
    const icon = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    c.send('START_UPLOAD\n'); await c.expect('READY');
    c.send(`FILE:esp_config.json:${cfg.length}\n`); await c.expect('OK_FILE');
    c.send(cfg); await c.expect('OK_DATA');
    c.send(`FILE:a.jpg:${icon.length}\n`); await c.expect('OK_FILE');
    c.send(icon); await c.expect('OK_DATA');
    c.send('END_UPLOAD\n');
    await c.expect('DONE_REBOOT');
    await c.expect('Rebooting...');
    assert.ok(await c.untilClosed(), 'link should drop on reboot');
    // refused while rebooting, then back
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(v.state.rebooting, false);
    assert.equal(v.state.config.title, 'Test Deck');
    const c2 = await authed(v.tcpPort);
    c2.send('DUMP_CONFIG\n');
    await c2.expect('CONFIG_START');
    const body = await c2.wait((l) => l.startsWith('{'));
    assert.deepEqual(JSON.parse(body), CONFIG);
    await c2.expect('CONFIG_END');
  } finally { await v.close(); }
});

test('upload: error replies match the firmware', () => {
  const { send, take } = emu();
  send('START_UPLOAD');
  assert.deepEqual(take(), ['READY']);
  send('FILE:nocolon'); assert.deepEqual(take(), ['ERR_CMD_FORMAT']);
  send('FILE:x.jpg:0'); assert.deepEqual(take(), ['ERR_FILE_SIZE']);
  send('FILE:x.jpg:abc'); assert.deepEqual(take(), ['ERR_FILE_SIZE']);
  send('FILE:../evil:5'); assert.deepEqual(take(), ['ERR_FILE_CREATE']);
  send('FILE:a/b:5'); assert.deepEqual(take(), ['ERR_FILE_CREATE']);
  send('BOGUS'); assert.deepEqual(take(), ['ERR_UNKNOWN_CMD']);
});

test('upload: data timeout reports ERR_DATA_TIMEOUT + ERR_DATA_INCOMPLETE and keeps the partial file; back in command mode', () => {
  const { deck, send, take, clock, dir } = emu();
  send('START_UPLOAD'); take();
  send('FILE:part.bin:10'); assert.deepEqual(take(), ['OK_FILE']);
  deck.feed(Buffer.from('abcd'));
  clock.t += 10_500; deck.tick();
  assert.deepEqual(take(), ['ERR_DATA_TIMEOUT', 'ERR_DATA_INCOMPLETE:6']);
  assert.equal(readFileSync(join(dir, 'part.bin'), 'utf8'), 'abcd');
  send('BOGUS'); assert.deepEqual(take(), ['ERR_UNKNOWN_CMD']); // still in upload command mode
});

test('upload: 60 s of silence -> ERR_TIMEOUT then DONE_REBOOT', () => {
  const { deck, send, take, clock } = emu();
  send('START_UPLOAD'); take();
  clock.t += 61_000; deck.tick();
  assert.deepEqual(take(), ['ERR_TIMEOUT', 'DONE_REBOOT', 'Rebooting...']);
});

test('upload: icons that no button references are deleted (cleanUnusedIcons), referenced ones kept', () => {
  const { send, dir, take } = emu();
  const cfg = JSON.stringify({ title: 't', pages: [{ name: 'p', buttons: [{ type: 'key', icon: 'keep.jpg' }, { type: 'toggle', toggleData: { iconOn: 'on.jpg' } }] }] });
  send('START_UPLOAD');
  for (const [n, d] of [['esp_config.json', cfg], ['keep.jpg', 'KEEP'], ['on.jpg', 'ON'], ['drop.jpg', 'DROP']] as const) {
    send(`FILE:${n}:${d.length}`); send(d);
  }
  send('END_UPLOAD');
  assert.ok(take().includes('DONE_REBOOT'));
  assert.ok(existsSync(join(dir, 'keep.jpg')) && existsSync(join(dir, 'on.jpg')));
  assert.ok(!existsSync(join(dir, 'drop.jpg')));
});

// ---------------------------------------------------------------- config commands
test('DUMP_CONFIG without a config says so; with one it round-trips', () => {
  const e = emu();
  e.send('DUMP_CONFIG');
  assert.deepEqual(e.take(), ['CONFIG_ERROR:Cannot open file']);
  const l = loaded();
  l.send('DUMP_CONFIG');
  const o = l.take();
  assert.equal(o[0], 'CONFIG_START'); assert.equal(o[2], 'CONFIG_END');
  assert.deepEqual(JSON.parse(o[1]), CONFIG);
});

test('SET_BTN_DATA updates RAM + file and redraws; bad JSON -> ERR_BAD_JSON; out-of-range page ignored', () => {
  const l = loaded();
  l.send('SET_BTN_DATA:0:0:{"label":"New","type":"app"}');
  assert.deepEqual(l.take(), ['BTN_UPDATED_AND_PAGE_REDRAWN']);
  assert.equal(l.deck.state.config.pages[0].buttons[0]!.label, 'New');
  assert.equal(JSON.parse(readFileSync(join(l.dir, 'esp_config.json'), 'utf8')).pages[0].buttons[0].label, 'New');
  l.send('SET_BTN_DATA:0:0:{nope'); assert.deepEqual(l.take(), ['ERR_BAD_JSON']);
  l.send('SET_BTN_DATA:9:0:{}'); assert.deepEqual(l.take(), []);
  l.send('SET_BTN_DATA:1:4:{"label":"far"}'); // other page: no redraw message; array padded
  assert.deepEqual(l.take(), []);
  assert.equal(l.deck.state.config.pages[1].buttons.length, 5);
});

test('GET_SYNC reports page, knob, toggle states and counters', () => {
  const l = loaded();
  l.send('GET_SYNC');
  assert.deepEqual(l.take(), ['SYNC_PAGE:0', 'KNOB_RAW:0', 'SYNC_STATE:1:1', 'COUNTER_UPDATE:0:2:5']);
});

test('misc config commands reply like the firmware', () => {
  const l = loaded();
  l.send('SET_PAGE:1'); assert.deepEqual(l.take(), ['PAGE_CHANGED:1']);
  l.send('SET_PAGE:9'); assert.deepEqual(l.take(), []);
  l.send('SET_PAGE_NAME:0:Home'); assert.deepEqual(l.take(), ['PAGE_NAME_SET:0:Home']);
  l.send('SET_PAGE_NAME:7:x'); assert.deepEqual(l.take(), ['PAGE_NAME_ERROR:7:Invalid page index']);
  l.send('SET_DEVICE_NAME:Bridge'); assert.deepEqual(l.take(), ['DEVICE_NAME_SET:Bridge']);
  l.send('SET_BRIGHTNESS:150'); assert.deepEqual(l.take(), ['Brightness set to 100%']);
  l.send('SET_SLEEP:5'); assert.deepEqual(l.take(), ['Sleep enabled: 5 min (Timeout: 300000 ms)']);
  l.send('SET_DEEP_SLEEP:30'); assert.deepEqual(l.take(), ['Deep Sleep enabled: 30 min after dim']);
  l.send('SET_DIM_LED:comet'); assert.deepEqual(l.take(), ['Dim LED animation set to: comet (4)']);
  l.send('SET_KNOB:1:2:3:99'); assert.deepEqual(l.take(), ['KNOB_CONFIG_UPDATED']);
  assert.equal(l.deck.state.led.tail, 15);
  l.send('SET_LED_BRIGHTNESS:300'); assert.deepEqual(l.take(), ['LED_BRIGHTNESS_SET']);
  assert.equal(l.deck.state.led.brightness, 255);
  l.send('SET_THEME:111111:222222:eeeeee:444444:000000:1:2:3'); assert.deepEqual(l.take(), ['THEME_UPDATED']);
  assert.equal(l.deck.state.config.theme!.btn_color, '222222');
  l.send('SET_TIME:09:05:07'); assert.deepEqual(l.take(), ['TIME_SET:09:05:07', 'TIME_UPDATED']);
  l.send('WEATHER:22:61:1:1:Light rain:London');
  assert.deepEqual(l.take(), ['Weather updated: 22° (code=61, day=1, celsius=1, desc=Light rain, city=London)']);
  l.send('SET_SLEEP_SCREEN:warp'); assert.deepEqual(l.take(), ['SLEEP_SCREEN_SET:warp']);
  l.send('SET_SLEEP_SCREEN:nonsense'); assert.deepEqual(l.take(), []);
  assert.equal(l.deck.state.sleepScreen, 'warp');
  l.send('UNKNOWN_THING:1'); assert.deepEqual(l.take(), []); // silently ignored
});

// ---------------------------------------------------------------- presence, standalone, sleep
test('HB / any line marks the host present for 15 s; HB is silent', () => {
  const { deck, send, take, clock } = emu();
  assert.equal(deck.hostActive(), false);
  send('HB');
  assert.deepEqual(take(), []);
  assert.equal(deck.hostActive(), true);
  clock.t += 14_000; assert.equal(deck.hostActive(), true);
  clock.t += 2_000; assert.equal(deck.hostActive(), false);
});

test('button press: BTN to the host when present; "would run on deck" when standalone; honours standalone=never/always', () => {
  const l = loaded();
  const standalone: unknown[] = [];
  l.deck.on('standalone', (x) => standalone.push(x));
  l.send('HB');
  l.deck.touch(0);
  assert.deepEqual(l.take(), ['BTN:0:0']);
  l.clock.t += 20_000;
  l.deck.touch(0);
  assert.deepEqual(l.take(), []);
  assert.equal(standalone.length, 1);
  assert.match(l.deck.state.log.at(-1)!, /would run on deck: key cmd\+c/);
  l.send('SET_NET:{"standalone":"never"}'); l.take();
  l.deck.touch(0);
  assert.deepEqual(l.take(), ['BTN:0:0'], 'never = always send to host');
  l.send('SET_NET:{"standalone":"always"}'); l.take(); l.send('HB');
  l.deck.touch(0);
  assert.deepEqual(l.take(), [], 'always = run on deck even with a host');
  assert.equal(standalone.length, 2);
});

test('touch semantics: toggle state, counter, goto, long-press hold, swipe rules', () => {
  const l = loaded();
  l.send('HB');
  l.deck.touch(1); l.deck.touch(1);
  assert.deepEqual(l.take(), ['BTN:0:1:0', 'BTN:0:1:1']); // firmware starts toggles ON, so first tap = OFF
  l.deck.touch(2); assert.deepEqual(l.take(), ['COUNTER_UPDATE:0:2:6']);
  l.deck.touch(2, 900); assert.deepEqual(l.take(), ['COUNTER_UPDATE:0:2:5']); // long press resets
  l.deck.touch(4, 100); assert.deepEqual(l.take(), ['BTN:0:4']); // short tap on a hold button = normal press
  l.deck.touch(4, 700); assert.deepEqual(l.take(), ['BTN_HOLD:0:4']);
  l.deck.touch(0, 700); assert.deepEqual(l.take(), ['BTN:0:0']); // no hold flag = unchanged behaviour
  l.deck.touch(3); assert.deepEqual(l.take(), ['PAGE_CHANGED:1']);
  assert.equal(l.deck.state.page, 1);
  // swipe: too short / too slow / too diagonal / disabled -> not recognised
  assert.deepEqual(l.deck.swipe(-100, 0, 300), { recognized: false, changed: false });
  assert.deepEqual(l.deck.swipe(-300, 0, 900), { recognized: false, changed: false });
  assert.deepEqual(l.deck.swipe(-200, 150, 300), { recognized: false, changed: false });
  assert.deepEqual(l.deck.swipe(200, 10, 300), { recognized: true, changed: true }); // right = previous page
  assert.deepEqual(l.take(), ['PAGE_CHANGED:0']);
  assert.deepEqual(l.deck.swipe(200, 10, 300), { recognized: true, changed: false }); // clamped, no wrap
  l.send('SET_GESTURES:0:600'); l.take();
  assert.deepEqual(l.deck.swipe(-300, 0, 300), { recognized: false, changed: false });
});

test('sleep: enters after the timeout; HB/DIAG/SET_BTN_DATA/SET_TIME/WEATHER do not wake it, PING_DECK does', () => {
  const l = loaded();
  l.send('SET_SLEEP:1'); l.take();
  l.clock.t += 61_000; l.deck.tick();
  assert.equal(l.deck.state.sleep.sleeping, true);
  assert.deepEqual(l.take(), ['GET_TIME'], 'asks the host for the time when the clock was never set');
  for (const c of ['HB', 'DIAG:10:20:30:1:2:3:host', 'SET_BTN_DATA:0:0:{"label":"w"}', 'SET_TIME:10:00:00', 'WEATHER:5:0:1:1:Clear:X', 'SET_SLEEP_SCREEN:diag', 'GET_NET']) {
    l.send(c);
    assert.equal(l.deck.state.sleep.sleeping, true, `${c} must not wake the deck`);
  }
  l.take();
  assert.equal(l.deck.state.diag!.cpu, 10);
  l.send('PING_DECK');
  assert.equal(l.deck.state.sleep.sleeping, false);
  // touching a sleeping deck only wakes it (no button press)
  l.send('HB'); l.clock.t += 61_000; l.deck.tick(); l.take();
  assert.equal(l.deck.state.sleep.sleeping, true);
  assert.deepEqual(l.deck.touch(0), { action: 'swallowed' });
  assert.equal(l.deck.state.sleep.sleeping, false);
  assert.deepEqual(l.take(), []);
});

test('SET_BTN_DATA while asleep: stored but no redraw message', () => {
  const l = loaded();
  l.send('SET_SLEEP:1'); l.clock.t += 61_000; l.deck.tick(); l.take();
  l.send('SET_BTN_DATA:0:0:{"label":"asleep"}');
  assert.deepEqual(l.take(), []);
  assert.equal(l.deck.state.config.pages[0].buttons[0]!.label, 'asleep');
  assert.equal(l.deck.state.sleep.sleeping, true);
});

test('deep sleep follows dim sleep after its timeout', () => {
  const l = loaded();
  l.send('SET_SLEEP:1'); l.send('SET_DEEP_SLEEP:2'); l.take();
  l.clock.t += 61_000; l.deck.tick();
  assert.equal(l.deck.state.sleep.deepSleeping, false);
  l.clock.t += 121_000; l.deck.tick();
  assert.equal(l.deck.state.sleep.deepSleeping, true);
});

// ---------------------------------------------------------------- alerts
test('ALERT: starts (waking the deck), touch acknowledges and is swallowed, ALERT_ACK is sent; off + expiry clear it', () => {
  const l = loaded();
  l.send('HB'); l.send('SET_SLEEP:1'); l.clock.t += 61_000; l.deck.tick(); l.take();
  l.send('ALERT:red:10:BUILD FAILED');
  assert.equal(l.deck.state.sleep.sleeping, false, 'alerts wake the deck');
  assert.equal(l.deck.state.alert!.kind, 'red');
  assert.equal(l.deck.state.alert!.text, 'BUILD FAILED');
  assert.deepEqual(l.deck.touch(0), { action: 'swallowed' }); // UI-side ack hook
  assert.deepEqual(l.take(), ['ALERT_ACK:red']);
  assert.equal(l.deck.state.alert, null);
  l.send('ALERT:yellow:5'); assert.equal(l.deck.state.alert!.kind, 'yellow');
  l.clock.t += 6000; l.deck.tick(); assert.equal(l.deck.state.alert, null);
  l.send('ALERT:blue:0'); assert.equal(l.deck.state.alert!.until, 0); // until cleared
  l.clock.t += 1e7; l.deck.tick(); assert.ok(l.deck.state.alert);
  l.send('ALERT:off'); assert.equal(l.deck.state.alert, null);
  l.send('ALERT:purple:5'); assert.equal(l.deck.state.alert, null, 'unknown kind ignored');
  assert.equal(l.deck.ackAlert(), false);
});

// ---------------------------------------------------------------- provisioning, secrets
test('SET_NET / GET_NET / SET_BLE per PROTOCOL.md; secrets are never echoed', () => {
  const l = emu();
  const secretsIn = { ssid: 'HomeNet', pass: 'hunter2-wifi-pass', host: 'deck-1', token: 'supersecret-token', ha_url: 'http://ha.local:8123', ha_token: 'ha-long-lived-XYZ', tz: 'GMT0BST,M3.5.0/1,M10.5.0/2', standalone: 'auto' };
  l.send(`SET_NET:${JSON.stringify(secretsIn)}`);
  const first = l.take();
  assert.equal(first[0], 'NET_SET:ok');
  l.send('GET_NET');
  const st = l.take();
  assert.equal(st.length, 1);
  const status = JSON.parse(st[0].slice('NET_STATUS:'.length));
  assert.equal(status.wifi, 'connected'); assert.equal(status.host, 'deck-1'); assert.equal(status.ssid, 'HomeNet'); assert.equal(status.ota, true);
  assert.equal(status.ble, 'off'); assert.equal(status.clients, 0); assert.ok(status.fw);
  l.send('SET_BLE:{"enabled":true,"name":"Bridge Deck"}'); assert.equal(l.take()[0], 'BLE_SET:ok');
  l.send('GET_NET');
  assert.equal(JSON.parse(l.take()[0].slice('NET_STATUS:'.length)).ble, 'advertising');
  l.deck.setBlePeer('MacBook Pro');
  l.send('GET_NET');
  const s2 = JSON.parse(l.take().at(-1)!.slice('NET_STATUS:'.length));
  assert.equal(s2.ble, 'connected'); assert.equal(s2.ble_peer, 'MacBook Pro');

  const everything = JSON.stringify([...first, ...st, l.deck.state, l.deck.snapshot(), l.deck.state.log]);
  for (const secret of [secretsIn.pass, secretsIn.token, secretsIn.ha_token]) assert.ok(!everything.includes(secret), `leaked ${secret}`);
  // ...but they are persisted (like NVS), in an owner-only file
  const prefs = join(l.dir, 'prefs.json');
  assert.ok(readFileSync(prefs, 'utf8').includes('hunter2-wifi-pass'));
  assert.equal(statSync(prefs).mode & 0o077, 0, 'prefs.json must be 0600');
  assert.equal(l.deck.currentToken(), 'supersecret-token');
});

test('SET_NET / SET_BLE validation errors', () => {
  const l = emu();
  const cases: Array<[string, string]> = [
    ['{bad', 'NET_SET:err:bad_json'], ['{"host":"Has Spaces"}', 'NET_SET:err:bad_host'], ['{"token":"short"}', 'NET_SET:err:bad_token'],
    ['{"standalone":"sometimes"}', 'NET_SET:err:bad_standalone'], ['{"ha_url":"ftp://x"}', 'NET_SET:err:bad_ha_url'], ['{"ssid":"' + 'x'.repeat(33) + '"}', 'NET_SET:err:bad_ssid'],
  ];
  for (const [arg, want] of cases) { l.send('SET_NET:' + arg); assert.deepEqual(l.take(), [want]); }
  l.send('SET_BLE:{"name":""}'); assert.deepEqual(l.take(), ['BLE_SET:err:bad_name']);
  l.send('SET_BLE:{"name":"' + 'x'.repeat(25) + '"}'); assert.deepEqual(l.take(), ['BLE_SET:err:bad_name']);
  l.send('SET_BLE:nope'); assert.deepEqual(l.take(), ['BLE_SET:err:bad_json']);
  assert.equal(l.deck.currentToken(), 'tok-12345678', 'failed SET_NET must not change anything');
});

test('SET_NET token changes what the TCP link accepts', async () => {
  const v = await server();
  try {
    const c = await authed(v.tcpPort);
    c.send('SET_NET:{"token":"brand-new-token"}\n'); await c.expect('NET_SET:ok');
    const old = await Client.connect(v.tcpPort); old.send('AUTH:good-token-1\n'); await old.expect('AUTH_FAIL');
    const fresh = await authed(v.tcpPort, 'brand-new-token');
    fresh.send('PING_DECK\n'); await fresh.expect('PONG_DECK:Smart Deck');
  } finally { await v.close(); }
});

test('NET_STATUS events are rate-limited to one per 2 s', () => {
  const l = emu();
  l.send('SET_BLE:{"enabled":true}'); // emits BLE_SET:ok + NET_STATUS
  assert.equal(l.take().filter((x) => x.startsWith('NET_STATUS')).length, 1);
  l.deck.setBlePeer('a'); assert.equal(l.take().filter((x) => x.startsWith('NET_STATUS')).length, 0);
  l.clock.t += 2500; l.deck.setBlePeer('b'); assert.equal(l.take().filter((x) => x.startsWith('NET_STATUS')).length, 1);
});

// ---------------------------------------------------------------- knob, lux, autodim
test('knob: only moves of >3 units are reported; wraparound handled', () => {
  const l = emu();
  l.deck.knob(100); l.deck.knob(102); l.deck.knob(110); l.deck.knob(4090); l.deck.knob(4);
  assert.deepEqual(l.take(), ['KNOB_RAW:100', 'KNOB_RAW:110', 'KNOB_RAW:4090', 'KNOB_RAW:4']);
});

test('autodim: no_sensor reply, brightness follows lux on a log curve, LUX events are throttled', () => {
  const none = emu({ luxSensor: false });
  none.send('SET_AUTODIM:1:10:100'); assert.deepEqual(none.take(), ['AUTODIM:no_sensor']);
  const l = emu();
  l.send('SET_AUTODIM:1:10:100:5:400'); assert.deepEqual(l.take(), ['AUTODIM:ok']);
  l.deck.setLux(5); assert.equal(l.deck.effectiveBrightness(), 10);
  l.deck.setLux(400); assert.equal(l.deck.effectiveBrightness(), 100);
  l.deck.setLux(63); const mid = l.deck.effectiveBrightness(); assert.ok(mid > 40 && mid < 70, String(mid)); // geometric middle ~ half
  l.take();
  l.clock.t += 1; l.deck.setLux(1000); assert.deepEqual(l.take(), []); // <10 s since last emit
  const l2 = emu(); l2.deck.setLux(100); l2.clock.t += 11_000; l2.deck.setLux(105); l2.deck.setLux(300);
  assert.deepEqual(l2.take(), ['LUX:100', 'LUX:300']); // 105 is <20% away from 100 and is skipped
});

// ---------------------------------------------------------------- reboot via the emulator directly
test('reboot() drops the link, refuses input while down, then restores a clean boot', async () => {
  const l = loaded({ rebootDelayMs: 5, bootMs: 40 });
  let rebooted = false; l.deck.on('reboot', () => (rebooted = true));
  l.deck.state.page = 1;
  l.deck.reboot();
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(rebooted && l.deck.state.rebooting);
  l.send('PING_DECK'); assert.deepEqual(l.take(), []);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(l.deck.state.rebooting, false);
  assert.equal(l.deck.state.page, 0);
  l.send('PING_DECK'); assert.deepEqual(l.take(), ['PONG_DECK:Smart Deck']);
});

test('runaway lines without a newline are dropped, not buffered forever', () => {
  const l = emu();
  l.deck.feed(Buffer.alloc(20000, 65));
  l.send('PING_DECK');
  assert.deepEqual(l.take(), ['PONG_DECK:Smart Deck']);
});
