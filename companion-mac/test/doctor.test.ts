import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/config.js';
import { formatChecks, probeNet, runDoctor, DoctorDeps } from '../src/doctor.js';
import { FakeTransport } from './helpers.js';

const base = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  platform: 'darwin', nodeVersion: 'v22.1.0', capture: async () => '', configFile: '/tmp/x/config.json',
  loadConfig: () => defaultConfig(), listPorts: async () => ['/dev/cu.usbmodem1101'],
  probeDeck: async () => ({ link: 'usb', name: 'Smart Deck', via: 'direct', net: { fw: 'v3', caps: ['btn_live'], wifi: 'off', ble: 'off' } }),
  uiPort: 7777, daemonRunning: async () => false, mode: () => 0o600, ...over,
});
const find = (cs: any[], n: string) => cs.find((c) => c.name === n)!;

test('healthy Mac setup is all ok', async () => {
  const cs = await runDoctor(base());
  assert.equal(cs.filter((c) => c.status === 'fail').length, 0);
  assert.equal(find(cs, 'Accessibility permission').status, 'ok');
  assert.equal(find(cs, 'Firmware').status, 'ok');
  assert.match(formatChecks(cs), /No blocking problems|All good/);
});

test('old node, bad config, no accessibility, no deck are reported as failures with fixes', async () => {
  const cs = await runDoctor(base({
    nodeVersion: 'v18.0.0',
    loadConfig: () => { throw new Error('grid.cols must be positive'); },
    capture: async (f, a) => { if (a.join(' ').includes('keystroke')) throw new Error('not allowed'); return ''; },
    probeDeck: async () => null, listPorts: async () => [],
  }));
  for (const n of ['Node.js', 'Config', 'Accessibility permission', 'Deck connection']) assert.equal(find(cs, n).status, 'fail', n);
  assert.match(find(cs, 'Accessibility permission').fix!, /Privacy & Security/);
  assert.match(formatChecks(cs), /problem\(s\) to fix/);
});

test('stock firmware is a warning that points at the flash command', async () => {
  const cs = await runDoctor(base({ probeDeck: async () => ({ link: 'usb', name: 'Smart Deck', via: 'direct', net: null }) }));
  assert.equal(find(cs, 'Firmware').status, 'warn');
  assert.match(find(cs, 'Firmware').fix!, /flash/);
});

test('plain-text secrets and loose permissions warn; keychain refs and *** do not', async () => {
  const cfg = defaultConfig();
  cfg.device = { token: 'plain-secret-1', wifi: { ssid: 's', password: 'keychain:wifi' }, ha: { url: 'http://h', token: '***' } };
  const cs = await runDoctor(base({ loadConfig: () => cfg, mode: () => 0o644 }));
  assert.equal(find(cs, 'Secrets').status, 'warn');
  assert.match(find(cs, 'Secrets').detail, /^1 secret/);
  assert.equal(find(cs, 'Config permissions').status, 'warn');
  assert.ok(!JSON.stringify(cs).includes('plain-secret-1'), 'secret values must never appear in the report');
});

test('WiFi/BT configured but deck says off => warnings', async () => {
  const cfg = defaultConfig();
  cfg.device = { wifi: { ssid: 'Home' }, ble: { enabled: true } };
  const cs = await runDoctor(base({ loadConfig: () => cfg, probeDeck: async () => ({ link: 'usb', name: 'D', via: 'daemon', net: { wifi: 'connecting', ble: 'off' } }) }));
  assert.equal(find(cs, 'Deck WiFi').status, 'warn');
  assert.equal(find(cs, 'Deck Bluetooth').status, 'warn');
});

test('non-mac platform skips mac checks; firmware checksum verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-'));
  const dist = join(root, 'firmware', 'dist'); mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'smartdeck-jc8048w550-merged.bin'), 'abc');
  writeFileSync(join(dist, 'smartdeck-jc8048w550-merged.bin.sha256'), createHash('sha256').update('abc').digest('hex') + '  x\n');
  writeFileSync(join(dist, 'smartdeck-jc8048w550-app.bin'), 'abc');
  writeFileSync(join(dist, 'smartdeck-jc8048w550-app.bin.sha256'), '0'.repeat(64));
  const cs = await runDoctor(base({ platform: 'linux', repoRoot: root }));
  assert.ok(!cs.some((c) => c.name === 'Accessibility permission'));
  assert.equal(find(cs, 'Platform').status, 'warn');
  assert.equal(find(cs, 'Firmware file smartdeck-jc8048w550-merged.bin').status, 'ok');
  assert.equal(find(cs, 'Firmware file smartdeck-jc8048w550-app.bin').status, 'fail');
});

test('probeNet resolves with NET_STATUS or null on silence', async () => {
  const t = new FakeTransport((d, self) => { if (String(d).trim() === 'GET_NET') self.deck('NET_STATUS:{"fw":"x","caps":["btn_live"]}'); });
  assert.deepEqual((await probeNet(t, 300))?.caps, ['btn_live']);
  assert.equal(await probeNet(new FakeTransport(), 50), null);
});
