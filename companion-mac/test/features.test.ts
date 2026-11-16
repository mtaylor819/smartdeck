import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, mouseScript, Runner } from '../src/actions.js';
import { AppWatcher } from '../src/appwatch.js';
import { defaultConfig } from '../src/config.js';
import { Deck } from '../src/deck.js';
import { plistFor } from '../src/service.js';
import { describeWmo, weatherLine } from '../src/weather.js';
import { jsonPath, readWidget, renderWidget, WidgetManager } from '../src/widgets.js';
import { FakeTransport, tick } from './helpers.js';

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

function exec(fetchImpl?: typeof fetch, ha?: any) {
  const calls: string[][] = [];
  const run: Runner = async (f, a) => void calls.push([f, ...a]);
  return { calls, ex: new ActionExecutor(run, () => {}, fetchImpl, undefined, () => ha) };
}

test('shortcut / applescript / urlscheme / mouse / paste route to the right tools', async () => {
  const { ex, calls } = exec();
  await ex.execute({ type: 'shortcut', name: 'Focus On' });
  await ex.execute({ type: 'applescript', script: 'beep' });
  await ex.execute({ type: 'urlscheme', url: 'slack://open' });
  await ex.execute({ type: 'mouse', op: 'click', x: 10, y: 20 });
  await ex.execute({ type: 'paste', text: 'héllo "q"' });
  assert.deepEqual(calls[0], ['shortcuts', 'run', 'Focus On']);
  assert.deepEqual(calls[1], ['osascript', '-e', 'beep']);
  assert.deepEqual(calls[2], ['open', 'slack://open']);
  assert.equal(calls[3][0], 'osascript');
  assert.match(calls[3][4], /pt\(10,20\)/);
  assert.match(calls[4][2], /set the clipboard to "héllo \\"q\\""/);
});

test('urlscheme refuses file:, javascript: and garbage', async () => {
  const { ex, calls } = exec();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url'])
    await assert.rejects(ex.execute({ type: 'urlscheme', url }), /Refusing/);
  assert.equal(calls.length, 0);
});

test('mouse scripts are generated for each op and sanitise numbers', () => {
  for (const op of ['click', 'double', 'right', 'move', 'scroll'] as const)
    assert.ok(mouseScript({ type: 'mouse', op, x: 1, y: 2, dy: 3 }).includes('ObjC.import'));
  assert.match(mouseScript({ type: 'mouse', op: 'click', x: '1);evil(' as any, y: 2 }), /pt\(0,2\)/);
});

test('ha action posts to the service endpoint with bearer token', async () => {
  const seen: any[] = [];
  const f = (async (u: string, o: any) => (seen.push([u, o]), jsonRes([]))) as any;
  const { ex } = exec(f, { url: 'http://ha.local:8123/', token: 'tok' });
  await ex.execute({ type: 'ha', service: 'light.toggle', entity: 'light.desk', data: { brightness: 100 } });
  assert.equal(seen[0][0], 'http://ha.local:8123/api/services/light/toggle');
  assert.equal(seen[0][1].headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen[0][1].body), { entity_id: 'light.desk', brightness: 100 });
});

test('ha action rejects missing config, bad service names and HTTP errors', async () => {
  await assert.rejects(exec().ex.execute({ type: 'ha', service: 'light.toggle' }), /not configured/);
  const cfg = { url: 'http://h', token: 't' };
  await assert.rejects(exec(undefined, cfg).ex.execute({ type: 'ha', service: '../x' }), /Bad HA service/);
  const f = (async () => jsonRes({}, false, 401)) as any;
  await assert.rejects(exec(f, cfg).ex.execute({ type: 'ha', service: 'a.b' }), /HTTP 401/);
});

