import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, Runner } from '../src/actions.js';
import { parseCombo } from '../src/keymap.js';

function harness() {
  const calls: Array<[string, string[]]> = [];
  const run: Runner = async (f, a) => void calls.push([f, a]);
  const sleeps: number[] = [];
  const ex = new ActionExecutor(run, () => {}, undefined, async (ms) => void sleeps.push(ms));
  return { calls, sleeps, ex };
}

test('parseCombo handles modifiers, aliases and case', () => {
  assert.deepEqual(parseCombo('CMD+Shift+4'), { keyCode: 21, modifiers: ['command', 'shift'] });
  assert.deepEqual(parseCombo('ctrl+alt+delete'), { keyCode: 51, modifiers: ['control', 'option'] });
  assert.deepEqual(parseCombo('f5'), { keyCode: 96, modifiers: [] });
  assert.deepEqual(parseCombo('cmd++'), { keyCode: 24, modifiers: ['command'] });
  assert.throws(() => parseCombo('cmd+banana'), /Unknown key/);
  assert.throws(() => parseCombo('cmd+shift'), /no key/);
  assert.throws(() => parseCombo('a+b'), /more than one/);
});

test('key action -> System Events key code', async () => {
  const { ex, calls } = harness();
  await ex.execute({ type: 'key', combo: 'cmd+shift+4' });
  assert.deepEqual(calls, [['osascript', ['-e', 'tell application "System Events" to key code 21 using {command down, shift down}']]]);
});

test('text action escapes quotes and backslashes', async () => {
  const { ex, calls } = harness();
  await ex.execute({ type: 'text', text: 'say "hi" \\ there' });
  assert.equal(calls[0][1][1], 'tell application "System Events" to keystroke "say \\"hi\\" \\\\ there"');
});

test('app / website / script / sound', async () => {
  const { ex, calls } = harness();
  await ex.execute({ type: 'app', app: 'Safari' });
  await ex.execute({ type: 'app', app: '/Applications/Foo.app' });
  await ex.execute({ type: 'website', url: 'https://example.com' });
  await ex.execute({ type: 'script', command: 'echo hi' });
  assert.deepEqual(calls, [
    ['open', ['-a', 'Safari']],
    ['open', ['/Applications/Foo.app']],
    ['open', ['https://example.com']],
    ['/bin/sh', ['-c', 'echo hi']],
  ]);
});

test('website refuses non-http schemes (no file:// or custom handlers)', async () => {
  const { ex, calls } = harness();
  await assert.rejects(ex.execute({ type: 'website', url: 'file:///etc/passwd' }), /non-http/);
  assert.equal(calls.length, 0);
});

test('multi runs steps in order including delays', async () => {
  const { ex, calls, sleeps } = harness();
  await ex.execute({
    type: 'multi',
    steps: [{ type: 'app', app: 'Notes' }, { type: 'delay', ms: 500 }, { type: 'key', combo: 'cmd+n' }],
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [500]);
  assert.equal(calls[0][0], 'open');
});

test('toggle picks on/off from the state the deck reports', async () => {
  const { ex, calls } = harness();
  const a = { type: 'toggle', on: { type: 'app', app: 'On' }, off: { type: 'app', app: 'Off' } } as const;
  await ex.execute(a, 1);
  await ex.execute(a, 0);
  assert.deepEqual(calls.map((c) => c[1][1]), ['On', 'Off']);
});

test('media keys go through the JXA media-key script', async () => {
  const { ex, calls } = harness();
  await ex.execute({ type: 'media', key: 'play_pause' });
  assert.deepEqual(calls[0][1].slice(0, 2), ['-l', 'JavaScript']);
  assert.match(calls[0][1][3], /\(16 << 16\)/);
});

test('device-handled actions are no-ops on the host', async () => {
  const { ex, calls } = harness();
  await ex.execute({ type: 'goto', page: 2 });
  await ex.execute({ type: 'timer', duration: 60 });
  assert.equal(calls.length, 0);
});
