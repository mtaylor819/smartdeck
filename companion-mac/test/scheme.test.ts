import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, validate } from '../src/config.js';
import { cmd } from '../src/protocol.js';
import { DeckEmulator } from '../src/virtual/emulator.js';
import { Deck } from '../src/deck.js';
import { FakeTransport, tick } from './helpers.js';

test('scheme: config validation and protocol command', () => {
  const c = defaultConfig();
  for (const s of ['tng', 'voyager', 'picard'] as const) validate({ ...c, scheme: s });
  validate(c); // optional
  assert.throws(() => validate({ ...c, scheme: 'klingon' as any }), /scheme/);
  assert.equal(cmd.setScheme('voyager'), 'SET_SCHEME:voyager');
});

test('scheme: emulator replies and does not wake the deck', () => {
  const deck = new DeckEmulator({ dataDir: mkdtempSync(join(tmpdir(), 'vdeck-scheme-')), token: 'tok-12345678' });
  const out: string[] = [];
  deck.on('out', (d: string) => out.push(...d.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)));
  const send = (l: string) => deck.feed(Buffer.from(l + '\n'));
  send('SET_SCHEME:picard');
  send('SET_SCHEME:nope');
  assert.deepEqual(out.filter((l) => l.includes('SCHEME')), ['SCHEME_SET:picard', 'ERR_SCHEME']);
});

test('scheme: deck start sends SET_SCHEME only when configured', async () => {
  for (const scheme of [undefined, 'voyager'] as const) {
    const t = new FakeTransport();
    const c = defaultConfig();
    if (scheme) c.scheme = scheme;
    const d = new Deck(t, () => c, undefined as any, () => {});
    await d.start();
    await tick();
    const sent = t.written.join('');
    assert.equal(sent.includes('SET_SCHEME:voyager'), scheme === 'voyager');
    if (!scheme) assert.ok(!sent.includes('SET_SCHEME'));
  }
});
