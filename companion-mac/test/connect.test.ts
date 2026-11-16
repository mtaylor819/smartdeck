import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ActionExecutor, Runner } from '../src/actions.js';
import { cmd, parseLine } from '../src/protocol.js';
import { defaultConfig, toDeviceButton, validate } from '../src/config.js';
import { Deck } from '../src/deck.js';
import { TcpTransport } from '../src/transport.js';
import { FakeTransport, serveHandshake, tick } from './helpers.js';

test('parses new deck events', () => {
  assert.deepEqual(parseLine('BTN_HOLD:1:4'), { type: 'hold', page: 1, index: 4 });
  assert.deepEqual(parseLine('ALERT_ACK:red'), { type: 'alertAck', kind: 'red' });
  assert.deepEqual(parseLine('LUX:120'), { type: 'lux', value: 120 });
  assert.deepEqual(parseLine('NET_STATUS:{"wifi":"connected","ip":"10.0.0.5","ble":"advertising"}'), {
    type: 'netStatus', status: { wifi: 'connected', ip: '10.0.0.5', ble: 'advertising' },
  });
  assert.equal(parseLine('NET_STATUS:{bad json').type, 'log');
});

test('new command builders', () => {
  assert.equal(cmd.alert('red', 30, 'Build: failed'), 'ALERT:red:30:Build failed');
  assert.equal(cmd.alert('blue'), 'ALERT:blue:0');
  assert.equal(cmd.alertOff(), 'ALERT:off');
  assert.equal(cmd.setAutodim(true, 10, 100, 5, 400), 'SET_AUTODIM:1:10:100:5:400');
  assert.equal(cmd.setAutodim(false, 10, 100), 'SET_AUTODIM:0:10:100');
  assert.equal(cmd.setGestures(true, 50), 'SET_GESTURES:1:200');
  assert.equal(cmd.setNet({ ssid: 'x' }), 'SET_NET:{"ssid":"x"}');
  assert.equal(cmd.setBle({ enabled: true, name: 'Deck' }), 'SET_BLE:{"enabled":true,"name":"Deck"}');
});

test('hold buttons run their hold action; BTN_HOLD without hold is ignored; hold flag goes to the device JSON', async () => {
  const calls: string[][] = [];
  const run: Runner = async (f, a) => void calls.push([f, ...a]);
  const cfg = defaultConfig();
  cfg.pages[0].buttons[0] = { label: 'x', action: { type: 'app', app: 'Notes' }, hold: { type: 'app', app: 'Terminal' } };
  const t = new FakeTransport();
  new Deck(t, cfg, new ActionExecutor(run), () => {});
  t.deck('BTN_HOLD:0:0'); t.deck('BTN_HOLD:0:1'); await tick();
  assert.deepEqual(calls, [['open', '-a', 'Terminal']]);
  assert.deepEqual(toDeviceButton(cfg.pages[0].buttons[0]), { label: 'x', showLabel: true, hold: true, type: 'app' });
});

test('device JSON carries media / ha / http fields for standalone use', () => {
  assert.equal(toDeviceButton({ action: { type: 'media', key: 'mute' } })!.media, 'mute');
  assert.deepEqual(toDeviceButton({ action: { type: 'ha', service: 'light.toggle', entity: 'light.x' } })!.ha, { service: 'light.toggle', entity: 'light.x' });
  assert.deepEqual(toDeviceButton({ action: { type: 'http', url: 'http://a', method: 'POST' } })!.http, { url: 'http://a', method: 'POST' });
});

test('alert action calls the injected alert handler', async () => {
  const seen: any[] = [];
  const ex = new ActionExecutor(async () => {}, () => {}, undefined, undefined, () => undefined, async (a) => void seen.push(a));
  await ex.execute({ type: 'alert', kind: 'red', seconds: 10, text: 'hi' });
  assert.deepEqual(seen, [{ type: 'alert', kind: 'red', seconds: 10, text: 'hi' }]);
});

test('start() does NOT heartbeat (stock firmware would never sleep); startHeartbeat() does', async () => {
  const t = new FakeTransport();
  const d = new Deck(t, defaultConfig(), new ActionExecutor(async () => {}), () => {});
  await d.start();
  assert.ok(!t.lines().includes('HB'));
  d.startHeartbeat(20);
  await tick(70);
  assert.ok(t.lines().filter((l) => l === 'HB').length >= 2);
  await d.close();
});

