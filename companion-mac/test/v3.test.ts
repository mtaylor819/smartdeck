import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, Runner } from '../src/actions.js';
import { defaultConfig, toDeviceButton, validate } from '../src/config.js';
import { renderHaState, WidgetManager } from '../src/widgets.js';
import { tick } from './helpers.js';

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const deps = (fetchImpl: any) => ({ capture: async () => '', fetchImpl, ha: () => ({ url: 'http://h', token: 't' }), cpuTimes: () => [] }) as any;

test('renderHaState maps on/off/unavailable and sanitises colours', () => {
  const h = { entity: 'light.x', on: '1a8f3c', off: '333333', label_on: 'ON', label_off: 'OFF' };
  assert.deepEqual(renderHaState(h, 'on'), { btnColor: '1a8f3c', label: 'ON' });
  assert.deepEqual(renderHaState(h, 'off'), { btnColor: '333333', label: 'OFF' });
  assert.deepEqual(renderHaState(h, 'unavailable'), { btnColor: '444444', label: '?' });
  assert.deepEqual(renderHaState(h, null), { btnColor: '444444', label: '?' });
  assert.deepEqual(renderHaState({ entity: 'light.x', on: 'zzz' }, 'on'), {}); // bad colour dropped, no labels
});

test('widgets use SET_BTN_LIVE (no SD writes, 2 s floor) when the deck has btn_live', async () => {
  const cfg = defaultConfig();
  cfg.pages[0].buttons[0] = { label: 'T', action: { type: 'none' }, widget: { source: 'http_json', url: 'http://x', jsonPath: 'v', interval: 2 } };
  let v = 1, now = 1_000_000;
  const sent: string[] = [];
  const m = new WidgetManager(() => cfg, async (l) => void sent.push(l), deps(async () => jsonRes({ v })), () => {}, () => now, 0, () => true);
  await m.tick(); await tick(5);
  assert.deepEqual(sent, ['SET_BTN_LIVE:0:0:{"label":"1"}']);
  now += 2_500; v = 2; await m.tick(); await tick(5); // 2.5 s later: due (live floor 2 s) and changed
  assert.equal(sent.length, 2);
  assert.ok(sent.every((l) => !l.startsWith('SET_BTN_DATA')));
});

test('without btn_live the old 10 s SD-friendly path is used', async () => {
  const cfg = defaultConfig();
  cfg.pages[0].buttons[0] = { label: 'T', action: { type: 'none' }, widget: { source: 'http_json', url: 'http://x', jsonPath: 'v', interval: 2 } };
  let now = 1_000_000;
  const sent: string[] = [];
  const m = new WidgetManager(() => cfg, async (l) => void sent.push(l), deps(async () => jsonRes({ v: 5 })), () => {}, () => now, 0, () => false);
  await m.tick(); await tick(5);
  assert.match(sent[0], /^SET_BTN_DATA:0:0:/);
  now += 3_000; await m.tick(); await tick(5);
  assert.equal(sent.length, 1); // not due: floor is 10 s
});

test('haState buttons are polled by the Mac and shown via live updates; errors show as unavailable', async () => {
  const cfg = defaultConfig();
  cfg.pages[0].buttons[0] = { label: 'Desk', action: { type: 'ha', service: 'light.toggle', entity: 'light.desk' }, haState: { entity: 'light.desk', on: '1a8f3c', off: '333333', label_on: 'ON', label_off: 'OFF', interval: 5 } };
  let state: any = 'on', now = 1_000_000, fail = false;
  const sent: string[] = [];
  const f = async () => { if (fail) throw new Error('net down'); return jsonRes({ state }); };
  const m = new WidgetManager(() => cfg, async (l) => void sent.push(l), deps(f), () => {}, () => now, 0, () => true);
  await m.tick(); await tick(5);
  assert.equal(sent[0], 'SET_BTN_LIVE:0:0:{"label":"ON","btnColor":"1a8f3c"}');
  now += 6_000; state = 'off'; await m.tick(); await tick(5);
  assert.equal(sent[1], 'SET_BTN_LIVE:0:0:{"label":"OFF","btnColor":"333333"}');
  now += 6_000; fail = true; await m.tick(); await tick(5);
  assert.equal(sent[2], 'SET_BTN_LIVE:0:0:{"label":"?","btnColor":"444444"}');
});

test('blehost action sends BLE_HOST to the deck and validates the slot', async () => {
  const lines: string[] = [];
  const ex = new ActionExecutor(async () => {}, () => {}, undefined, undefined, () => undefined, async () => {}, async (l) => void lines.push(l));
  await ex.execute({ type: 'blehost', slot: 2 });
  await ex.execute({ type: 'blehost', slot: 'next' });
  assert.deepEqual(lines, ['BLE_HOST:2', 'BLE_HOST:next']);
  await assert.rejects(ex.execute({ type: 'blehost', slot: 4 as any }), /slot must be/);
  const noDeck = new ActionExecutor(async () => {});
  await assert.rejects(noDeck.execute({ type: 'blehost', slot: 1 }), /not connected/);
});

test('device JSON carries blehost slot and ha_state', () => {
  assert.deepEqual(toDeviceButton({ action: { type: 'blehost', slot: 'next' } }), { type: 'blehost', slot: 'next' });
  const j = toDeviceButton({ action: { type: 'ha', service: 'light.toggle', entity: 'light.x' }, haState: { entity: 'light.x', on: '00ff00' } })!;
  assert.deepEqual(j.ha_state, { entity: 'light.x', on: '00ff00' });
});

test('validation: ble slots, haState and blehost', () => {
  const c = defaultConfig();
  c.device = { ble: { enabled: true, slots: ['Mac', 'Work PC', 'iPad'] } };
  validate(c);
  for (const slots of [[], ['a', 'b', 'c', 'd'], ['x'.repeat(13)], ['bad\nname']])
    assert.throws(() => validate({ ...c, device: { ble: { enabled: true, slots } } }), /slots/);
  const b = defaultConfig();
  b.pages[0].buttons[0] = { label: 'x', action: { type: 'none' }, haState: { entity: 'Light Desk' } };
  assert.throws(() => validate(b), /haState.entity/);
  b.pages[0].buttons[0] = { label: 'x', action: { type: 'none' }, haState: { entity: 'light.desk', on: 'red' } };
  assert.throws(() => validate(b), /6 hex/);
  b.pages[0].buttons[0] = { label: 'x', action: { type: 'none' }, haState: { entity: 'light.desk', interval: 1 } };
  assert.throws(() => validate(b), /interval/);
  b.pages[0].buttons[0] = { label: 'x', action: { type: 'blehost', slot: 9 as any } };
  assert.throws(() => validate(b), /blehost slot/);
  b.pages[0].buttons[0] = { label: 'x', action: { type: 'blehost', slot: 3 }, haState: { entity: 'light.desk', on: '00ff00', interval: 5 } };
  validate(b);
});

test('buttons with a label ask the firmware to draw it (stock firmware draws none)', () => {
  assert.equal(toDeviceButton({ label: 'Mute', icon: 'm.jpg', action: { type: 'media', key: 'mute' } })!.showLabel, true);
  assert.equal('showLabel' in toDeviceButton({ action: { type: 'none' } })!, false);
});