test('renderWidget: format, truncation, highest matching threshold', () => {
  const w = { source: 'cpu' as const, format: 'CPU {value}%', thresholds: [{ above: 50, color: 'ffaa00' }, { above: 80, color: 'ff0000' }] };
  assert.deepEqual(renderWidget(w, '30'), { label: 'CPU 30%', btnColor: undefined });
  assert.equal(renderWidget(w, '60').btnColor, 'ffaa00');
  assert.equal(renderWidget(w, '95').btnColor, 'ff0000');
  assert.equal(renderWidget({ source: 'clock' }, 'x'.repeat(50)).label.length, 24);
  assert.equal(renderWidget(w, 'idle').btnColor, undefined);
});

test('jsonPath walks objects and arrays safely', () => {
  const o = { a: { b: [{ c: 5 }] } };
  assert.equal(jsonPath(o, 'a.b.0.c'), 5);
  assert.equal(jsonPath(o, 'a.x.y'), undefined);
  assert.equal(jsonPath(null, 'a'), undefined);
});

const deps = (fetchImpl: any, cpu: any = () => []) =>
  ({ capture: async () => 'Artist - Song\n', fetchImpl, ha: () => ({ url: 'http://h', token: 't' }), cpuTimes: cpu }) as any;

test('readWidget: cpu from two samples, nowplaying, ha_state, moonraker', async () => {
  const st: any = {};
  let t = [{ idle: 100, total: 200 }];
  const d = deps(async () => jsonRes({}), () => t);
  assert.equal(await readWidget({ source: 'cpu' }, d, st), '0'); // first sample = baseline
  t = [{ idle: 150, total: 300 }]; // 100 total, 50 idle => 50%
  assert.equal(await readWidget({ source: 'cpu' }, d, st), '50');
  assert.equal(await readWidget({ source: 'nowplaying' }, d, {}), 'Artist - Song');
  const ha = deps(async (u: string) => jsonRes({ state: 'on' }));
  assert.equal(await readWidget({ source: 'ha_state', entity: 'light.x' }, ha, {}), 'on');
  const mr = (status: any) => deps(async () => jsonRes({ result: { status } }));
  assert.equal(await readWidget({ source: 'moonraker', url: 'http://p' }, mr({ print_stats: { state: 'printing' }, display_status: { progress: 0.426 } }), {}), '43%');
  assert.equal(await readWidget({ source: 'moonraker', url: 'http://p' }, mr({ print_stats: { state: 'standby' }, extruder: { temperature: 24.6 } }), {}), '25°');
  await assert.rejects(readWidget({ source: 'http_json', url: 'file:///x' }, d, {}), /http\(s\)/);
});

test('WidgetManager pushes on change only, respects the interval, and sends full button JSON', async () => {
  const cfg = defaultConfig();
  cfg.pages[0].buttons[0] = { label: 'CPU', action: { type: 'none' }, widget: { source: 'http_json', url: 'http://x', jsonPath: 'v', format: 'V {value}', interval: 10 } };
  let v = 1;
  let now = 1_000_000;
  const sent: string[] = [];
  const m = new WidgetManager(() => cfg, async (l) => void sent.push(l), deps(async () => jsonRes({ v })), () => {}, () => now, 0);
  await m.tick();
  await tick(5);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^SET_BTN_DATA:0:0:\{.*"label":"V 1".*"type":"none"/);
  now += 11_000; // due again, same value => no send
  await m.tick(); await tick(5);
  assert.equal(sent.length, 1);
  now += 5_000; v = 2; // not due yet even though value changed
  await m.tick(); await tick(5);
  assert.equal(sent.length, 1);
  now += 11_000;
  await m.tick(); await tick(5);
  assert.equal(sent.length, 2);
  assert.equal(m.values['0:0'], 'V 2');
});

