import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmd, knobDelta, parseLine } from '../src/protocol.js';

test('parses button presses, with and without toggle state', () => {
  assert.deepEqual(parseLine('BTN:0:14'), { type: 'button', page: 0, index: 14 });
  assert.deepEqual(parseLine('BTN:2:3:1\r'), { type: 'button', page: 2, index: 3, state: 1 });
  assert.deepEqual(parseLine('BTN:2:3:0'), { type: 'button', page: 2, index: 3, state: 0 });
});

test('parses status lines', () => {
  assert.deepEqual(parseLine('PONG_DECK:Smart Deck'), { type: 'pong', name: 'Smart Deck' });
  assert.deepEqual(parseLine('KNOB_RAW:1234'), { type: 'knob', raw: 1234 });
  assert.deepEqual(parseLine('SYNC_PAGE:1'), { type: 'page', page: 1 });
  assert.deepEqual(parseLine('PAGE_CHANGED:3'), { type: 'page', page: 3 });
  assert.deepEqual(parseLine('TIMER_UPDATE:0:4:1:55'), { type: 'timer', page: 0, index: 4, mode: 1, seconds: 55 });
  assert.deepEqual(parseLine('COUNTER_UPDATE:0:2:-7'), { type: 'counter', page: 0, index: 2, value: -7 });
  assert.deepEqual(parseLine('GET_TIME'), { type: 'getTime' });
});

test('malformed or unknown lines become log events, never throw', () => {
  assert.deepEqual(parseLine('BTN:x:y'), { type: 'log', line: 'BTN:x:y' });
  assert.deepEqual(parseLine('Brightness set to 50%'), { type: 'log', line: 'Brightness set to 50%' });
  assert.deepEqual(parseLine(''), { type: 'log', line: '' });
});

test('knobDelta takes the short way around the 12-bit wrap', () => {
  assert.equal(knobDelta(10, 30), 20);
  assert.equal(knobDelta(4090, 5), 11);
  assert.equal(knobDelta(5, 4090), -11);
});

test('command builders match firmware formats', () => {
  assert.equal(cmd.setTime(new Date(2026, 0, 1, 9, 5, 7)), 'SET_TIME:09:05:07');
  assert.equal(cmd.setBrightness(150), 'SET_BRIGHTNESS:100');
  assert.equal(cmd.setKnobLed(300, 0, -5, 99), 'SET_KNOB:255:0:0:15');
  assert.equal(cmd.setBtnData(1, 2, { label: 'x' }), 'SET_BTN_DATA:1:2:{"label":"x"}');
  assert.equal(cmd.fileHeader('a.jpg', 12), 'FILE:a.jpg:12');
});
