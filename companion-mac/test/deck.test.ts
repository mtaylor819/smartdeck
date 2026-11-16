import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, Runner } from '../src/actions.js';
import { defaultConfig, toDeviceConfig, toDeviceButton } from '../src/config.js';
import { Deck } from '../src/deck.js';
import { FakeTransport, tick } from './helpers.js';

function setup() {
  const calls: string[][] = [];
  const run: Runner = async (f, a) => void calls.push([f, ...a]);
  const t = new FakeTransport();
  const cfg = defaultConfig();
  const deck = new Deck(t, cfg, new ActionExecutor(run), () => {}, () => new Date(2026, 0, 1, 12, 0, 0));
  return { calls, t, cfg, deck };
}

test('start() sends time, brightness, knob LED, then GET_SYNC', async () => {
  const { t, deck } = setup();
  await deck.start();
  assert.deepEqual(t.lines(), ['SET_TIME:12:00:00', 'SET_BRIGHTNESS:80', 'SET_KNOB:217:70:239:7', 'GET_SYNC']);
});

test('BTN event runs the configured action for that page/index', async () => {
  const { t, calls } = setup();
  t.deck('BTN:0:0'); // Safari
  await tick();
  assert.deepEqual(calls, [['open', '-a', 'Safari']]);
  t.deck('BTN:0:10'); // GitHub
  await tick();
  assert.deepEqual(calls[1], ['open', 'https://github.com']);
});

test('unconfigured or out-of-range buttons are ignored safely', async () => {
  const { t, calls } = setup();
  t.deck('BTN:0:11'); // goto -> device-handled
  t.deck('BTN:9:9');
  t.deck('BTN:0:999');
  await tick();
  assert.equal(calls.length, 0);
});

test('GET_TIME from the deck is answered with SET_TIME', async () => {
  const { t } = setup();
  t.deck('GET_TIME');
  await tick();
  assert.deepEqual(t.lines(), ['SET_TIME:12:00:00']);
});

test('knob: first reading is baseline, then steps fire in the right direction', async () => {
  const { t, calls, cfg } = setup();
  cfg.knob.step = 60;
  t.deck('KNOB_RAW:1000'); // baseline, no action
  t.deck('KNOB_RAW:1130'); // +130 => 2 steps cw (remainder 10)
  await tick(30);
  assert.equal(calls.filter((c) => c[0] === 'osascript').length, 2);
  t.deck('KNOB_RAW:1070'); // -60 + carried 10 = -50 => still under one step
  await tick(30);
  assert.equal(calls.length, 2);
  t.deck('KNOB_RAW:1060'); // -10 more => -60 => 1 step ccw
  await tick(30);
  assert.equal(calls.length, 3);
});

test('knob handles wraparound and invert', async () => {
  const { t, calls, cfg } = setup();
  cfg.knob.step = 10;
  cfg.knob.invert = true;
  cfg.knob.cw = { type: 'app', app: 'CW' };
  cfg.knob.ccw = { type: 'app', app: 'CCW' };
  t.deck('KNOB_RAW:4090');
  t.deck('KNOB_RAW:5'); // +11 across the wrap; inverted => ccw
  await tick(30);
  assert.deepEqual(calls, [['open', '-a', 'CCW']]);
});

test('a failing action does not break later events', async () => {
  const calls: string[][] = [];
  let first = true;
  const run: Runner = async (f, a) => {
    calls.push([f, ...a]);
    if (first) { first = false; throw new Error('boom'); }
  };
  const t = new FakeTransport();
  new Deck(t, defaultConfig(), new ActionExecutor(run), () => {});
  t.deck('BTN:0:0');
  t.deck('BTN:0:1');
  await tick();
  assert.equal(calls.length, 2);
});

test('device config JSON strips host-only fields and keeps firmware fields', () => {
  const cfg = defaultConfig();
  const dev = toDeviceConfig(cfg) as any;
  assert.equal(dev.grid.cols, 4);
  assert.deepEqual(dev.pages[0].buttons[0], { label: 'Safari', type: 'app' });
  assert.deepEqual(dev.pages[0].buttons[7], { label: 'Screenshot', type: 'key', combo: 'cmd+shift+4' });
  assert.deepEqual(dev.pages[0].buttons[11], { label: 'Page 2', type: 'goto', page: 2 });
  assert.equal(JSON.stringify(dev).includes('github.com'), false); // URLs stay on the Mac
  assert.equal(toDeviceButton(null), null);
});

/** Minimal firmware simulation of handleUsbUpload(). */
function fakeFirmware() {
  const files = new Map<string, Buffer>();
  let state: 'idle' | 'cmd' | 'data' = 'idle';
  let name = '';
  let remaining = 0;
  let chunks: Buffer[] = [];
  return {
    files,
    onWrite(data: string | Buffer, t: FakeTransport) {
      if (state === 'data') {
        const b = Buffer.from(data);
        chunks.push(b);
        remaining -= b.length;
        if (remaining <= 0) {
          files.set(name, Buffer.concat(chunks));
          state = 'cmd';
          t.deck('OK_DATA');
        }
        return;
      }
      const line = data.toString().trim();
      if (line === 'START_UPLOAD') { state = 'cmd'; t.deck('READY'); }
      else if (state === 'cmd' && line.startsWith('FILE:')) {
        const [, n, size] = line.split(':');
        name = n; remaining = Number(size); chunks = [];
        if (!remaining) return t.deck('ERR_FILE_SIZE');
        state = 'data'; t.deck('OK_FILE');
      } else if (state === 'cmd' && line === 'END_UPLOAD') { state = 'idle'; t.deck('DONE_REBOOT'); }
      else t.deck('ERR_UNKNOWN_CMD');
    },
  };
}

test('upload follows the firmware handshake and delivers file bytes intact', async () => {
  const fw = fakeFirmware();
  const t = new FakeTransport(fw.onWrite);
  const deck = new Deck(t, defaultConfig(), new ActionExecutor(async () => {}), () => {});
  const icon = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await deck.uploadConfig([{ name: 'a.jpg', data: icon }]);
  assert.deepEqual(fw.files.get('a.jpg'), icon);
  const cfgJson = JSON.parse(fw.files.get('esp_config.json')!.toString());
  assert.equal(cfgJson.pages[0].name, 'Main');
});

test('upload rejects path-like filenames and surfaces device errors', async () => {
  const fw = fakeFirmware();
  const t = new FakeTransport(fw.onWrite);
  const deck = new Deck(t, defaultConfig(), new ActionExecutor(async () => {}), () => {});
  await assert.rejects(deck.upload([{ name: '../evil', data: Buffer.from('x') }]), /bad upload filename/);
  const t2 = new FakeTransport(fw.onWrite);
  const deck2 = new Deck(t2, defaultConfig(), new ActionExecutor(async () => {}), () => {});
  await assert.rejects(deck2.upload([{ name: 'empty.jpg', data: Buffer.alloc(0) }]), /ERR_FILE_SIZE/);
});
