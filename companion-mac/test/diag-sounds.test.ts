import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiagCollector, makeCpuMeter, parseDf, parseNetstat, parseVmStat } from '../src/diag.js';
import { cmd } from '../src/protocol.js';
import { resolveSound, SoundPlayer, SOUNDS_DIR } from '../src/sounds.js';
import { ActionExecutor, Runner } from '../src/actions.js';
import { defaultConfig, validate } from '../src/config.js';
import { Deck } from '../src/deck.js';
import { FakeTransport, tick } from './helpers.js';

const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                          150000.
Pages wired down:                         50000.
Pages occupied by compressor:             50000.
`;

test('parseVmStat: (active+wired+compressed)*pagesize / total', () => {
  // (200000+50000+50000)*16384 = 4.9152e9 ; total 16 GiB = 17179869184 -> 29%
  assert.equal(parseVmStat(VM, 17179869184), 29);
  assert.equal(parseVmStat('garbage', 1000), null);
  assert.equal(parseVmStat(VM, 1), 100); // clamped
});

test('parseDf reads the capacity column', () => {
  const df = 'Filesystem   1024-blocks      Used Available Capacity iused ifree %iused  Mounted on\n/dev/disk3s1s1   971350180 11264720 497000000     3%  356000 4975000000    0%   /\n';
  assert.equal(parseDf(df), 3);
  assert.equal(parseDf(''), null);
});

const NS = `Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0   16384 <Link#1>                        1000     0     500000     1000     0     500000     0
en0   1500  <Link#6>    aa:bb:cc:dd:ee:ff  5000     0  100000000     4000     0   20000000     0
en0   1500  192.168.1     192.168.1.5        5000     -  100000000     4000     -   20000000     -
en1   1500  <Link#7>    aa:bb:cc:dd:ee:00   10     0       2048       20     0       4096     0
utun0 1380  <Link#9>                         999     0     999999      999     0     999999     0
`;

test('parseNetstat sums physical en* links once, ignoring lo0/utun/duplicate rows', () => {
  assert.deepEqual(parseNetstat(NS), { rx: 100000000 + 2048, tx: 20000000 + 4096 });
});

test('DiagCollector computes KB/s from successive samples and tolerates failing tools', async () => {
  let ns = NS;
  let t = 0;
  const capture = async (f: string) => (f === 'netstat' ? ns : f === 'vm_stat' ? VM : 'h\nx 1 1 1 42% 1 1 1% /\n');
  const c = new DiagCollector(capture, () => 17, () => t);
  const first = await c.sample();
  assert.equal(first.rx, 0);
  assert.equal(first.disk, 42);
  assert.equal(first.cpu, 17);
  ns = NS.replace('100000000', '100102400'); // +102400 bytes = 100 KiB
  t = 2000; // 2 s -> 50 KB/s
  assert.equal(Math.round((await c.sample()).rx), 50);
  const broken = new DiagCollector(async () => { throw new Error('nope'); }, () => 0);
  const s = await broken.sample();
  assert.equal(s.disk, 0);
  assert.ok(s.mem >= 0 && s.mem <= 100);
});

test('cpu meter reports busy percent between calls', () => {
  let a = [{ idle: 100, total: 200 }];
  const m = makeCpuMeter(() => a);
  a = [{ idle: 150, total: 300 }];
  assert.equal(m(), 50);
});

test('DIAG command format is sanitised and clamped', () => {
  assert.equal(
    cmd.diag({ cpu: 140, mem: 33.4, disk: -2, rx: 12.6, tx: 0, uptimeMin: 90.2, host: "Mark's:Mac Pro!" }),
    'DIAG:100:33:0:13:0:90:MarksMacPro',
  );
  assert.equal(cmd.setSleepScreen('diag'), 'SET_SLEEP_SCREEN:diag');
});

test('built-in sound files exist and resolve; unknown / relative / missing do not', () => {
  for (const n of ['chirp', 'confirm', 'error', 'blip']) assert.ok(resolveSound(n)?.endsWith(`${n}.wav`), n);
  assert.equal(resolveSound('none'), null);
  assert.equal(resolveSound(undefined), null);
  assert.equal(resolveSound('../../etc/passwd'), null);
  assert.equal(resolveSound('/nonexistent/x.wav'), null);
  const d = mkdtempSync(join(tmpdir(), 'snd-'));
  writeFileSync(join(d, 'mine.wav'), 'x');
  assert.equal(resolveSound(join(d, 'mine.wav')), join(d, 'mine.wav'));
  assert.ok(SOUNDS_DIR.endsWith('sounds'));
});

test('SoundPlayer: afplay with volume, none = silent, honours live config', () => {
  const calls: string[][] = [];
  const run: Runner = async (f, a) => void calls.push([f, ...a]);
  const cfg = defaultConfig();
  const p = new SoundPlayer(() => cfg, run);
  p.play('press'); assert.equal(calls.length, 0); // default config: no sounds
  cfg.sounds = { press: 'chirp', error: 'error', volume: 25 };
  p.play('press'); p.play('error');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'afplay'); assert.equal(calls[0][2], '0.25');
  assert.match(calls[1][3], /error\.wav$/);
  cfg.sounds.press = 'none'; p.play('press'); assert.equal(calls.length, 2);
});

test('Deck plays press feedback, and error feedback when the action fails', async () => {
  const seen: string[] = [];
  const run: Runner = async (_f, a) => { if (a.includes('Google Chrome')) throw new Error('boom'); };
  const t = new FakeTransport();
  new Deck(t, defaultConfig(), new ActionExecutor(run), () => {}, undefined, (k) => seen.push(k));
  t.deck('BTN:0:0'); // Chrome -> fails
  t.deck('BTN:0:1'); // iTerm -> ok
  await tick();
  assert.deepEqual(seen, ['press', 'press', 'error']); // error arrives after the async failure
});

test('config validation for sleepScreen and sounds.volume', () => {
  const c = defaultConfig();
  c.sleepScreen = 'diag'; c.sounds = { press: 'chirp', volume: 100 };
  validate(c);
  assert.throws(() => validate({ ...c, sleepScreen: 'nope' as any }), /sleepScreen/);
  assert.throws(() => validate({ ...c, sounds: { volume: 101 } }), /volume/);
});
