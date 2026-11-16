// The real Mac-side Deck class driving the virtual deck over TCP: proves the emulator is a drop-in for hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionExecutor } from '../src/actions.js';
import { defaultConfig, toDeviceConfig } from '../src/config.js';
import { Deck } from '../src/deck.js';
import type { Transport } from '../src/transport.js';
import { startVirtualDeck } from '../src/virtual/index.js';

class SocketTransport extends EventEmitter implements Transport {
  private partial = '';
  constructor(private sock: Socket) {
    super();
    sock.on('data', (d) => {
      this.partial += d.toString('utf8');
      const parts = this.partial.split('\n');
      this.partial = parts.pop() ?? '';
      for (const p of parts) this.emit('line', p.replace(/\r$/, ''));
    });
    sock.on('close', () => this.emit('close'));
    sock.on('error', () => {});
  }
  write(data: string | Buffer): Promise<void> {
    return new Promise((res, rej) => this.sock.write(data, (e) => (e ? rej(e) : res())));
  }
  close(): Promise<void> { this.sock.destroy(); return Promise.resolve(); }
}

async function link(port: number, token: string) {
  const sock = createConnection({ port, host: '127.0.0.1' });
  const first = new Promise<string>((res) => sock.once('data', (d) => res(d.toString().trim())));
  sock.write(`AUTH:${token}\n`);
  assert.equal(await first, 'AUTH_OK');
  return new SocketTransport(sock);
}

test('Deck.start() configures the virtual deck; BTN presses run configured actions; HB marks the host present', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'vint-'));
  writeFileSync(join(dataDir, 'esp_config.json'), JSON.stringify(toDeviceConfig(defaultConfig()))); // what a previous sync left on the SD card
  const v = await startVirtualDeck({ port: 0, uiPort: 0, token: 'int-token-123', dataDir });
  try {
    const t = await link(v.tcpPort, 'int-token-123');
    const calls: string[][] = [];
    const cfg = defaultConfig();
    cfg.power = { sleepMinutes: 5, dimLed: 'comet', ledBrightness: 120 };
    cfg.sleepScreen = 'diag-anim' as never;
    const deck = new Deck(t, cfg, new ActionExecutor(async (f, a) => void calls.push([f, ...a])), () => {}, () => new Date(2026, 0, 1, 9, 30, 0));
    await deck.start();
    await new Promise((r) => setTimeout(r, 100));
    const s = v.state;
    assert.equal(s.brightness, 80);
    assert.equal(s.sleep.enabled, true); assert.equal(s.sleep.minutes, 5);
    assert.equal(s.dimLed, 4); assert.equal(s.led.brightness, 120);
    assert.equal(s.sleepScreen, 'diag-anim');
    assert.equal(s.clock.set, true); assert.equal(v.deck.clockNow().h, 9);
    assert.equal(v.deck.hostActive(), true);
    // press the first default button (Chrome) on the virtual deck -> the Mac app runs it
    v.deck.touch(0);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(calls[0], ['open', '-a', 'Google Chrome']);
    await deck.close();
  } finally { await v.close(); }
});

test('Deck.uploadConfig() works against the virtual deck, including icons, then the deck shows the config after its reboot', async () => {
  const v = await startVirtualDeck({
    port: 0, uiPort: 0, token: 'int-token-123', dataDir: mkdtempSync(join(tmpdir(), 'vint-')),
    emulator: { rebootDelayMs: 20, bootMs: 150 },
  });
  try {
    const t = await link(v.tcpPort, 'int-token-123');
    const cfg = defaultConfig();
    cfg.pages[0].buttons[0] = { label: 'Icon', icon: 'x.jpg', action: { type: 'app', app: 'Safari' } };
    const deck = new Deck(t, cfg, new ActionExecutor(async () => {}), () => {});
    await deck.uploadConfig([{ name: 'x.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]) }]);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(v.state.rebooting, false);
    assert.equal(v.state.config.title, 'Smart Deck');
    assert.equal(v.state.config.pages[0].buttons[0]!.label, 'Icon');
    assert.equal(v.state.config.pages[0].buttons[0]!.type, 'app');
    assert.equal(v.state.configError, null);
  } finally { await v.close(); }
});
