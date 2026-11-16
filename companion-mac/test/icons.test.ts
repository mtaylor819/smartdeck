import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { listIcons, safeIconName, saveIcon, saveIconifyIcon, searchIconify, FetchLike } from '../src/icons.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'sd-icons-'));
const png = (w = 300, h = 200) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();

test('safeIconName sanitises and always yields .jpg', () => {
  assert.equal(safeIconName('My Icon.png'), 'My_Icon.jpg');
  assert.equal(safeIconName('../../etc/passwd'), '_.._etc_passwd.jpg'.replace('_.._', '_.._'));
  assert.throws(() => safeIconName(''), /invalid/);
  assert.throws(() => safeIconName('...'), /invalid/);
});

test('saveIcon converts any image to a 110x110 JPEG', async () => {
  const dir = tmp();
  const file = await saveIcon(dir, 'wide', await png(), '1a1a2e');
  assert.equal(file, 'wide.jpg');
  const meta = await sharp(readFileSync(join(dir, file))).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 110);
  assert.equal(meta.height, 110);
  assert.deepEqual(listIcons(dir), ['wide.jpg']);
});

test('saveIcon rejects non-images and bad colours', async () => {
  await assert.rejects(saveIcon(tmp(), 'x', Buffer.from('not an image')));
  await assert.rejects(saveIcon(tmp(), 'x', await png(), 'zzzzzz'), /colour/);
});

const svgFetch = (calls: string[]): FetchLike => async (url) => {
  calls.push(url);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#fff"/></svg>';
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(svg), json: async () => ({ icons: ['mdi:home', 'bad id', '../x:y'] }) };
};

test('iconify: validates id, only fetches api.iconify.design', async () => {
  const dir = tmp();
  const calls: string[] = [];
  for (const bad of ['mdi:home/../x', 'http://evil.com/a:b', 'MDI:home', 'mdi', '']) {
    await assert.rejects(saveIconifyIcon(dir, { id: bad }, svgFetch(calls)), /invalid iconify id/);
  }
  assert.equal(calls.length, 0);
  const file = await saveIconifyIcon(dir, { id: 'mdi:home', color: 'ffffff', bg: '1a1a2e' }, svgFetch(calls));
  assert.equal(file, 'mdi-home.jpg');
  assert.match(calls[0], /^https:\/\/api\.iconify\.design\/mdi\/home\.svg\?color=%23ffffff/);
  const meta = await sharp(readFileSync(join(dir, file))).metadata();
  assert.equal(meta.width, 110);
  assert.ok(existsSync(join(dir, file)));
});

test('iconify search keeps only well-formed ids', async () => {
  assert.deepEqual(await searchIconify('home', svgFetch([])), ['mdi:home']);
  assert.deepEqual(await searchIconify('  ', svgFetch([])), []);
});
