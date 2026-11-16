import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export const ICON_SIZE = 110;
export const ICON_FILE_RE = /^[A-Za-z0-9._-]+\.jpe?g$/i;
export const ICONIFY_ID_RE = /^[a-z0-9-]+:[a-z0-9-]+$/;
const HEX6 = /^[0-9a-fA-F]{6}$/;

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

/** Turn user input into a safe "<name>.jpg" filename, or throw. */
export function safeIconName(name: string): string {
  const base = name.replace(/\.(jpe?g|png|svg|webp|gif)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!base || base.length > 60) throw new Error('invalid icon name');
  const out = `${base}.jpg`;
  if (!ICON_FILE_RE.test(out)) throw new Error('invalid icon name');
  return out;
}

export function listIcons(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => ICON_FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
}

export function deleteIcon(dir: string, file: string): boolean {
  if (!ICON_FILE_RE.test(file)) throw new Error('invalid icon name');
  try {
    unlinkSync(join(dir, file));
    return true;
  } catch {
    return false;
  }
}

function bg(hex: string | undefined): string {
  const h = (hex ?? '1a1a2e').replace(/^#/, '');
  if (!HEX6.test(h)) throw new Error('invalid colour');
  return `#${h}`;
}

/** Convert any sharp-readable image to a 110x110 cover-cropped JPG on a solid background. */
export async function saveIcon(dir: string, name: string, data: Buffer, bgHex?: string): Promise<string> {
  const file = safeIconName(name);
  const jpg = await sharp(data, { limitInputPixels: 50_000_000 })
    .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover', background: bg(bgHex) })
    .flatten({ background: bg(bgHex) })
    .jpeg({ quality: 90 })
    .toBuffer();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), jpg);
  return file;
}

/** Fetch an Iconify SVG (api.iconify.design only) and save it as an icon. */
export async function saveIconifyIcon(
  dir: string,
  opts: { id: string; color?: string; bg?: string; name?: string },
  fetchImpl: FetchLike,
): Promise<string> {
  if (!ICONIFY_ID_RE.test(opts.id)) throw new Error('invalid iconify id');
  const [set, icon] = opts.id.split(':');
  const colour = (opts.color ?? 'ffffff').replace(/^#/, '');
  if (!HEX6.test(colour)) throw new Error('invalid colour');
  const url = `https://api.iconify.design/${set}/${icon}.svg?color=%23${colour}&height=80`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`iconify returned ${res.status}`);
  const svg = Buffer.from(await res.arrayBuffer());
  if (svg.length > 500_000) throw new Error('icon too large');
  // The deck draws the button label along the bottom edge, so keep the glyph in the upper part of the tile.
  const GLYPH = 64;
  const glyph = await sharp(svg, { density: 300 }).resize(GLYPH, GLYPH, { fit: 'inside' }).png().toBuffer();
  const canvas = await sharp({ create: { width: ICON_SIZE, height: ICON_SIZE, channels: 3, background: bg(opts.bg) } })
    .composite([{ input: glyph, left: Math.round((ICON_SIZE - GLYPH) / 2), top: 10 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  const file = safeIconName(opts.name || `${set}-${icon}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), canvas);
  return file;
}

export async function searchIconify(q: string, fetchImpl: FetchLike): Promise<string[]> {
  if (!q.trim() || q.length > 60) return [];
  const res = await fetchImpl(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=48`);
  if (!res.ok) throw new Error(`iconify returned ${res.status}`);
  const j = (await res.json()) as { icons?: unknown };
  return Array.isArray(j.icons) ? j.icons.filter((i): i is string => typeof i === 'string' && ICONIFY_ID_RE.test(i)) : [];
}
