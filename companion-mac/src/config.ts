import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { Action } from './actions.js';

export interface ButtonStyle {
  label?: string;
  labelSize?: number;
  labelColor?: string; // hex without '#', e.g. "ffffff"
  btnColor?: string;
  icon?: string; // jpg filename on the SD card (see `icons/` upload)
}

export type WidgetSource = 'clock' | 'cpu' | 'memory' | 'nowplaying' | 'ha_state' | 'http_json' | 'moonraker';

/** A button whose label/colour is refreshed live from a data source. */
export interface Widget {
  source: WidgetSource;
  /** Seconds between refreshes. Minimum 10: every change rewrites the deck's SD card. */
  interval?: number;
  /** Template, `{value}` is replaced. e.g. "CPU {value}%" */
  format?: string;
  entity?: string; // ha_state
  url?: string; // http_json / moonraker base URL
  jsonPath?: string; // http_json: dot path e.g. "data.temp"
  /** Highest matching threshold wins; numeric values only. */
  thresholds?: Array<{ above: number; color: string }>;
}

export interface Button extends ButtonStyle {
  action: Action;
  widget?: Widget;
}

export interface KnobConfig {
  cw: Action;
  ccw: Action;
  /** Raw encoder units (of 4096/rev) per step. Smaller = more sensitive. */
  step: number;
  /** Flip direction if the knob feels backwards. */
  invert?: boolean;
  led?: { r: number; g: number; b: number; tail: number };
}

export interface Config {
  title: string;
  grid: { cols: number; rows: number };
  theme: { bg_color: string; btn_color: string; text_color: string; stroke_color: string; shadow_color: string };
  brightness: number;
  knob: KnobConfig;
  pages: Array<{ name: string; buttons: Array<Button | null> }>;
  /** Deck power behaviour (firmware SET_SLEEP / SET_DEEP_SLEEP / SET_DIM_LED / SET_LED_BRIGHTNESS). */
  power?: { sleepMinutes?: number; deepSleepMinutes?: number; dimLed?: string; ledBrightness?: number };
  weather?: { lat: number; lon: number; celsius?: boolean; city?: string };
  /** Switch deck page when this macOS app (by name) is frontmost. page is 0-based. */
  appPages?: Array<{ app: string; page: number }>;
  integrations?: {
    homeassistant?: { url: string; token?: string; tokenEnv?: string };
  };
  ui?: { port?: number };
}

export const defaultConfig = (): Config => ({
  title: 'Smart Deck',
  grid: { cols: 4, rows: 3 },
  theme: { bg_color: '0f0f0f', btn_color: '1a1a2e', text_color: 'ffffff', stroke_color: '4a4a6a', shadow_color: '000000' },
  brightness: 80,
  knob: {
    cw: { type: 'media', key: 'volume_up' },
    ccw: { type: 'media', key: 'volume_down' },
    step: 60,
    led: { r: 217, g: 70, b: 239, tail: 7 },
  },
  pages: [
    {
      name: 'Main',
      buttons: [
        { label: 'Safari', action: { type: 'app', app: 'Safari' } },
        { label: 'Terminal', action: { type: 'app', app: 'Terminal' } },
        { label: 'VS Code', action: { type: 'app', app: 'Visual Studio Code' } },
        { label: 'Mute', action: { type: 'media', key: 'mute' } },
        { label: 'Play/Pause', action: { type: 'media', key: 'play_pause' } },
        { label: 'Prev', action: { type: 'media', key: 'previous' } },
        { label: 'Next', action: { type: 'media', key: 'next' } },
        { label: 'Screenshot', action: { type: 'key', combo: 'cmd+shift+4' } },
        { label: 'Lock', action: { type: 'key', combo: 'ctrl+cmd+q' } },
        { label: 'Mission Ctrl', action: { type: 'key', combo: 'ctrl+up' } },
        { label: 'GitHub', action: { type: 'website', url: 'https://github.com' } },
        { label: 'Page 2', action: { type: 'goto', page: 2 } },
      ],
    },
    { name: 'Page 2', buttons: [{ label: 'Back', action: { type: 'goto', page: 1 } }] },
  ],
});

export function configPath(): string {
  if (process.env.SMARTDECK_CONFIG) return process.env.SMARTDECK_CONFIG;
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'SmartDeckMac')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'smartdeck-mac');
  return join(base, 'config.json');
}

export function loadConfig(path = configPath()): Config {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  return validate({ ...defaultConfig(), ...parsed });
}

export function writeDefaultConfig(path = configPath()): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(defaultConfig(), null, 2) + '\n', { mode: 0o600 });
  return true;
}

export function validate(c: Config): Config {
  if (!Number.isInteger(c.grid.cols) || !Number.isInteger(c.grid.rows) || c.grid.cols < 1 || c.grid.rows < 1)
    throw new Error('grid.cols and grid.rows must be positive integers');
  if (!Array.isArray(c.pages) || c.pages.length === 0) throw new Error('config needs at least one page');
  const cells = c.grid.cols * c.grid.rows;
  c.pages.forEach((p, i) => {
    if (p.buttons.length > cells)
      throw new Error(`page ${i} has ${p.buttons.length} buttons but the grid only has ${cells} cells`);
  });
  if (!(c.knob.step > 0)) throw new Error('knob.step must be > 0');
  return c;
}

/** Look up the button for a (0-based page, index) pair reported by the deck. */
export function findButton(c: Config, page: number, index: number): Button | null {
  return c.pages[page]?.buttons[index] ?? null;
}

/** Convert one host button to the JSON object the firmware stores in esp_config.json. */
export function toDeviceButton(b: Button | null): Record<string, unknown> | null {
  if (!b) return null;
  const out: Record<string, unknown> = {};
  if (b.label !== undefined) out.label = b.label;
  if (b.labelSize !== undefined) out.labelSize = b.labelSize;
  if (b.labelColor !== undefined) out.labelColor = b.labelColor;
  if (b.btnColor !== undefined) out.btnColor = b.btnColor;
  if (b.icon !== undefined) out.icon = b.icon;
  const a = b.action;
  out.type = a.type;
  switch (a.type) {
    case 'key': out.combo = a.combo; break;
    case 'text': out.text = a.text; break;
    case 'goto': out.page = a.page; break;
    case 'timer': out.duration = a.duration; break;
    case 'counter':
      out.counterStartValue = a.counterStartValue ?? 0;
      out.counterAction = a.counterAction ?? 'increment';
      break;
    case 'toggle': if (a.onColor) out.toggleData = { onColor: a.onColor }; break;
    case 'http': out.http = { url: a.url }; break;
  }
  return out;
}

/** Build the full esp_config.json document the firmware reads from SD. */
export function toDeviceConfig(c: Config): object {
  return {
    title: c.title,
    grid: c.grid,
    theme: c.theme,
    pages: c.pages.map((p) => ({ name: p.name, buttons: p.buttons.map(toDeviceButton) })),
  };
}