test('requestNetStatus resolves with the deck reply, or null when the firmware is too old', async () => {
  const t = new FakeTransport((data, self) => { if (String(data).trim() === 'GET_NET') self.deck('NET_STATUS:{"wifi":"connected","ble":"connected"}'); });
  const d = new Deck(t, defaultConfig(), new ActionExecutor(async () => {}), () => {});
  assert.equal((await d.requestNetStatus(500))?.ble, 'connected');
  assert.equal(d.net.wifi, 'connected');
  const old = new Deck(new FakeTransport(), defaultConfig(), new ActionExecutor(async () => {}), () => {});
  assert.equal(await old.requestNetStatus(60), null);
});

test('config validation: device block, schedule, sleep screens', () => {
  const c = defaultConfig();
  c.device = { address: 'smartdeck.local', token: 'abcd1234', host: 'smartdeck', standalone: 'auto', ble: { enabled: true, name: 'SmartDeck' }, autodim: { enabled: true, min: 10, max: 100 } };
  c.brightnessSchedule = [{ from: '22:00', to: '07:00', brightness: 15 }];
  c.sleepScreen = 'warp';
  validate(c);
  for (const bad of [{ token: 'short' }, { host: 'Bad Host' }, { address: 'a b' }, { standalone: 'x' }, { ble: { enabled: true, name: '' } }, { autodim: { enabled: true, min: 50, max: 10 } }])
    assert.throws(() => validate({ ...c, device: { ...c.device, ...bad } as any }), undefined, JSON.stringify(bad));
  assert.throws(() => validate({ ...c, brightnessSchedule: [{ from: '25:00', to: '07:00', brightness: 5 }] }), /HH:MM/);
  assert.throws(() => validate({ ...c, sleepScreen: 'nope' as any }), /sleepScreen/);
});

/** Tiny fake deck: v4 handshake, then echoes lines. */
function fakeDeck(token: string) {
  const server = net.createServer((s) => {
    let buf = '', authed = false;
    const drain = () => { let i: number; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); s.write(`ECHO:${line}\n`); } };
    const hs = serveHandshake(s, token, (rest) => { authed = true; s.write('PONG_DECK:Fake\n'); buf = rest; drain(); });
    s.on('data', (d) => { if (!authed) { hs(d.toString()); return; } buf += d.toString(); drain(); });
  });
  return new Promise<{ port: number; close(): void }>((r) => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })));
}

test('TcpTransport: AUTH ok, line framing, bytes sent after AUTH_OK are not lost', async () => {
  const f = await fakeDeck('secret-token');
  try {
    const t = await TcpTransport.connect(`127.0.0.1:${f.port}`, 'secret-token');
    const lines: string[] = [];
    t.on('line', (l) => lines.push(l));
    await t.write('HELLO\n');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(lines, ['PONG_DECK:Fake', 'ECHO:HELLO']);
    await t.close();
  } finally { f.close(); }
});

test('TcpTransport: wrong token and refused connection reject', async () => {
  const f = await fakeDeck('right-token');
  try {
    await assert.rejects(TcpTransport.connect(`127.0.0.1:${f.port}`, 'wrong-token'), /rejected the token/);
  } finally { f.close(); }
  await assert.rejects(TcpTransport.connect('127.0.0.1:1', 'x', 500));
});

test('TcpTransport: an impostor that answers AUTH_OK with a wrong proof is rejected (the deck must prove the token too)', async () => {
  const server = net.createServer((s) => { s.write('CHALLENGE:00112233445566778899aabbccddeeff\n'); s.once('data', () => s.write('AUTH_OK:' + '0'.repeat(64) + '\n')); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await assert.rejects(TcpTransport.connect(`127.0.0.1:${(server.address() as net.AddressInfo).port}`, 'right-token-1'), /impostor|could not prove/);
  } finally { server.close(); }
});

test('TcpTransport: the token is never sent, only an HMAC of the nonce; malformed challenges are refused', async () => {
  const seen: string[] = [];
  const server = net.createServer((s) => { s.write('CHALLENGE:00112233445566778899aabbccddeeff\n'); s.on('data', (d) => seen.push(d.toString())); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await assert.rejects(TcpTransport.connect(`127.0.0.1:${port}`, 'secret-token-xyz', 300)); // no AUTH_OK => times out
    const line = seen.join('').trim();
    assert.match(line, /^AUTH:[0-9a-f]{64}$/);
    assert.ok(!line.includes('secret-token-xyz'));
  } finally { server.close(); }
  const bad = net.createServer((s) => s.write('CHALLENGE:short\n'));
  await new Promise<void>((r) => bad.listen(0, '127.0.0.1', () => r()));
  try { await assert.rejects(TcpTransport.connect(`127.0.0.1:${(bad.address() as net.AddressInfo).port}`, 'secret-token-xyz'), /unexpected reply/); } finally { bad.close(); }
});
