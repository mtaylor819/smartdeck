import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';
import { scheduledBrightness } from '../src/schedule.js';
import { checkAppImage, otaUpdate } from '../src/ota.js';

/** Fake WiFi deck. newFirmware=false mimics the stock firmware: ignores GET_NET/HB. */
function fakeWifiDeck(token: string, newFirmware: boolean) {
  const received: string[] = [];
  const server = net.createServer((s) => {
    let buf = '', authed = false;
    s.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!authed) { if (line === `AUTH:${token}`) { authed = true; s.write('AUTH_OK\n'); } else { s.write('AUTH_FAIL\n'); s.end(); } continue; }
        received.push(line);
        if (line === 'PING_DECK') s.write('PONG_DECK:Fake Deck\n');
        if (line === 'GET_NET' && newFirmware) s.write('NET_STATUS:{"wifi":"connected","ble":"advertising"}\n');
      }
    });
  });
  return new Promise<{ port: number; received: string[]; close(): void }>((r) =>
    server.listen(0, '127.0.0.1', () => r({ port: (server.address() as net.AddressInfo).port, received, close: () => { server.close(); } })));
}

function setup(port: number, newFw: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-'));
  const cfg = defaultConfig();
  cfg.device = {
    address: `127.0.0.1:${port}`, token: 'tok-12345678', host: 'smartdeck', standalone: 'auto',
    wifi: { ssid: 'HomeNet', password: 'wifi-secret' }, ha: { url: 'http://ha.local:8123', token: 'ha-secret' },
    ble: { enabled: true, name: 'SmartDeck' }, autodim: { enabled: true, min: 10, max: 100 }, gestures: { swipe: true, holdMs: 600 },
  };
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  return { dir, file };
}

const waitFor = async (cond: () => boolean, ms = 6000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

test('daemon falls back to WiFi, heartbeats, and provisions WITHOUT secrets over TCP', async () => {
  const deck = await fakeWifiDeck('tok-12345678', true);
  const { file } = setup(deck.port, true);
  const d = new Daemon({ configFile: file, port: '/dev/null/none', runner: async () => {}, capture: async () => '' });
  void d.run();
  try {
    await waitFor(() => deck.received.includes('HB') && deck.received.some((l) => l.startsWith('SET_BLE')));
    assert.equal(d.status().link, 'wifi');
    assert.equal(d.status().net?.ble, 'advertising');
    const setNet = deck.received.find((l) => l.startsWith('SET_NET:'))!;
    const blob = JSON.parse(setNet.slice(8));
    assert.equal(blob.ssid, 'HomeNet');
    assert.equal(blob.host, 'smartdeck');
    assert.equal('pass' in blob || 'token' in blob || 'ha_token' in blob, false, 'secrets must not travel over plain TCP');
    assert.ok(!deck.received.join('\n').includes('wifi-secret'));
    assert.ok(!deck.received.join('\n').includes('ha-secret'));
    assert.ok(deck.received.some((l) => l === 'SET_AUTODIM:1:10:100'));
    assert.ok(deck.received.some((l) => l === 'SET_GESTURES:1:600'));
  } finally { await d.stop(); deck.close(); }
});

test('stock firmware (no NET_STATUS reply): no heartbeat, no provisioning', async () => {
  const deck = await fakeWifiDeck('tok-12345678', false);
  const { file } = setup(deck.port, false);
  const d = new Daemon({ configFile: file, port: '/dev/null/none', runner: async () => {}, capture: async () => '' });
  void d.run();
  try {
    await waitFor(() => deck.received.includes('GET_SYNC'), 8000);
    await new Promise((r) => setTimeout(r, 6500)); // longer than one heartbeat period
    assert.ok(!deck.received.includes('HB'), 'HB would keep a stock-firmware deck awake forever');
    assert.ok(!deck.received.some((l) => l.startsWith('SET_NET')));
  } finally { await d.stop(); deck.close(); }
});

test('alert() sends ALERT; config round-trips through setConfig and is written 0600', async () => {
  const deck = await fakeWifiDeck('tok-12345678', true);
  const { file, dir } = setup(deck.port, true);
  const d = new Daemon({ configFile: file, port: '/dev/null/none', runner: async () => {}, capture: async () => '' });
  void d.run();
  try {
    await waitFor(() => d.status().connected);
    await d.alert('red', 30, 'Printer: failed');
    await d.alert('off');
    await waitFor(() => deck.received.includes('ALERT:off'));
    assert.ok(deck.received.includes('ALERT:red:30:Printer failed'));
    const cfg = d.getConfig();
    cfg.title = 'Changed';
    d.setConfig(cfg);
    const { statSync } = await import('node:fs');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('.provisioned-')));
  } finally { await d.stop(); deck.close(); }
});

test('scheduledBrightness handles normal and overnight windows', () => {
  const sch = [{ from: '22:00', to: '07:00', brightness: 15 }, { from: '12:00', to: '13:00', brightness: 50 }];
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  assert.equal(scheduledBrightness(sch, at(23)), 15);
  assert.equal(scheduledBrightness(sch, at(3)), 15);
  assert.equal(scheduledBrightness(sch, at(6, 59)), 15);
  assert.equal(scheduledBrightness(sch, at(7)), undefined);
  assert.equal(scheduledBrightness(sch, at(12, 30)), 50);
  assert.equal(scheduledBrightness(sch, at(13)), undefined);
  assert.equal(scheduledBrightness([], at(1)), undefined);
  assert.equal(scheduledBrightness([{ from: '09:00', to: '09:00', brightness: 1 }], at(9)), undefined);
});

test('OTA: image sanity checks and upload request shape', async () => {
  const good = Buffer.alloc(100_000); good[0] = 0xe9;
  assert.doesNotThrow(() => checkAppImage(good));
  assert.throws(() => checkAppImage(Buffer.alloc(100)), /too small/);
  assert.throws(() => checkAppImage(Buffer.alloc(100_000)), /magic/);
  const merged = Buffer.alloc(600_000); merged[0] = 0xe9; merged[0x8000] = 0xaa; merged[0x8001] = 0x50;
  assert.throws(() => checkAppImage(merged), /MERGED/);
  assert.throws(() => checkAppImage(Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(4 * 1024 * 1024)])), /3 MB/);

  const dir = mkdtempSync(join(tmpdir(), 'ota-'));
  const f = join(dir, 'app.bin'); writeFileSync(f, good);
  const seen: any[] = [];
  const fetchOk = (async (u: string, o: any) => (seen.push([u, o]), { ok: true, status: 200, text: async () => 'OK' })) as any;
  await otaUpdate('smartdeck.local', 'tok', f, fetchOk);
  assert.equal(seen[0][0], 'http://smartdeck.local:7779/update');
  assert.equal(seen[0][1].headers['X-SmartDeck-Token'], 'tok');
  assert.equal(seen[0][1].body.length, 100_000);
  const fetch401 = (async () => ({ ok: false, status: 401, text: async () => 'no' })) as any;
  await assert.rejects(otaUpdate('1.2.3.4:7778', 'bad', f, fetch401), /rejected the token/);
  await assert.rejects(otaUpdate('evil.com/x?', 'tok', f, fetchOk), /bad address/);
});
