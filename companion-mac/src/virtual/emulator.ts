// Software emulation of the SmartDeck firmware's host protocol and button/touch behaviour.
// Socket-free: feed() bytes in, 'out' events carry bytes the deck would send. See PROTOCOL.md and
// JC8048W550/Arduino/smart_deck/smart_deck.ino (reply strings are copied from the firmware).
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SleepScreen = 'clock' | 'diag' | 'diag-anim' | 'warp';
export const SLEEP_SCREENS: SleepScreen[] = ['clock', 'diag', 'diag-anim', 'warp'];
export const ALERT_KINDS = ['red', 'yellow', 'blue', 'green'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const DIM_LED_NAMES = ['off', 'breathing', 'rainbow', 'pulse', 'comet', 'sparkle'];
/** Capabilities advertised in NET_STATUS (PROTOCOL.md v3). */
export const CAPS = ['btn_live', 'ha_state', 'ble_hosts'];
export const BLE_SLOTS = 3;
/** RAM-only visual override for one button (SET_BTN_LIVE). Never written to the SD card. */
export interface LiveOverride { label?: string; labelColor?: string; btnColor?: string; labelSize?: number; icon?: string }

export interface DeckConfig {
  title?: string;
  grid?: { cols?: number; rows?: number };
  theme?: Partial<Record<'bg_color' | 'btn_color' | 'text_color' | 'stroke_color' | 'shadow_color', string>>;
  pages: Array<{ name?: string; buttons: Array<Record<string, any> | null> }>;
}

export interface VirtualDeckState {
  name: string;
  config: DeckConfig;
  configError: string | null;
  page: number;
  brightness: number;
  sleepScreen: SleepScreen;
  sleep: { enabled: boolean; minutes: number; deepEnabled: boolean; deepMinutes: number; sleeping: boolean; deepSleeping: boolean; lastActivity: number; dimStart: number };
  dimLed: number;
  led: { r: number; g: number; b: number; tail: number; brightness: number };
  knobRaw: number;
  clock: { set: boolean; h: number; m: number; s: number; setAt: number };
  weather: { temp: number; code: number; isDay: boolean; celsius: boolean; desc: string; city: string } | null;
  diag: { cpu: number; mem: number; disk: number; rx: number; tx: number; uptimeMin: number; host: string; at: number } | null;
  /** Non-secret view of provisioning. Secrets live in a private field and are never exposed. */
  net: { ssid: string; host: string; standalone: 'auto' | 'always' | 'never'; wifi: boolean; tz: string; hasPass: boolean; hasToken: boolean; hasHaUrl: boolean; hasHaToken: boolean };
  ble: { enabled: boolean; name: string; peer: string; slot: number; slots: string[]; bonds: boolean[] };
  /** SET_BTN_LIVE overrides keyed "page:idx" (insertion order = age). RAM only: lost on reboot, never persisted. */
  live: Record<string, LiveOverride>;
  /** Brief on-screen message, e.g. "BT: Work PC". */
  toast: { text: string; until: number } | null;
  /** Last on-deck Home Assistant poll results per entity (non-secret). */
  haState: Record<string, { state: string; at: number }>;
  alert: { kind: AlertKind; text: string; until: number; startedAt: number } | null;
  autodim: { enabled: boolean; min: number; max: number; luxLow: number; luxHigh: number; sensor: boolean; lux: number };
  gestures: { swipe: boolean; holdMs: number };
  toggles: Record<string, boolean>;
  counters: Record<string, number>;
  timers: Record<string, { duration: number; startedAt: number }>;
  hostLastSeen: number;
  upload: { active: boolean; file: string; remaining: number };
  rebooting: boolean;
  lastTime: number;
  log: string[];
}

export interface EmulatorOptions {
  name?: string;
  dataDir: string;
  now?: () => number;
  log?: (m: string) => void;
  /** Initial host-link token (the TCP layer asks currentToken(); SET_NET can replace it). */
  token?: string;
  luxSensor?: boolean;
  uploadTimeoutMs?: number;
  dataTimeoutMs?: number;
  /** Delay between DONE_REBOOT and the link dropping (firmware: ~600 ms), and total reboot duration. */
  rebootDelayMs?: number;
  bootMs?: number;
  cleanIcons?: boolean;
  /** fetch used for on-deck Home Assistant polling and standalone ha/http presses (tests may inject one). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (firmware: 3 s). */
  haTimeoutMs?: number;
  /** Delay before re-polling an entity after an `ha` button press (spec: ~700 ms). */
  haRepollMs?: number;
  /** Size of the live-override table (spec: at least 24; oldest dropped when full). */
  liveCapacity?: number;
}

const HOST_PRESENCE_MS = 15_000;
const SAFE_FILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HEX6 = /^[0-9a-fA-F]{6}$/;
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const SERVICE_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const LIVE_KEYS = ['label', 'labelColor', 'btnColor', 'labelSize', 'icon'] as const;
const HA_MAX_BUTTONS = 8;
const TOAST_MS = 2500;
const HA_UNAVAILABLE_COLOR = '3a3a3a';

/** Commands that do NOT count as user activity (mirror of the patched firmware + features.h modules). */
const NO_WAKE = ['HB', 'DIAG:', 'SET_BTN_DATA:', 'SET_TIME:', 'WEATHER:', 'SET_DIM_LED:', 'SET_SLEEP_SCREEN:', 'SET_NET:', 'GET_NET', 'SET_BLE:', 'SET_AUTODIM:', 'SET_GESTURES:', 'SET_BTN_LIVE:', 'BLE_HOST:'];

const defaultTheme = { bg_color: '000000', btn_color: '333333', text_color: 'ffffff', stroke_color: '555555', shadow_color: '000000' };

export function emptyConfig(title: string): DeckConfig {
  return { title, grid: { cols: 3, rows: 3 }, theme: { ...defaultTheme }, pages: [{ name: 'Page 1', buttons: [] }] };
}

export class DeckEmulator extends EventEmitter {
  readonly state: VirtualDeckState;
  private secrets: { pass?: string; token?: string; ha_token?: string; ha_url?: string } = {};
  private buf = Buffer.alloc(0);
  private up: { mode: 'off' | 'cmd' | 'data'; name: string; remaining: number; chunks: Buffer[]; lastCmd: number; lastData: number } =
    { mode: 'off', name: '', remaining: 0, chunks: [], lastCmd: 0, lastData: 0 };
  private lastKnobSent = -1000;
  private lastNetEmit = -1e9;
  private lastLux = -1;
  private lastLuxEmit = -1e9;
  private clients = () => 0;
  private haNext = new Map<string, number>();
  private haChain: Promise<void> = Promise.resolve();
  private tasks = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private readonly o: Required<Omit<EmulatorOptions, 'token' | 'name'>> & { token?: string; name: string };

  constructor(opts: EmulatorOptions) {
    super();
    this.o = {
      name: opts.name ?? 'Smart Deck',
      dataDir: opts.dataDir,
      now: opts.now ?? Date.now,
      log: opts.log ?? (() => {}),
      token: opts.token,
      luxSensor: opts.luxSensor ?? true,
      uploadTimeoutMs: opts.uploadTimeoutMs ?? 60_000,
      dataTimeoutMs: opts.dataTimeoutMs ?? 10_000,
      rebootDelayMs: opts.rebootDelayMs ?? 500,
      bootMs: opts.bootMs ?? 1500,
      cleanIcons: opts.cleanIcons ?? true,
      fetchImpl: opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      haTimeoutMs: opts.haTimeoutMs ?? 3000,
      haRepollMs: opts.haRepollMs ?? 700,
      liveCapacity: opts.liveCapacity ?? 32,
    };
    this.now = this.o.now;
    mkdirSync(this.o.dataDir, { recursive: true });
    this.state = this.freshState();
    this.loadPrefs();
    this.loadConfig();
  }

  // ------------------------------------------------------------------ state / persistence
  private freshState(): VirtualDeckState {
    const t = this.now();
    return {
      name: this.o.name, config: emptyConfig(this.o.name), configError: 'no esp_config.json on SD', page: 0, brightness: 80,
      sleepScreen: 'clock',
      sleep: { enabled: false, minutes: 0, deepEnabled: false, deepMinutes: 30, sleeping: false, deepSleeping: false, lastActivity: t, dimStart: 0 },
      dimLed: 0, led: { r: 217, g: 70, b: 239, tail: 7, brightness: 255 }, knobRaw: 0,
      clock: { set: false, h: 0, m: 0, s: 0, setAt: 0 }, weather: null, diag: null,
      net: { ssid: '', host: 'smartdeck', standalone: 'auto', wifi: true, tz: '', hasPass: false, hasToken: false, hasHaUrl: false, hasHaToken: false },
      ble: { enabled: false, name: 'SmartDeck', peer: '', slot: 1, slots: ['Host 1', 'Host 2', 'Host 3'], bonds: [false, false, false] }, alert: null,
      live: {}, toast: null, haState: {},
      autodim: { enabled: false, min: 10, max: 100, luxLow: 5, luxHigh: 400, sensor: this.o.luxSensor, lux: 150 },
      gestures: { swipe: true, holdMs: 600 }, toggles: {}, counters: {}, timers: {},
      hostLastSeen: 0, upload: { active: false, file: '', remaining: 0 }, rebooting: false, lastTime: t, log: [],
    };
  }

  private prefsPath() { return join(this.o.dataDir, 'prefs.json'); }

  /** Preferences (NVS) equivalent. Contains secrets, so the file is 0600. */
  private savePrefs(): void {
    const s = this.state;
    const data = {
      brightness: s.brightness, sleepScreen: s.sleepScreen, sleep: { enabled: s.sleep.enabled, minutes: s.sleep.minutes, deepEnabled: s.sleep.deepEnabled, deepMinutes: s.sleep.deepMinutes },
      dimLed: s.dimLed, led: s.led, net: { ssid: s.net.ssid, host: s.net.host, standalone: s.net.standalone, wifi: s.net.wifi, tz: s.net.tz }, ble: { enabled: s.ble.enabled, name: s.ble.name, slot: s.ble.slot, slots: s.ble.slots, bonds: s.ble.bonds },
      autodim: { enabled: s.autodim.enabled, min: s.autodim.min, max: s.autodim.max, luxLow: s.autodim.luxLow, luxHigh: s.autodim.luxHigh }, gestures: s.gestures, secrets: this.secrets,
    };
    const f = this.prefsPath();
    writeFileSync(f + '.tmp', JSON.stringify(data), { mode: 0o600 });
    renameSync(f + '.tmp', f);
    try { chmodSync(f, 0o600); } catch { /* best effort */ }
  }

  private loadPrefs(): void {
    try {
      const d = JSON.parse(readFileSync(this.prefsPath(), 'utf8'));
      const s = this.state;
      if (typeof d.brightness === 'number') s.brightness = d.brightness;
      if (SLEEP_SCREENS.includes(d.sleepScreen)) s.sleepScreen = d.sleepScreen;
      Object.assign(s.sleep, d.sleep ?? {});
      if (typeof d.dimLed === 'number') s.dimLed = d.dimLed;
      Object.assign(s.led, d.led ?? {});
      Object.assign(s.net, d.net ?? {});
      const b = d.ble ?? {};
      if (typeof b.enabled === 'boolean') s.ble.enabled = b.enabled;
      if (typeof b.name === 'string') s.ble.name = b.name;
      if (Number.isInteger(b.slot) && b.slot >= 1 && b.slot <= BLE_SLOTS) s.ble.slot = b.slot;
      if (Array.isArray(b.slots) && b.slots.length === BLE_SLOTS && b.slots.every((x: unknown) => typeof x === 'string')) s.ble.slots = b.slots;
      if (Array.isArray(b.bonds) && b.bonds.length === BLE_SLOTS) s.ble.bonds = b.bonds.map(Boolean);
      Object.assign(s.autodim, d.autodim ?? {});
      Object.assign(s.gestures, d.gestures ?? {});
      this.secrets = d.secrets ?? {};
      this.syncNetFlags();
    } catch { /* first boot */ }
  }

  private syncNetFlags(): void {
    const n = this.state.net;
    n.hasPass = !!this.secrets.pass; n.hasToken = !!this.secrets.token; n.hasHaUrl = !!this.secrets.ha_url; n.hasHaToken = !!this.secrets.ha_token;
  }

  private configPath() { return join(this.o.dataDir, 'esp_config.json'); }

  loadConfig(): void {
    const s = this.state;
    try {
      const raw = readFileSync(this.configPath(), 'utf8');
      const cfg = JSON.parse(raw) as DeckConfig;
      if (!cfg || !Array.isArray(cfg.pages)) throw new Error('config has no "pages" array');
      s.config = cfg; s.configError = null;
    } catch (e) {
      if (!existsSync(this.configPath())) { s.config = emptyConfig(this.o.name); s.configError = 'no esp_config.json on SD'; }
      else s.configError = `deserializeJson() failed: ${e instanceof Error ? e.message : e}`;
    }
    if (s.page >= s.config.pages.length) s.page = 0;
  }

  private saveConfig(): boolean {
    try {
      const f = this.configPath();
      writeFileSync(f + '.tmp', JSON.stringify(this.state.config));
      renameSync(f + '.tmp', f);
      this.state.configError = null;
      return true;
    } catch { return false; }
  }

  // ------------------------------------------------------------------ link plumbing
  setClientCounter(fn: () => number): void { this.clients = fn; }
  /** Host-link token the TCP layer must check: SET_NET can replace the initial one. */
  currentToken(): string | undefined { return this.secrets.token ?? this.o.token; }
  /** Compose-able view for the TCP layer/tests (secrets stay inside). */
  hostActive(): boolean {
    const t = this.state.hostLastSeen;
    return t > 0 && this.now() - t < HOST_PRESENCE_MS;
  }

  private log(m: string): void {
    const line = `[${new Date(this.now()).toLocaleTimeString()}] ${m}`;
    this.state.log.push(line);
    if (this.state.log.length > 150) this.state.log.shift();
    this.o.log(m);
    this.emit('log', line);
  }

  /** Bytes the deck sends to the host. printf-style firmware lines end "\n", println-style "\r\n". */
  private out(line: string, crlf = true): void {
    this.emit('out', line + (crlf ? '\r\n' : '\n'));
  }

  private changed(): void { this.emit('change'); }

  // ------------------------------------------------------------------ activity / sleep
  wake(): void {
    const s = this.state;
    s.sleep.lastActivity = this.now();
    if (s.sleep.deepSleeping || s.sleep.sleeping) {
      s.sleep.deepSleeping = false;
      s.sleep.sleeping = false;
      this.resetToggles(s.page); // wake redraws the page via draw_page()
      this.haNext.clear(); // poll Home Assistant right away after waking
      this.changed();
    }
  }

  /** Time-based transitions. Called by an interval in production and manually by tests. */
  tick(): void {
    const s = this.state, t = this.now();
    const sl = s.sleep;
    if (sl.enabled && !sl.sleeping && !s.rebooting && t - sl.lastActivity > sl.minutes * 60_000) {
      sl.sleeping = true; sl.dimStart = t;
      if (!s.clock.set) this.out('GET_TIME'); // firmware asks for the time when entering sleep uninitialised
      this.changed();
    }
    if (sl.sleeping && sl.deepEnabled && !sl.deepSleeping && t - sl.dimStart > sl.deepMinutes * 60_000) {
      sl.deepSleeping = true; this.changed();
    }
    if (s.alert && s.alert.until > 0 && t >= s.alert.until) { s.alert = null; this.changed(); }
    if (s.toast && t >= s.toast.until) { s.toast = null; this.changed(); }
    this.haPollTick();
    // upload timeouts
    if (this.up.mode === 'data' && t - this.up.lastData > this.o.dataTimeoutMs) {
      this.out('ERR_DATA_TIMEOUT');
      this.closeUploadFile();
      this.up.mode = 'cmd'; this.up.lastCmd = t;
    } else if (this.up.mode === 'cmd' && t - this.up.lastCmd > this.o.uploadTimeoutMs) {
      this.out('ERR_TIMEOUT');
      this.finishUpload();
    }
  }

  /** Current wall clock of the deck (derived from the last SET_TIME). */
  clockNow(): { h: number; m: number; s: number } {
    const c = this.state.clock;
    if (!c.set) return { h: 0, m: 0, s: 0 };
    const total = (c.h * 3600 + c.m * 60 + c.s + Math.floor((this.now() - c.setAt) / 1000)) % 86400;
    return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
  }

  // ------------------------------------------------------------------ input from host
  feed(chunk: Buffer): void {
    if (this.state.rebooting) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.up.mode === 'data') {
        const take = Math.min(this.buf.length, this.up.remaining);
        if (take > 0) {
          this.up.chunks.push(Buffer.from(this.buf.subarray(0, take)));
          this.up.remaining -= take;
          this.state.upload.remaining = this.up.remaining;
          this.buf = this.buf.subarray(take);
          this.up.lastData = this.now();
        }
        if (this.up.remaining === 0) {
          this.closeUploadFile();
          this.out('OK_DATA');
          this.up.mode = 'cmd'; this.up.lastCmd = this.now();
          continue;
        }
        break;
      }
      const nl = this.buf.indexOf(10);
      if (nl < 0) {
        if (this.buf.length > 16384) this.buf = Buffer.alloc(0); // runaway line, drop
        break;
      }
      const line = this.buf.subarray(0, nl).toString('utf8').trim();
      this.buf = this.buf.subarray(nl + 1);
      if (this.up.mode === 'cmd') this.uploadCommand(line);
      else this.command(line);
    }
    this.changed();
  }

  // ------------------------------------------------------------------ upload (handleUsbUpload)
  private startUpload(): void {
    this.up = { mode: 'cmd', name: '', remaining: 0, chunks: [], lastCmd: this.now(), lastData: this.now() };
    this.state.upload = { active: true, file: '', remaining: 0 };
    this.out('READY');
  }

  private uploadCommand(cmd: string): void {
    this.up.lastCmd = this.now();
    if (cmd.startsWith('FILE:')) {
      const first = cmd.indexOf(':'), second = cmd.indexOf(':', first + 1);
      if (first === -1 || second === -1) return this.out('ERR_CMD_FORMAT');
      const name = cmd.slice(first + 1, second);
      const size = parseInt(cmd.slice(second + 1), 10) || 0; // Arduino String::toInt()
      if (size === 0) return this.out('ERR_FILE_SIZE');
      if (!SAFE_FILE_RE.test(name) || name.startsWith('.')) return this.out('ERR_FILE_CREATE');
      this.up.mode = 'data'; this.up.name = name; this.up.remaining = size; this.up.chunks = []; this.up.lastData = this.now();
      this.state.upload.file = name; this.state.upload.remaining = size;
      this.out('OK_FILE');
    } else if (cmd === 'END_UPLOAD') {
      this.finishUpload();
    } else {
      this.out('ERR_UNKNOWN_CMD');
    }
  }

  /** Writes whatever arrived (the SD card keeps partial files, like the firmware). */
  private closeUploadFile(): void {
    if (!this.up.name) return;
    try { writeFileSync(join(this.o.dataDir, this.up.name), Buffer.concat(this.up.chunks)); } catch { /* SD error */ }
    if (this.up.remaining > 0) this.out(`ERR_DATA_INCOMPLETE:${this.up.remaining}`, false);
    this.up.chunks = []; this.up.name = '';
  }

  private finishUpload(): void {
    this.up.mode = 'off';
    this.state.upload = { active: false, file: '', remaining: 0 };
    this.out('DONE_REBOOT');
    let ok = false;
    try { JSON.parse(readFileSync(this.configPath(), 'utf8')); ok = true; } catch { /* config missing/bad */ }
    if (ok && this.o.cleanIcons) this.cleanUnusedIcons();
    this.out('Rebooting...');
    this.reboot();
  }

  /** cleanUnusedIcons(): delete icon JPGs that no button references. */
  private cleanUnusedIcons(): void {
    try {
      const cfg = JSON.parse(readFileSync(this.configPath(), 'utf8')) as DeckConfig;
      const used = new Set<string>();
      for (const p of cfg.pages ?? []) for (const b of p.buttons ?? []) {
        if (!b) continue;
        for (const n of [b.icon, b.toggleData?.iconOn, b.toggleData?.iconOff]) if (typeof n === 'string') used.add(n.replace(/^\//, ''));
      }
      for (const f of readdirSync(this.o.dataDir)) if (/\.jpe?g$/i.test(f) && !used.has(f)) unlinkSync(join(this.o.dataDir, f));
    } catch { /* ignore */ }
  }

  /** Simulated ESP.restart(): link drops, then the deck boots again after bootMs. */
  reboot(): void {
    const s = this.state;
    setTimeout(() => {
      s.rebooting = true;
      this.buf = Buffer.alloc(0);
      this.emit('reboot');
      this.changed();
      const t = setTimeout(() => this.boot(), this.o.bootMs);
      t.unref?.();
    }, this.o.rebootDelayMs).unref?.();
  }

  private boot(): void {
    const s = this.state;
    s.rebooting = false; s.page = 0; s.alert = null; s.hostLastSeen = 0; s.toggles = {}; s.timers = {};
    s.live = {}; s.toast = null; s.haState = {}; this.haNext.clear(); // RAM-only state is lost on reboot
    s.sleep.sleeping = false; s.sleep.deepSleeping = false; s.sleep.lastActivity = this.now(); s.clock.set = false;
    this.up = { mode: 'off', name: '', remaining: 0, chunks: [], lastCmd: 0, lastData: 0 };
    this.loadConfig();
    this.log('boot complete');
    this.changed();
  }

  // ------------------------------------------------------------------ normal command chain
  command(line: string): void {
    if (!line) return;
    const s = this.state;
    s.hostLastSeen = this.now();
    if (line === 'HB') return;
    if (!NO_WAKE.some((p) => (p.endsWith(':') ? line.startsWith(p) : line === p))) this.wake();
    const arg = (prefix: string) => line.slice(prefix.length);
    const int = (v: string) => parseInt(v, 10) || 0;

    if (line === 'PING_DECK') return this.out(`PONG_DECK:${this.o.name}`);
    if (line === 'START_UPLOAD') return this.startUpload();
    if (line === 'GET_SYNC') return this.getSync();
    if (line === 'DUMP_CONFIG') {
      let raw: string | null = null;
      try { raw = readFileSync(this.configPath(), 'utf8'); } catch { /* none */ }
      if (raw === null) return this.out('CONFIG_ERROR:Cannot open file', false);
      this.out('CONFIG_START', false); this.emit('out', raw + '\r\n'); this.out('CONFIG_END', false);
      return;
    }
    if (line === 'GET_NET') return this.emitNetStatus(true);

    if (line.startsWith('SET_BRIGHTNESS:')) {
      const v = Math.max(0, Math.min(100, int(arg('SET_BRIGHTNESS:'))));
      s.brightness = v; this.savePrefs();
      return this.out(`Brightness set to ${v}%`, false);
    }
    if (line.startsWith('SET_SLEEP:')) {
      const m = int(arg('SET_SLEEP:'));
      if (m > 0) { s.sleep.enabled = true; s.sleep.minutes = m; this.savePrefs(); return this.out(`Sleep enabled: ${m} min (Timeout: ${m * 60000} ms)`, false); }
      s.sleep.enabled = false; s.sleep.deepEnabled = false; this.savePrefs();
      return this.out('Sleep disabled');
    }
    if (line.startsWith('SET_DEEP_SLEEP:')) {
      const m = int(arg('SET_DEEP_SLEEP:'));
      s.sleep.deepEnabled = m > 0; if (m > 0) s.sleep.deepMinutes = m; this.savePrefs();
      return m > 0 ? this.out(`Deep Sleep enabled: ${m} min after dim`, false) : this.out('Deep Sleep disabled');
    }
    if (line.startsWith('SET_DIM_LED:')) {
      const a = arg('SET_DIM_LED:').trim().toLowerCase();
      const idx = DIM_LED_NAMES.indexOf(a);
      s.dimLed = idx > 0 ? idx : 0; this.savePrefs();
      return this.out(`Dim LED animation set to: ${a} (${s.dimLed})`, false);
    }
    if (line.startsWith('SET_LED_BRIGHTNESS:')) {
      s.led.brightness = Math.max(0, Math.min(255, int(arg('SET_LED_BRIGHTNESS:')))); this.savePrefs();
      return this.out('LED_BRIGHTNESS_SET');
    }
    if (line.startsWith('SET_KNOB:')) {
      const p = arg('SET_KNOB:').split(':').map(int);
      if (p.length >= 4) { s.led.r = p[0]; s.led.g = p[1]; s.led.b = p[2]; s.led.tail = Math.max(1, Math.min(15, p[3])); this.savePrefs(); }
      return this.out('KNOB_CONFIG_UPDATED');
    }
    if (line.startsWith('SET_THEME:')) {
      const p = arg('SET_THEME:').split(':');
      if (p.length >= 5) {
        const th = (s.config.theme ??= {});
        const keys = ['bg_color', 'btn_color', 'text_color', 'stroke_color', 'shadow_color'] as const;
        keys.forEach((k, i) => { if (HEX6.test(p[i])) th[k] = p[i].toLowerCase(); });
        if (p.length >= 8) { s.led.r = int(p[5]); s.led.g = int(p[6]); s.led.b = int(p[7]); }
        this.savePrefs();
      }
      return this.out('THEME_UPDATED');
    }
    if (line.startsWith('SET_TIME:')) {
      const p = arg('SET_TIME:').split(':').map(int);
      if (p.length >= 2) {
        s.clock = { set: true, h: p[0] % 24, m: p[1] % 60, s: (p[2] ?? 0) % 60, setAt: this.now() };
        this.out(`TIME_SET:${String(s.clock.h).padStart(2, '0')}:${String(s.clock.m).padStart(2, '0')}:${String(s.clock.s).padStart(2, '0')}`, false);
        this.out('TIME_UPDATED');
      }
      return;
    }
    if (line.startsWith('SET_PAGE:')) {
      const p = int(arg('SET_PAGE:'));
      if (p >= 0 && p < s.config.pages.length) { this.gotoPage(p); this.out(`PAGE_CHANGED:${p}`, false); }
      return;
    }
    if (line.startsWith('SET_DEVICE_NAME:')) {
      s.config.title = arg('SET_DEVICE_NAME:'); this.saveConfig();
      return this.out(`DEVICE_NAME_SET:${s.config.title}`, false);
    }
    if (line.startsWith('SET_PAGE_NAME:')) {
      const rest = arg('SET_PAGE_NAME:'); const i = rest.indexOf(':');
      const p = int(rest.slice(0, i)); const name = rest.slice(i + 1);
      if (i > 0 && p >= 0 && p < s.config.pages.length) { s.config.pages[p].name = name; this.saveConfig(); return this.out(`PAGE_NAME_SET:${p}:${name}`, false); }
      return this.out(`PAGE_NAME_ERROR:${p}:Invalid page index`, false);
    }
    if (line.startsWith('SET_GRID:')) {
      const [c, r] = arg('SET_GRID:').split(':').map(int);
      if (c > 0 && r > 0) {
        s.config.grid = { cols: c, rows: r };
        this.out(this.saveConfig() ? 'CONFIG_SAVED:OK' : 'CONFIG_SAVED:FAIL', false);
        this.out(`GRID_CHANGED:${c}:${r}`, false);
      }
      return;
    }
    if (line.startsWith('CLEAR_BTN:')) {
      const [p, i] = arg('CLEAR_BTN:').split(':').map(int);
      const btns = s.config.pages[p]?.buttons;
      if (btns && i >= 0 && i < btns.length) { btns[i] = null; this.saveConfig(); return this.out(`BTN_CLEARED:${p}:${i}`, false); }
      return;
    }
    if (line.startsWith('SWAP_BTN:')) {
      const [p, a, b] = arg('SWAP_BTN:').split(':').map(int);
      const btns = s.config.pages[p]?.buttons;
      if (btns && a >= 0 && b >= 0 && a < btns.length && b < btns.length) { [btns[a], btns[b]] = [btns[b], btns[a]]; this.saveConfig(); return this.out('BTN_SWAPPED_OK'); }
      return this.out('BTN_SWAPPED_FAIL');
    }
    if (line.startsWith('SET_BTN_DATA:')) return this.setBtnData(line);
    if (line.startsWith('SET_BTN_LIVE:')) return this.setBtnLive(line);
    if (line.startsWith('BLE_HOST:')) return this.bleHostCmd(arg('BLE_HOST:').trim());
    if (line.startsWith('WEATHER:')) return this.weather(arg('WEATHER:'));
    if (line.startsWith('DIAG:')) return this.diag(arg('DIAG:'));
    if (line.startsWith('SET_SLEEP_SCREEN:')) {
      const m = arg('SET_SLEEP_SCREEN:').trim() as SleepScreen;
      if (!SLEEP_SCREENS.includes(m)) return;
      s.sleepScreen = m; this.savePrefs();
      return this.out(`SLEEP_SCREEN_SET:${m}`);
    }
    if (line.startsWith('SET_NET:')) return this.setNet(arg('SET_NET:'));
    if (line.startsWith('SET_BLE:')) return this.setBle(arg('SET_BLE:'));
    if (line.startsWith('ALERT:')) return this.alertCmd(arg('ALERT:'));
    if (line.startsWith('SET_AUTODIM:')) return this.autodim(arg('SET_AUTODIM:'));
    if (line.startsWith('SET_GESTURES:')) {
      const [sw, hold] = arg('SET_GESTURES:').split(':').map(int);
      s.gestures.swipe = sw !== 0; if (hold >= 100 && hold <= 5000) s.gestures.holdMs = hold; this.savePrefs();
      return;
    }
    // Unknown: the real firmware silently ignores it (after counting it as activity).
  }

  private getSync(): void {
    const s = this.state;
    this.out(`SYNC_PAGE:${s.page}`, false);
    this.out(`KNOB_RAW:${s.knobRaw}`, false);
    s.config.pages[s.page]?.buttons.forEach((b, i) => {
      if (!b) return;
      if (b.type === 'toggle') this.out(`SYNC_STATE:${i}:${this.toggleState(s.page, i) ? 1 : 0}`, false);
      else if (b.type === 'counter') this.out(`COUNTER_UPDATE:${s.page}:${i}:${this.counterValue(s.page, i)}`, false);
    });
    for (const [k, t] of Object.entries(s.timers)) {
      const [pg, ix] = k.split(':').map(Number);
      const remaining = t.duration - Math.floor((this.now() - t.startedAt) / 1000);
      if (remaining > 0) this.out(`TIMER_UPDATE:${pg}:${ix}:1:${remaining}`, false);
    }
  }

  private setBtnData(line: string): void {
    const s = this.state;
    const p1 = line.indexOf(':'), p2 = line.indexOf(':', p1 + 1), p3 = line.indexOf(':', p2 + 1);
    if (p1 < 0 || p2 < 0 || p3 < 0) return;
    const page = parseInt(line.slice(p1 + 1, p2), 10), idx = parseInt(line.slice(p2 + 1, p3), 10);
    if (!(page >= 0 && page < s.config.pages.length) || !(idx >= 0)) return;
    let obj: Record<string, any>;
    try {
      const v = JSON.parse(line.slice(p3 + 1));
      if (v === null || typeof v !== 'object' || Array.isArray(v) || line.length - p3 > 2048) throw new Error('bad');
      obj = v;
    } catch { return this.out('ERR_BAD_JSON'); }
    const btns = s.config.pages[page].buttons;
    while (btns.length <= idx) btns.push({});
    btns[idx] = obj;
    this.saveConfig();
    // Patched firmware: no redraw (and no wake) while asleep.
    if (page === s.page && !s.sleep.sleeping && !s.sleep.deepSleeping) this.out('BTN_UPDATED_AND_PAGE_REDRAWN');
  }

  private weather(data: string): void {
    const p = data.split(':');
    if (p.length < 2) return;
    const w = this.state.weather ?? { temp: 0, code: 0, isDay: true, celsius: true, desc: '', city: '' };
    w.temp = parseInt(p[0], 10) || 0; w.code = parseInt(p[1], 10) || 0;
    w.isDay = (parseInt(p[2], 10) || 0) === 1;
    if (p.length > 3) w.celsius = (parseInt(p[3], 10) || 0) === 1;
    w.desc = (p[4] ?? '').trim().slice(0, 31); w.city = p.slice(5).join(':').trim().slice(0, 31);
    this.state.weather = w;
    this.out(`Weather updated: ${w.temp}° (code=${w.code}, day=${w.isDay ? 1 : 0}, celsius=${w.celsius ? 1 : 0}, desc=${w.desc}, city=${w.city})`, false);
  }

  private diag(data: string): void {
    const p = data.split(':');
    if (p.length < 7) return;
    const n = (i: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, parseInt(p[i], 10) || 0));
    this.state.diag = { cpu: n(0, 0, 100), mem: n(1, 0, 100), disk: n(2, 0, 100), rx: n(3, 0, 1e9), tx: n(4, 0, 1e9), uptimeMin: n(5, 0, 1e9), host: p.slice(6).join(':').slice(0, 16), at: this.now() };
  }

  // ---- provisioning / radios ----------------------------------------------------------------------------------
  private setNet(raw: string): void {
    let j: any;
    try { j = JSON.parse(raw); if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('x'); } catch { return this.out('NET_SET:err:bad_json'); }
    const str = (k: string, max: number, min = 0) => (typeof j[k] === 'string' && j[k].length >= min && j[k].length <= max ? (j[k] as string) : null);
    const n = this.state.net;
    const next = { ...n }; const sec = { ...this.secrets };
    if ('ssid' in j) { const v = str('ssid', 32); if (v === null) return this.out('NET_SET:err:bad_ssid'); next.ssid = v; }
    if ('pass' in j) { const v = str('pass', 63); if (v === null) return this.out('NET_SET:err:bad_pass'); sec.pass = v; }
    if ('host' in j) { if (typeof j.host !== 'string' || !/^[a-z0-9-]{1,32}$/.test(j.host)) return this.out('NET_SET:err:bad_host'); next.host = j.host; }
    if ('token' in j) { const v = str('token', 64, 8); if (v === null) return this.out('NET_SET:err:bad_token'); sec.token = v; }
    if ('ha_url' in j) { if (typeof j.ha_url !== 'string' || (j.ha_url !== '' && !/^https?:\/\/[^\s]{1,120}$/.test(j.ha_url))) return this.out('NET_SET:err:bad_ha_url'); sec.ha_url = j.ha_url; }
    if ('ha_token' in j) { const v = str('ha_token', 256); if (v === null) return this.out('NET_SET:err:bad_ha_token'); sec.ha_token = v; }
    if ('tz' in j) { const v = str('tz', 64); if (v === null) return this.out('NET_SET:err:bad_tz'); next.tz = v; }
    if ('standalone' in j) { if (!['auto', 'always', 'never'].includes(j.standalone)) return this.out('NET_SET:err:bad_standalone'); next.standalone = j.standalone; }
    if ('wifi' in j) { if (typeof j.wifi !== 'boolean') return this.out('NET_SET:err:bad_wifi'); next.wifi = j.wifi; }
    Object.assign(n, next); this.secrets = sec; this.syncNetFlags(); this.savePrefs();
    this.out('NET_SET:ok');
    this.emitNetStatus(false);
  }

  private wifiState(): 'off' | 'connected' {
    const n = this.state.net;
    return n.ssid && n.wifi ? 'connected' : 'off';
  }

  /** NET_STATUS line (never contains secrets). `force` skips the 2 s rate limit (GET_NET). */
  netStatus(): Record<string, unknown> {
    const s = this.state, on = this.wifiState() === 'connected';
    return {
      wifi: on ? 'connected' : 'off', ip: on ? '192.168.1.123' : '', rssi: on ? -52 : 0, host: s.net.host, ssid: s.net.ssid,
      clients: this.clients(), ota: on && !!this.secrets.token, ntp: on, ble: !s.ble.enabled ? 'off' : s.ble.peer ? 'connected' : 'advertising', ble_peer: s.ble.peer, fw: 'virtual-1.1',
      caps: [...CAPS], ble_slot: s.ble.slot, ble_slots: [...s.ble.slots],
    };
  }

  emitNetStatus(force: boolean): void {
    const t = this.now();
    if (!force && t - this.lastNetEmit < 2000) return;
    this.lastNetEmit = t;
    this.out(`NET_STATUS:${JSON.stringify(this.netStatus())}`);
  }

  private setBle(raw: string): void {
    let j: any;
    try { j = JSON.parse(raw); if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('x'); } catch { return this.out('BLE_SET:err:bad_json'); }
    const b = this.state.ble;
    if ('name' in j && (typeof j.name !== 'string' || !/^[\x20-\x7e]{1,24}$/.test(j.name))) return this.out('BLE_SET:err:bad_name');
    if ('enabled' in j && typeof j.enabled !== 'boolean') return this.out('BLE_SET:err:bad_enabled');
    if ('slots' in j && (!Array.isArray(j.slots) || j.slots.length < 1 || j.slots.length > BLE_SLOTS || !j.slots.every((x: unknown) => typeof x === 'string' && /^[\x20-\x7e]{1,12}$/.test(x))))
      return this.out('BLE_SET:err:bad_slots');
    if ('clear_bonds' in j && !(j.clear_bonds === true || (Number.isInteger(j.clear_bonds) && j.clear_bonds >= 1 && j.clear_bonds <= BLE_SLOTS)))
      return this.out('BLE_SET:err:bad_clear_bonds');
    if ('name' in j) b.name = j.name;
    if ('enabled' in j) { b.enabled = j.enabled; if (!b.enabled) b.peer = ''; }
    if ('slots' in j) (j.slots as string[]).forEach((n, i) => { b.slots[i] = n; });
    if ('clear_bonds' in j) {
      if (j.clear_bonds === true) { b.bonds = [false, false, false]; b.peer = ''; }
      else { b.bonds[j.clear_bonds - 1] = false; if (j.clear_bonds === b.slot) b.peer = ''; }
    }
    this.savePrefs();
    this.out('BLE_SET:ok');
    this.emitNetStatus(false);
  }

  /** BLE_HOST:<1|2|3|next>: switch the BLE identity, dropping the current peer. Shared by the host command and blehost buttons. */
  private switchBleSlot(arg: string | number): { ok: true; slot: number } | { ok: false; err: string } {
    const b = this.state.ble;
    if (!b.enabled) return { ok: false, err: 'ble_off' };
    let n: number;
    if (arg === 'next') n = (b.slot % BLE_SLOTS) + 1;
    else if (arg === 1 || arg === 2 || arg === 3) n = arg;
    else if (typeof arg === 'string' && /^[123]$/.test(arg)) n = Number(arg);
    else return { ok: false, err: 'bad_slot' };
    b.slot = n; b.peer = '';
    this.state.toast = { text: `BT: ${b.slots[n - 1]}`, until: this.now() + TOAST_MS };
    this.savePrefs();
    this.changed();
    return { ok: true, slot: n };
  }

  private bleHostCmd(arg: string): void {
    const r = this.switchBleSlot(arg);
    this.out(r.ok ? `BLE_HOST:${r.slot}` : `BLE_HOST:err:${r.err}`);
    if (r.ok) this.emitNetStatus(false); // reply first, then the (rate-limited) state-change status, like the firmware
  }

  /** UI/touch-side entry for a `blehost` button press or the side-panel slot buttons. */
  bleHost(arg: string | number): { ok: boolean; slot?: number; err?: string } {
    this.wake();
    const r = this.switchBleSlot(arg);
    if (!r.ok) { this.state.toast = { text: r.err === 'ble_off' ? 'BT: off' : 'BT: ?', until: this.now() + TOAST_MS }; this.changed(); }
    else { this.log(`BLE host slot ${r.slot} (${this.state.ble.slots[r.slot - 1]})`); this.emitNetStatus(false); }
    return r.ok ? { ok: true, slot: r.slot } : { ok: false, err: r.err };
  }

  // ---- live button overrides (SET_BTN_LIVE) ------------------------------------------------------------------
  private setBtnLive(line: string): void {
    const s = this.state;
    const p1 = line.indexOf(':'), p2 = line.indexOf(':', p1 + 1), p3 = line.indexOf(':', p2 + 1);
    const reject = (why: string) => this.log(`SET_BTN_LIVE rejected: ${why}`);
    if (p1 < 0 || p2 < 0 || p3 < 0) return reject('format');
    const page = Number(line.slice(p1 + 1, p2)), idx = Number(line.slice(p2 + 1, p3));
    if (!Number.isInteger(page) || page < 0 || page >= s.config.pages.length) return reject('page');
    const cells = (s.config.grid?.cols ?? 3) * (s.config.grid?.rows ?? 3);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cells) return reject('index');
    const body = line.slice(p3 + 1);
    if (body.length > 512) return reject('too long');
    let j: any;
    try { j = JSON.parse(body); if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('x'); } catch { return reject('bad json'); }
    const o: LiveOverride = {};
    for (const k of LIVE_KEYS) {
      if (!(k in j)) continue;
      const v = j[k];
      if (k === 'label') { if (typeof v !== 'string' || v.length > 24) return reject('label'); o.label = v; }
      else if (k === 'labelColor' || k === 'btnColor') { if (typeof v !== 'string' || !HEX6.test(v)) return reject(k); o[k] = v.toLowerCase(); }
      else if (k === 'labelSize') { if (!Number.isInteger(v) || v < 8 || v > 40) return reject('labelSize'); o.labelSize = v; }
      else if (k === 'icon') { if (typeof v !== 'string' || !SAFE_FILE_RE.test(v) || v.startsWith('.')) return reject('icon'); o.icon = v; }
    }
    this.liveMerge(page, idx, o);
  }

  /** Merge keys into the override for page:idx (null deletes a key); newest entries sit last, oldest are dropped when full. */
  private liveMerge(page: number, idx: number, patch: { [K in keyof LiveOverride]?: LiveOverride[K] | null }): void {
    const live = this.state.live, key = this.key(page, idx);
    const cur: Record<string, unknown> = { ...(live[key] ?? {}) };
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined) delete cur[k]; else cur[k] = v; }
    delete live[key]; // re-insert so it counts as the newest entry
    if (Object.keys(cur).length === 0) return;
    live[key] = cur as LiveOverride;
    const keys = Object.keys(live);
    for (let i = 0; keys.length - i > this.o.liveCapacity; i++) delete live[keys[i]];
  }

  // ---- on-deck Home Assistant (state display + standalone ha/http presses) -----------------------------------
  private haCreds(): { base: string; token: string } | null {
    const { ha_url, ha_token } = this.secrets;
    return ha_url && ha_token ? { base: ha_url.replace(/\/+$/, ''), token: ha_token } : null;
  }

  /** Polling runs only when WiFi is up, the deck is awake, HA is configured and no host is covering for it (or standalone=always). */
  private haPollEligible(): boolean {
    const s = this.state;
    if (s.rebooting || s.sleep.sleeping || s.sleep.deepSleeping || this.wifiState() !== 'connected' || !this.haCreds()) return false;
    return s.net.standalone === 'always' || !this.hostActive();
  }

  private haPollTick(): void {
    if (!this.haPollEligible()) return;
    const s = this.state, t = this.now(), page = s.page;
    const due: Array<{ idx: number; entity: string; hs: Record<string, any> }> = [];
    let n = 0;
    (s.config.pages[page]?.buttons ?? []).forEach((b, idx) => {
      const hs = b?.ha_state;
      if (!hs || typeof hs.entity !== 'string' || !ENTITY_RE.test(hs.entity)) return;
      if (++n > HA_MAX_BUTTONS) return;
      const key = this.key(page, idx);
      if (t < (this.haNext.get(key) ?? 0)) return;
      const interval = Math.min(3600, Math.max(5, Number(hs.interval) || 10));
      this.haNext.set(key, t + interval * 1000);
      due.push({ idx, entity: hs.entity, hs });
    });
    if (due.length) this.haChain = this.haChain.then(() => this.haPollEntities(page, due)).catch(() => {});
  }

  /** Sequential, one request at a time (the firmware does this in a single worker task). */
  private async haPollEntities(page: number, due: Array<{ idx: number; entity: string; hs: Record<string, any> }>): Promise<void> {
    for (const d of due) {
      const state = await this.haFetchState(d.entity);
      this.state.haState[d.entity] = { state, at: this.now() };
      this.applyHaState(page, d.idx, d.hs, state);
      this.changed();
    }
  }

  private async haFetchState(entity: string): Promise<string> {
    const c = this.haCreds();
    if (!c) return 'unavailable';
    try {
      const r = await this.o.fetchImpl(`${c.base}/api/states/${encodeURIComponent(entity)}`, {
        headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(this.o.haTimeoutMs),
      });
      if (!r.ok) return 'unavailable';
      const j = (await r.json()) as { state?: unknown };
      return typeof j.state === 'string' ? j.state : 'unavailable';
    } catch { return 'unavailable'; }
  }

  private applyHaState(page: number, idx: number, hs: Record<string, any>, state: string): void {
    const col = (v: unknown) => (typeof v === 'string' && HEX6.test(v) ? v.toLowerCase() : null);
    const lab = (v: unknown) => (typeof v === 'string' && v.length <= 24 ? v : null);
    if (state === 'on') this.liveMerge(page, idx, { btnColor: col(hs.on), label: lab(hs.label_on) });
    else if (state === 'off') this.liveMerge(page, idx, { btnColor: col(hs.off), label: lab(hs.label_off) });
    else this.liveMerge(page, idx, { btnColor: HA_UNAVAILABLE_COLOR, label: '?' });
  }

  private track(p: Promise<unknown>): void {
    const t: Promise<unknown> = p.catch(() => {}).finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }

  /** Resolves when no Home Assistant poll or standalone ha/http request is in flight (for tests and scripts). */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.all([this.haChain, ...this.tasks]);
      if (this.tasks.size === 0) return;
    }
  }

  /** Run an ha/http button on the deck itself (standalone routing). Result goes to the deck log; secrets never do. */
  private runStandaloneNet(page: number, idx: number, b: Record<string, any>): boolean {
    if (b.type === 'ha') { this.track(this.standaloneHa(page, idx, b)); return true; }
    if (b.type === 'http') { this.track(this.standaloneHttp(b)); return true; }
    return false;
  }

  private async standaloneHa(page: number, idx: number, b: Record<string, any>): Promise<void> {
    const ha = b.ha ?? {};
    const c = this.haCreds();
    if (!c) return this.log('ha: not configured (ha_url + ha_token via SET_NET)');
    if (typeof ha.service !== 'string' || !SERVICE_RE.test(ha.service)) return this.log('ha: bad service name');
    const [domain, service] = ha.service.split('.');
    const body: Record<string, unknown> = {};
    if (typeof ha.entity === 'string' && ENTITY_RE.test(ha.entity)) body.entity_id = ha.entity;
    if (ha.data && typeof ha.data === 'object' && !Array.isArray(ha.data)) Object.assign(body, ha.data);
    try {
      const r = await this.o.fetchImpl(`${c.base}/api/services/${domain}/${service}`, {
        method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.haTimeoutMs),
      });
      this.log(`ha ${ha.service}${body.entity_id ? ' ' + body.entity_id : ''} -> HTTP ${r.status}`);
    } catch { this.log(`ha ${ha.service} -> failed (network/timeout)`); }
    // refresh the button's state shortly after the press
    const hs = b.ha_state;
    if (hs && typeof hs.entity === 'string' && ENTITY_RE.test(hs.entity)) {
      const t = setTimeout(() => {
        if (this.haPollEligible() && this.state.page === page)
          this.haChain = this.haChain.then(() => this.haPollEntities(page, [{ idx, entity: hs.entity, hs }])).catch(() => {});
      }, this.o.haRepollMs);
      t.unref?.();
    }
  }

  private async standaloneHttp(b: Record<string, any>): Promise<void> {
    const h = b.http ?? {};
    if (typeof h.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(h.url)) return this.log('http: bad url');
    const method = String(h.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return this.log('http: bad method');
    const headers: Record<string, string> = {};
    if (h.headers && typeof h.headers === 'object') for (const [k, v] of Object.entries(h.headers).slice(0, 8)) if (typeof v === 'string') headers[k] = v;
    let where = 'host';
    try { where = new URL(h.url).host; } catch { /* validated above */ }
    try {
      const r = await this.o.fetchImpl(h.url, {
        method, headers, body: method === 'GET' || typeof h.body !== 'string' ? undefined : h.body.slice(0, 1024), signal: AbortSignal.timeout(this.o.haTimeoutMs),
      });
      this.log(`http ${method} ${where} -> HTTP ${r.status}`);
    } catch { this.log(`http ${method} ${where} -> failed (network/timeout)`); }
  }

  private alertCmd(arg: string): void {
    const s = this.state;
    if (arg === 'off') { s.alert = null; return; }
    const p = arg.split(':');
    const kind = p[0] as AlertKind;
    if (!ALERT_KINDS.includes(kind)) return;
    const secs = Math.max(0, Math.min(3600, parseInt(p[1], 10) || 0));
    const text = p.slice(2).join(':').slice(0, 24);
    const t = this.now();
    s.alert = { kind, text, until: secs > 0 ? t + secs * 1000 : 0, startedAt: t };
    this.wake(); // alerts wake the deck
  }

  private autodim(arg: string): void {
    const s = this.state.autodim;
    const p = arg.split(':').map((v) => parseInt(v, 10));
    if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return;
    if (!s.sensor) { s.enabled = false; return this.out('AUTODIM:no_sensor'); }
    s.enabled = p[0] === 1; s.min = Math.max(0, Math.min(100, p[1])); s.max = Math.max(s.min, Math.min(100, p[2]));
    if (p.length >= 5 && !Number.isNaN(p[3]) && !Number.isNaN(p[4])) { s.luxLow = p[3]; s.luxHigh = Math.max(p[3] + 1, p[4]); }
    this.savePrefs();
    this.out('AUTODIM:ok');
  }

  /** Brightness the panel actually shows: autodim (log curve between lux bounds) when enabled. */
  effectiveBrightness(): number {
    const { brightness, autodim: a } = this.state;
    if (!a.enabled || !a.sensor) return brightness;
    const lo = Math.log(Math.max(1, a.luxLow)), hi = Math.log(Math.max(2, a.luxHigh));
    const f = Math.max(0, Math.min(1, (Math.log(Math.max(1, a.lux)) - lo) / (hi - lo)));
    return Math.round(a.min + (a.max - a.min) * f);
  }

  // ------------------------------------------------------------------ UI-side interactions (the "touch panel")
  private key(page: number, idx: number) { return `${page}:${idx}`; }
  toggleState(page: number, idx: number): boolean { return this.state.toggles[this.key(page, idx)] ?? true; } // firmware: draw_page sets state = true
  counterValue(page: number, idx: number): number {
    const k = this.key(page, idx);
    return this.state.counters[k] ?? (this.state.config.pages[page]?.buttons[idx]?.counterStartValue ?? 0);
  }
  private resetToggles(page: number): void {
    for (const k of Object.keys(this.state.toggles)) if (k.startsWith(`${page}:`)) delete this.state.toggles[k];
  }

  private gotoPage(p: number): void {
    this.state.page = p; this.resetToggles(p);
    for (const k of [...this.haNext.keys()]) if (k.startsWith(`${p}:`)) this.haNext.delete(k); // poll the new page's HA buttons right away
    this.changed();
  }

  /** Touch anywhere while an alert is active acknowledges it (and is swallowed). */
  ackAlert(): boolean {
    const a = this.state.alert;
    if (!a) return false;
    this.state.alert = null;
    this.out(`ALERT_ACK:${a.kind}`, false);
    this.changed();
    return true;
  }

  /** First touch on a sleeping deck only wakes it; an active alert swallows the touch. Returns true if swallowed. */
  private touchGate(): boolean {
    const s = this.state;
    if (s.rebooting) return true;
    if (s.sleep.sleeping || s.sleep.deepSleeping) { this.wake(); return true; }
    this.wake();
    return this.ackAlert();
  }

  touchWake(): void { this.touchGate(); }

  /** Skip the inactivity timeout and dim now (UI "Sleep now"); mirrors what tick() does on timeout. */
  sleepNow(): void {
    const s = this.state;
    if (s.rebooting || s.sleep.sleeping) return;
    s.sleep.sleeping = true; s.sleep.dimStart = this.now();
    if (!s.clock.set) this.out('GET_TIME');
    this.changed();
  }

  /** A touch on cell `index` of the current page lasting `holdMs`. */
  touch(index: number, holdMs = 80): { action: string } {
    if (this.touchGate()) return { action: 'swallowed' };
    const s = this.state, page = s.page;
    const b = s.config.pages[page]?.buttons[index];
    if (!b) return { action: 'none' };
    const type = String(b.type ?? 'none');
    const k = this.key(page, index);

    if (holdMs > 800 && type === 'counter') {
      s.counters[k] = Number(b.counterStartValue ?? 0);
      this.out(`COUNTER_UPDATE:${page}:${index}:${s.counters[k]}`, false);
      return { action: 'counter-reset' };
    }
    if (holdMs > 800 && type === 'timer') {
      delete s.timers[k];
      this.out(`TIMER_UPDATE:${page}:${index}:2:${Number(b.duration ?? 0)}`, false);
      return { action: 'timer-reset' };
    }
    if (b.hold === true && holdMs >= s.gestures.holdMs) {
      this.out(`BTN_HOLD:${page}:${index}`, false);
      return { action: 'hold' };
    }
    switch (type) {
      case 'goto': {
        const target = (parseInt(String(b.page ?? 1), 10) || 1) - 1;
        if (target >= 0 && target < s.config.pages.length) { this.gotoPage(target); this.out(`PAGE_CHANGED:${target}`, false); }
        return { action: 'goto' };
      }
      case 'timer': {
        const dur = Number(b.duration ?? 0);
        if (s.timers[k]) { delete s.timers[k]; this.out(`TIMER_UPDATE:${page}:${index}:2:${dur}`, false); return { action: 'timer-stop' }; }
        s.timers[k] = { duration: dur, startedAt: this.now() };
        this.out(`TIMER_UPDATE:${page}:${index}:1:${dur}`, false);
        return { action: 'timer-start' };
      }
      case 'counter': {
        const mode = String(b.counterAction ?? 'increment');
        let v = this.counterValue(page, index);
        if (mode === 'decrement') v--; else if (mode === 'reset') v = Number(b.counterStartValue ?? 0); else v++;
        s.counters[k] = v;
        this.out(`COUNTER_UPDATE:${page}:${index}:${v}`, false);
        return { action: 'counter' };
      }
      case 'toggle': {
        s.toggles[k] = !this.toggleState(page, index);
        return this.sendPress(page, index, b, s.toggles[k] ? 1 : 0);
      }
      case 'blehost': {
        // device-local like goto: runs on the deck every time, never reported to the host as BTN
        const r = this.bleHost(typeof b.slot === 'string' && /^[123]$/.test(b.slot) ? Number(b.slot) : b.slot);
        if (!r.ok) this.log(`blehost: ${r.err}`);
        return { action: 'blehost' };
      }
      case 'none':
        return { action: 'none' };
      default:
        return this.sendPress(page, index, b);
    }
  }

  private sendPress(page: number, index: number, b: Record<string, any>, state?: 0 | 1): { action: string } {
    const mode = this.state.net.standalone;
    const standalone = mode === 'always' || (mode === 'auto' && !this.hostActive());
    if (standalone) {
      const what = `${b.type}${b.combo ? ' ' + b.combo : ''}${b.text ? ' "' + b.text + '"' : ''}${b.media ? ' ' + b.media : ''}${b.ha?.service ? ' ' + b.ha.service : ''}`;
      if (!this.runStandaloneNet(page, index, b)) this.log(`would run on deck: ${what.trim()} (button ${page}:${index})`);
      this.emit('standalone', { page, index, button: b });
      return { action: 'standalone' };
    }
    this.out(state === undefined ? `BTN:${page}:${index}` : `BTN:${page}:${index}:${state}`, false);
    return { action: 'btn' };
  }

  /** Swipe gesture in panel pixels (800x480). Rules: >=120 px, <=700 ms, mostly horizontal. */
  swipe(dx: number, dy: number, ms: number): { recognized: boolean; changed: boolean } {
    const s = this.state;
    if (!s.gestures.swipe || Math.abs(dx) < 120 || ms > 700 || Math.abs(dx) < 2 * Math.abs(dy)) return { recognized: false, changed: false };
    if (this.touchGate()) return { recognized: true, changed: false };
    const next = Math.max(0, Math.min(s.config.pages.length - 1, s.page + (dx < 0 ? 1 : -1)));
    if (next === s.page) return { recognized: true, changed: false };
    this.gotoPage(next);
    this.out(`PAGE_CHANGED:${next}`, false);
    return { recognized: true, changed: true };
  }

  /** Knob turned to raw angle 0..4095 (AS5600). Firmware only reports moves of more than 3 units. */
  knob(raw: number): void {
    raw = Math.max(0, Math.min(4095, Math.round(raw)));
    let d = raw - this.lastKnobSent;
    if (d > 2048) d -= 4096; else if (d < -2048) d += 4096;
    this.state.knobRaw = raw;
    if (this.lastKnobSent < 0 || Math.abs(d) > 3) {
      this.lastKnobSent = raw;
      this.wake();
      this.out(`KNOB_RAW:${raw}`, false);
    }
    this.changed();
  }

  /** Simulate a BLE central connecting/disconnecting. */
  setBlePeer(peer: string): void {
    if (!this.state.ble.enabled) return;
    const b = this.state.ble;
    b.peer = peer.slice(0, 40);
    if (b.peer) { b.bonds[b.slot - 1] = true; this.savePrefs(); } // a host that connects bonds to the current slot's identity
    this.emitNetStatus(false);
    this.changed();
  }

  /** Simulated ambient light. Emits LUX:n at most every 10 s and only on >20% change. */
  setLux(lux: number): void {
    const a = this.state.autodim;
    a.lux = Math.max(0, Math.round(lux));
    const t = this.now();
    if (a.sensor && t - this.lastLuxEmit >= 10_000 && (this.lastLux < 0 || Math.abs(a.lux - this.lastLux) > 0.2 * Math.max(1, this.lastLux))) {
      this.lastLux = a.lux; this.lastLuxEmit = t;
      this.out(`LUX:${a.lux}`, false);
    }
    this.changed();
  }

  // ------------------------------------------------------------------ snapshot for the web UI
  snapshot(): Record<string, unknown> {
    const s = this.state;
    return {
      ...s,
      now: this.now(),
      clockNow: this.clockNow(),
      hostActive: this.hostActive(),
      effectiveBrightness: this.effectiveBrightness(),
      net: { ...s.net, status: this.netStatus() },
      pageCount: s.config.pages.length,
    };
  }
}
