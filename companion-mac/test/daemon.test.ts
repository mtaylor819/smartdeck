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
import { serveHandshake } from './helpers.js';

/** Fake WiFi deck. newFirmware=false mimics the stock firmware: ignores GET_NET/HB. */
function fakeWifiDeck(token: string, newFirmware: boolean) {
  const received: string[] = [];
  const server = net.createServer((s) => {
    let buf = '', authed = false;
    const drain = () => {
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        received.push(line);
        if (line === 'PING_DECK') s.write('PONG_DECK:Fake Deck\n');
        if (line === 'GET_NET' && newFirmware) s.write('NET_STATUS:{"wifi":"connected","ble":"advertising"}\n');
      }
    };
    const hs = serveHandshake(s, token, (rest) => { authed = true; buf = rest; drain(); });
    s.on('data', (d) => { if (!authed) { hs(d.toString()); return; } buf += d.toString(); drain(); });
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
  const NONCE = '00112233445566778899aabbccddeeff';
  const seen: any[] = [];
  const fetchOk = (async (u: string, o: any) => {
    seen.push([u, o]);
    if (u.endsWith('/challenge')) return { ok: true, status: 200, text: async () => NONCE + '\n' };
    return { ok: true, status: 200, text: async () => 'OK' };
  }) as any;
  await otaUpdate('smartdeck.local', 'tok-secret-1', f, fetchOk);
  assert.equal(seen[0][0], 'http://smartdeck.local:7779/challenge');
  assert.equal(seen[1][0], 'http://smartdeck.local:7779/update');
  const h = seen[1][1].headers;
  const { otaProof, sha256Hex } = await import('../src/linkauth.js');
  assert.equal(h['X-SmartDeck-Nonce'], NONCE);
  assert.equal(h['X-SmartDeck-Sha256'], sha256Hex(good));
  assert.equal(h['X-SmartDeck-Auth'], otaProof('tok-secret-1', NONCE, sha256Hex(good)));
  assert.ok(!JSON.stringify(seen).includes('tok-secret-1'), 'the token must never be sent');
  assert.equal(seen[1][1].body.length, 100_000);
  const fetch401 = (async (u: string) => u.endsWith('/challenge') ? { ok: true, status: 200, text: async () => NONCE } : { ok: false, status: 401, text: async () => 'no' }) as any;
  await assert.rejects(otaUpdate('1.2.3.4:7778', 'bad-token-1', f, fetch401), /rejected the token/);
  const fetchBadNonce = (async () => ({ ok: true, status: 200, text: async () => 'not-a-nonce' })) as any;
  await assert.rejects(otaUpdate('1.2.3.4', 'tok-secret-1', f, fetchBadNonce), /malformed OTA challenge/);
  const fetchLocked = (async () => ({ ok: false, status: 429, text: async () => '' })) as any;
  await assert.rejects(otaUpdate('1.2.3.4', 'tok-secret-1', f, fetchLocked), /locked out/);
  await assert.rejects(otaUpdate('evil.com/x?', 'tok-secret-1', f, fetchOk), /bad address/);
});

import { Keychain } from '../src/secrets.js';

test('keychain: references are resolved for the WiFi link; plaintext never needs to be in the config', async () => {
  const deck = await fakeWifiDeck('tok-12345678', true);
  const dir = mkdtempSync(join(tmpdir(), 'kc-'));
  const cfg = defaultConfig();
  cfg.device = { address: `127.0.0.1:${deck.port}`, token: 'keychain:device-token' };
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  const store: Record<string, string> = { 'device-token': 'tok-12345678' };
  const kc = new Keychain(async (_f, a) => {
    const name = a[a.indexOf('-a') + 1];
    if (name in store) return store[name] + '\n';
    const e: any = new Error('nf'); e.code = 44; throw e;
  });
  const d = new Daemon({ configFile: file, port: '/dev/null/none', runner: async () => {}, capture: async () => '', keychain: kc });
  void d.run();
  try {
    await waitFor(() => d.status().connected);
    assert.equal(d.status().link, 'wifi');
    assert.ok(JSON.stringify(d.getConfig()).includes('keychain:device-token'), 'config keeps the reference, not the value');
    assert.ok(!JSON.stringify(d.getConfig()).includes('tok-12345678'));
  } finally { await d.stop(); deck.close(); }
});

test('keychain: a missing item does not crash the daemon (logged, connection just fails auth)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kc2-'));
  const cfg = defaultConfig();
  cfg.device = { address: '127.0.0.1:1', token: 'keychain:nope' };
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  const kc = new Keychain(async () => { const e: any = new Error('nf'); e.code = 44; throw e; });
  const d = new Daemon({ configFile: file, port: '/dev/null/none', runner: async () => {}, capture: async () => '', keychain: kc });
  void d.run();
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(d.status().connected, false);
    assert.ok(d.status().log.some((l) => /keychain/.test(l)));
    assert.ok(!d.status().log.join('\n').includes('nope-value'));
  } finally { await d.stop(); }
});

test('a trigger fires an ALERT on the connected deck (command source, edge-triggered, once)', async () => {
  const deck = await fakeWifiDeck('tok-12345678', true);
  const { file } = setup(deck.port, true);
  const cfg = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
  cfg.triggers = [{ name: 'Backup', source: { type: 'command', command: 'false' }, alert: { kind: 'yellow', seconds: 5, text: 'Backup failed' }, interval: 10, cooldownMin: 5 }];
  writeFileSync(file, JSON.stringify(cfg));
  const d = new Daemon({ configFile: file, port: '/dev/null/none', runner: async () => {},
    capture: async (f, a) => { if (f === '/bin/sh') throw Object.assign(new Error('exit 1'), { code: 1 }); return ''; } });
  void d.run();
  try {
    // The first poll happens before the deck link is up, so the alert is retried at the next poll (interval 10 s minimum).
    await waitFor(() => deck.received.some((l) => l.startsWith('ALERT:yellow')), 15000);
    assert.ok(deck.received.includes('ALERT:yellow:5:Backup failed'));
    assert.equal(d.status().triggers?.Backup?.state, 'firing');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(deck.received.filter((l) => l.startsWith('ALERT:yellow')).length, 1, 'must not re-fire while the condition persists');
  } finally { await d.stop(); deck.close(); }
});
