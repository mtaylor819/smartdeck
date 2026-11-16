import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { Action } from './actions.js';
import { validateTriggers } from './triggers.js';

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

/** Show a Home Assistant entity's state on the button itself (polled by the deck when standalone, by the Mac otherwise). */
export interface HaStateDisplay {
  entity: string;
  on?: string; off?: string; // 6-hex button colours
  label_on?: string; label_off?: string;
  interval?: number; // seconds, min 5, default 10
}

/** Turn an external event into an LED-ring alert on the deck. Implemented in triggers.ts. */
export interface TriggerConfig {
  name: string;
  enabled?: boolean;
  source:
    | { type: 'moonraker'; url: string; on: 'finished' | 'error' | 'finished_or_error' }
    | { type: 'ha_state'; entity: string; equals?: string; notEquals?: string }
    | { type: 'http_json'; url: string; jsonPath: string; op: '>' | '<' | '==' | '!=' | 'contains'; value: string | number }
    | { type: 'github'; repo: string; tokenEnv?: string }
    | { type: 'command'; command: string; on?: 'nonzero' | 'output'; match?: string };
  alert: { kind: 'red' | 'yellow' | 'blue' | 'green'; seconds?: number; text?: string };
  interval?: number; // poll seconds, default 30, min 10
  cooldownMin?: number; // minutes before it may fire again, default 5
}

export interface Button extends ButtonStyle {
  action: Action;
  /** Optional second action run on a long press (the deck then sends BTN_HOLD instead of BTN). */
  hold?: Action;
  widget?: Widget;
  haState?: HaStateDisplay;
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
  /** The deck itself: how to reach it over WiFi, and what it should do on its own (WiFi/BLE/standalone). */
  device?: DeviceConfig;
  /** Host-side day/night brightness (applied by the daemon each minute). Overnight ranges (22:00-07:00) work. */
  triggers?: TriggerConfig[];
  brightnessSchedule?: Array<{ from: string; to: string; brightness: number }>;
  /** Which screen the deck shows while asleep. 'diag' = starship-style system diagnostics (needs the updated firmware). */
  sleepScreen?: 'clock' | 'diag' | 'diag-anim' | 'warp';
  /** Mac-side audio feedback. press/error are a built-in name (chirp|confirm|error|blip), an absolute file path, or 'none'. */
  sounds?: { press?: string; error?: string; volume?: number };
}

export interface DeviceConfig {
  /** WiFi address of the deck, e.g. "smartdeck.local" or "192.168.1.50" (TCP 7778). Used when no USB deck is found. */
  address?: string;
  /** Shared secret for the WiFi link and OTA. 8-64 chars. */
  token?: string;
  host?: string; // mDNS name the deck advertises (default "smartdeck")
  wifi?: { ssid: string; password?: string };
  tz?: string; // POSIX TZ, e.g. "GMT0BST,M3.5.0/1,M10.5.0/2"
  standalone?: 'auto' | 'always' | 'never';
  ble?: { enabled: boolean; name?: string; /** names of the 3 host slots */ slots?: string[] };
  /** Home Assistant the *deck* talks to directly when standalone. */
  ha?: { url: string; token?: string };
  autodim?: { enabled: boolean; min: number; max: number; luxLow?: number; luxHigh?: number };
  gestures?: { swipe: boolean; holdMs?: number };
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
        { label: 'Chrome', action: { type: 'app', app: 'Google Chrome' } },
        { label: 'iTerm2', action: { type: 'app', app: 'iTerm' } },
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
  if (c.sleepScreen !== undefined && !['clock', 'diag', 'diag-anim', 'warp'].includes(c.sleepScreen))
    throw new Error("sleepScreen must be 'clock', 'diag', 'diag-anim' or 'warp'");
  const d = c.device;
  if (d) {
    if (d.token !== undefined && !/^[\x21-\x7e]{8,64}$/.test(d.token)) throw new Error('device.token must be 8-64 printable characters');
    if (d.host !== undefined && !/^[a-z0-9-]{1,32}$/.test(d.host)) throw new Error('device.host must be lowercase letters, digits or dashes');
    if (d.address !== undefined && !/^[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/.test(d.address)) throw new Error('device.address must be a hostname or IP (optional :port)');
    if (d.standalone !== undefined && !['auto', 'always', 'never'].includes(d.standalone)) throw new Error('device.standalone must be auto, always or never');
    if (d.ble?.name !== undefined && !/^[\x20-\x7e]{1,24}$/.test(d.ble.name)) throw new Error('device.ble.name must be 1-24 printable characters');
    if (d.autodim && !(d.autodim.min >= 0 && d.autodim.max <= 100 && d.autodim.min <= d.autodim.max)) throw new Error('device.autodim needs 0 <= min <= max <= 100');
  }
  if (d?.ble?.slots !== undefined) {
    if (!Array.isArray(d.ble.slots) || d.ble.slots.length < 1 || d.ble.slots.length > 3 || d.ble.slots.some((n) => typeof n !== 'string' || !/^[\x20-\x7e]{1,12}$/.test(n)))
      throw new Error('device.ble.slots must be 1-3 names of 1-12 printable characters');
  }
  c.pages.forEach((p, pi) => p.buttons.forEach((b, bi) => {
    if (b?.haState) {
      const h = b.haState;
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(h.entity ?? '')) throw new Error(`page ${pi + 1} button ${bi + 1}: haState.entity must look like light.desk`);
      for (const k of ['on', 'off'] as const) if (h[k] !== undefined && !/^[0-9a-fA-F]{6}$/.test(h[k]!)) throw new Error(`page ${pi + 1} button ${bi + 1}: haState.${k} must be 6 hex digits`);
      if (h.interval !== undefined && !(h.interval >= 5)) throw new Error(`page ${pi + 1} button ${bi + 1}: haState.interval must be >= 5 seconds`);
    }
    if (b?.action?.type === 'blehost' && ![1, 2, 3, 'next'].includes(b.action.slot as any)) throw new Error(`page ${pi + 1} button ${bi + 1}: blehost slot must be 1, 2, 3 or next`);
  }));
  if (c.triggers !== undefined) validateTriggers(c.triggers);
  for (const r of c.brightnessSchedule ?? []) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.to)) throw new Error('brightnessSchedule times must be HH:MM');
    if (!(r.brightness >= 0 && r.brightness <= 100)) throw new Error('brightnessSchedule brightness must be 0-100');
  }
  const v = c.sounds?.volume;
  if (v !== undefined && !(v >= 0 && v <= 100)) throw new Error('sounds.volume must be 0-100');
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
  if (b.hold) out.hold = true;
  if (b.haState) out.ha_state = b.haState;
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
    case 'http': out.http = { url: a.url, ...(a.method ? { method: a.method } : {}), ...(a.body ? { body: a.body } : {}), ...(a.headers ? { headers: a.headers } : {}) }; break;
    case 'media': out.media = a.key; break;
    case 'blehost': out.slot = a.slot; break;
    case 'ha': out.ha = { service: a.service, ...(a.entity ? { entity: a.entity } : {}), ...(a.data ? { data: a.data } : {}) }; break;
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