test('AppWatcher switches page only when the frontmost app changes to a ruled app', async () => {
  const cfg = defaultConfig();
  cfg.appPages = [{ app: 'Safari', page: 1 }];
  let front = 'Finder';
  const pages: number[] = [];
  const w = new AppWatcher(() => cfg, async () => front + '\n', async (p) => void pages.push(p));
  await w.poll(); assert.deepEqual(pages, []);
  front = 'safari'; await w.poll(); assert.deepEqual(pages, [1]);
  await w.poll(); assert.deepEqual(pages, [1]); // unchanged => no re-switch (manual nav stays possible)
  front = 'Notes'; await w.poll(); assert.deepEqual(pages, [1]);
  front = 'Safari'; await w.poll(); assert.deepEqual(pages, [1, 1]);
});

test('weatherLine builds the WEATHER command and validates input', async () => {
  let url = '';
  const f = (async (u: string) => ((url = u), jsonRes({ current: { temperature_2m: 12.4, weather_code: 61, is_day: 1 } }))) as any;
  const line = await weatherLine({ lat: 51.5, lon: -0.12, city: 'London' }, f);
  assert.equal(line, 'WEATHER:12:61:1:1:Light rain:London');
  assert.match(url, /latitude=51.5&longitude=-0.12/);
  await assert.rejects(weatherLine({ lat: 999, lon: 0 }, f), /out of range/);
  assert.equal(describeWmo(12345), 'Unknown');
});

test('start() also sends configured power settings', async () => {
  const cfg = defaultConfig();
  cfg.power = { sleepMinutes: 5, deepSleepMinutes: 30, dimLed: 'breathing', ledBrightness: 100 };
  const t = new FakeTransport();
  const d = new Deck(t, cfg, new ActionExecutor(async () => {}), () => {}, () => new Date(2026, 0, 1, 1, 2, 3));
  await d.start();
  assert.deepEqual(t.lines().slice(3), ['SET_SLEEP:5', 'SET_DEEP_SLEEP:30', 'SET_DIM_LED:breathing', 'SET_LED_BRIGHTNESS:100', 'GET_SYNC']);
});

test('config getter is read live (UI edits apply without restart)', async () => {
  let cfg = defaultConfig();
  const calls: string[][] = [];
  const t = new FakeTransport();
  new Deck(t, () => cfg, new ActionExecutor(async (f, a) => void calls.push([f, ...a])), () => {});
  t.deck('BTN:0:0'); await tick();
  cfg = { ...cfg, pages: [{ name: 'x', buttons: [{ action: { type: 'app', app: 'Notes' } }] }] };
  t.deck('BTN:0:0'); await tick();
  assert.deepEqual(calls.map((c) => c[2]), ['Safari', 'Notes']);
});

test('LaunchAgent plist escapes paths and runs at load', () => {
  const p = plistFor('/usr/local/bin/node', '/Users/a&b/cli.js', '/tmp/l.log');
  assert.match(p, /a&amp;b/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<string>run<\/string>/);
});

import { flashArgs, verifyChecksum } from '../src/flash.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('flashArgs writes the merged image at 0x0 and rejects odd port paths', () => {
  const a = flashArgs('/dev/cu.usbmodem1101', 'fw.bin');
  assert.deepEqual(a.slice(-2), ['0x0', 'fw.bin']);
  assert.ok(a.includes('esp32s3'));
  assert.throws(() => flashArgs('/dev/cu.x; rm -rf /', 'fw.bin'), /Suspicious/);
  assert.throws(() => flashArgs('--port', 'fw.bin'), /Suspicious/);
});

test('verifyChecksum: none / ok / mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-'));
  const bin = join(dir, 'fw.bin');
  writeFileSync(bin, 'abc');
  assert.equal(verifyChecksum(bin), 'none');
  writeFileSync(bin + '.sha256', createHash('sha256').update('abc').digest('hex') + '  fw.bin\n');
  assert.equal(verifyChecksum(bin), 'ok');
  writeFileSync(bin + '.sha256', '0'.repeat(64));
  assert.throws(() => verifyChecksum(bin), /mismatch/);
});
