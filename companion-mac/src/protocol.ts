// SmartDeck serial protocol (115200 baud, newline-delimited text).
// Derived from JC8048W550/Arduino/smart_deck/smart_deck.ino.

export type DeviceEvent =
  | { type: 'pong'; name: string }
  | { type: 'button'; page: number; index: number; state?: 0 | 1 }
  | { type: 'knob'; raw: number }
  | { type: 'page'; page: number }
  | { type: 'syncState'; index: number; state: 0 | 1 }
  | { type: 'counter'; page: number; index: number; value: number }
  | { type: 'timer'; page: number; index: number; mode: number; seconds: number }
  | { type: 'timerDone'; page: number; index: number }
  | { type: 'hold'; page: number; index: number }
  | { type: 'alertAck'; kind: string }
  | { type: 'lux'; value: number }
  | { type: 'netStatus'; status: NetStatus }
  | { type: 'getTime' }
  | { type: 'setupDone' }
  | { type: 'log'; line: string };

/** Deck-reported connectivity state (NET_STATUS). Never contains secrets. */
export interface NetStatus {
  wifi?: 'off' | 'connecting' | 'connected';
  ip?: string; rssi?: number; host?: string; ssid?: string; clients?: number;
  ota?: boolean; ntp?: boolean; ble?: 'off' | 'advertising' | 'connected'; ble_peer?: string; fw?: string;
  caps?: string[]; ble_slot?: number; ble_slots?: string[];
}

const str = (v: unknown, max = 64) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strs = (v: unknown, n: number, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, n).map((x) => str(x, max) ?? '') : undefined;

/** NET_STATUS comes from the network/deck: trust nothing about its shape. */
export function sanitizeNetStatus(o: unknown): NetStatus {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(v) ? (v as T) : undefined;
  const out: NetStatus = {
    wifi: pick(r.wifi, ['off', 'connecting', 'connected'] as const),
    ip: str(r.ip, 45), rssi: num(r.rssi), host: str(r.host, 32), ssid: str(r.ssid, 32), clients: num(r.clients),
    ota: typeof r.ota === 'boolean' ? r.ota : undefined, ntp: typeof r.ntp === 'boolean' ? r.ntp : undefined,
    ble: pick(r.ble, ['off', 'advertising', 'connected'] as const), ble_peer: str(r.ble_peer, 48), fw: str(r.fw, 40),
    caps: strs(r.caps, 16, 24), ble_slot: num(r.ble_slot), ble_slots: strs(r.ble_slots, 3, 12),
  };
  for (const k of Object.keys(out) as (keyof NetStatus)[]) if (out[k] === undefined) delete out[k];
  return out;
}

const ints = (s: string): number[] => s.split(':').map((n) => parseInt(n, 10));

/** Parse one line sent by the deck. Unknown lines become `log` events. */
export function parseLine(raw: string): DeviceEvent {
  const line = raw.replace(/\r$/, '').trim();
  const i = line.indexOf(':');
  const head = i === -1 ? line : line.slice(0, i);
  const rest = i === -1 ? '' : line.slice(i + 1);

  switch (head) {
    case 'PONG_DECK':
      return { type: 'pong', name: rest };
    case 'BTN': {
      const [page, index, state] = ints(rest);
      if (Number.isNaN(page) || Number.isNaN(index)) break;
      return state === undefined || Number.isNaN(state)
        ? { type: 'button', page, index }
        : { type: 'button', page, index, state: state ? 1 : 0 };
    }
    case 'KNOB_RAW': {
      const [raw] = ints(rest);
      if (Number.isNaN(raw)) break;
      return { type: 'knob', raw };
    }
    case 'SYNC_PAGE':
    case 'PAGE_CHANGED': {
      const [page] = ints(rest);
      if (Number.isNaN(page)) break;
      return { type: 'page', page };
    }
    case 'SYNC_STATE': {
      const [index, state] = ints(rest);
      if (Number.isNaN(index) || Number.isNaN(state)) break;
      return { type: 'syncState', index, state: state ? 1 : 0 };
    }
    case 'COUNTER_UPDATE': {
      const [page, index, value] = ints(rest);
      if ([page, index, value].some(Number.isNaN)) break;
      return { type: 'counter', page, index, value };
    }
    case 'TIMER_UPDATE': {
      const [page, index, mode, seconds] = ints(rest);
      if ([page, index, mode, seconds].some(Number.isNaN)) break;
      return { type: 'timer', page, index, mode, seconds };
    }
    case 'TIMER_DONE': {
      const [page, index] = ints(rest);
      if ([page, index].some(Number.isNaN)) break;
      return { type: 'timerDone', page, index };
    }
    case 'BTN_HOLD': {
      const [page, index] = ints(rest);
      if ([page, index].some(Number.isNaN)) break;
      return { type: 'hold', page, index };
    }
    case 'ALERT_ACK':
      return { type: 'alertAck', kind: rest };
    case 'LUX': {
      const [value] = ints(rest);
      if (Number.isNaN(value)) break;
      return { type: 'lux', value };
    }
    case 'NET_STATUS':
      try {
        const status = JSON.parse(rest);
        if (status && typeof status === 'object') return { type: 'netStatus', status: sanitizeNetStatus(status) };
      } catch { /* fall through to log */ }
      break;
    case 'GET_TIME':
      return { type: 'getTime' };
    case 'SETUP_DONE':
      return { type: 'setupDone' };
  }
  return { type: 'log', line };
}

export type AlertKind = 'red' | 'yellow' | 'blue' | 'green';

const p2 = (n: number) => String(n).padStart(2, '0');

/** Command builders. Each returns one line WITHOUT the trailing newline. */
export const cmd = {
  ping: () => 'PING_DECK',
  getSync: () => 'GET_SYNC',
  dumpConfig: () => 'DUMP_CONFIG',
  startUpload: () => 'START_UPLOAD',
  endUpload: () => 'END_UPLOAD',
  fileHeader: (name: string, size: number) => `FILE:${name}:${size}`,
  setTime: (d: Date) => `SET_TIME:${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
  setBrightness: (pct: number) => {
    // NaN would be read by the firmware as 0 (black screen): refuse instead of guessing.
    if (!Number.isFinite(pct)) throw new Error('brightness must be a number');
    return `SET_BRIGHTNESS:${clamp(Math.round(pct), 0, 100)}`;
  },
  setSleep: (minutes: number) => `SET_SLEEP:${Math.max(0, Math.round(minutes))}`,
  setDeepSleep: (minutes: number) => `SET_DEEP_SLEEP:${Math.max(0, Math.round(minutes))}`,
  setDimLed: (anim: string) => `SET_DIM_LED:${anim}`,
  setLedBrightness: (n: number) => `SET_LED_BRIGHTNESS:${clamp(Math.round(n), 0, 255)}`,
  setSleepScreen: (mode: 'clock' | 'diag' | 'diag-anim' | 'warp') => `SET_SLEEP_SCREEN:${mode}`,
  diag: (d: { cpu: number; mem: number; disk: number; rx: number; tx: number; uptimeMin: number; host: string }) =>
    `DIAG:${clamp(Math.round(d.cpu), 0, 100)}:${clamp(Math.round(d.mem), 0, 100)}:${clamp(Math.round(d.disk), 0, 100)}:` +
    `${Math.max(0, Math.round(d.rx))}:${Math.max(0, Math.round(d.tx))}:${Math.max(0, Math.round(d.uptimeMin))}:` +
    d.host.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16),
  hb: () => 'HB',
  setBtnLive: (page: number, index: number, o: { label?: string; labelColor?: string; btnColor?: string; labelSize?: number; icon?: string }) =>
    `SET_BTN_LIVE:${page}:${index}:${JSON.stringify(o)}`,
  bleHost: (slot: 1 | 2 | 3 | 'next') => `BLE_HOST:${slot}`,
  blePair: (seconds = 120) => `BLE_PAIR:${clamp(Math.round(seconds), 1, 300)}`,
  getNet: () => 'GET_NET',
  /** Provisioning blob. Secrets inside: only send over USB (or an authenticated link). */
  setNet: (o: Record<string, unknown>) => `SET_NET:${JSON.stringify(o)}`,
  setBle: (o: { enabled: boolean; name?: string }) => `SET_BLE:${JSON.stringify(o)}`,
  alert: (kind: AlertKind, seconds = 0, text = '') =>
    `ALERT:${kind}:${clamp(Math.round(seconds), 0, 3600)}` + (text ? `:${text.replace(/[^\x20-\x7e]|:/g, '').slice(0, 24)}` : ''),
  alertOff: () => 'ALERT:off',
  setAutodim: (on: boolean, minPct: number, maxPct: number, luxLow?: number, luxHigh?: number) =>
    `SET_AUTODIM:${on ? 1 : 0}:${clamp(Math.round(minPct), 0, 100)}:${clamp(Math.round(maxPct), 0, 100)}` +
    (luxLow !== undefined && luxHigh !== undefined ? `:${Math.round(luxLow)}:${Math.round(luxHigh)}` : ''),
  setGestures: (swipe: boolean, holdMs: number) => `SET_GESTURES:${swipe ? 1 : 0}:${clamp(Math.round(holdMs), 200, 3000)}`,
  setPage: (page: number) => `SET_PAGE:${page}`,
  setKnobLed: (r: number, g: number, b: number, tail: number) =>
    `SET_KNOB:${clamp(r, 0, 255)}:${clamp(g, 0, 255)}:${clamp(b, 0, 255)}:${clamp(tail, 1, 15)}`,
  setDeviceName: (name: string) => `SET_DEVICE_NAME:${name.replace(/[\r\n]/g, ' ')}`,
  setBtnData: (page: number, index: number, button: object) =>
    `SET_BTN_DATA:${page}:${index}:${JSON.stringify(button)}`,
  setPageName: (page: number, name: string) => `SET_PAGE_NAME:${page}:${name.replace(/[\r\n]/g, ' ')}`,
  weather: (temp: number, code: number, isDay: boolean, celsius: boolean, desc: string, city: string) =>
    `WEATHER:${Math.round(temp)}:${code}:${isDay ? 1 : 0}:${celsius ? 1 : 0}:${desc.replace(/:/g, ' ')}:${city.replace(/:/g, ' ')}`,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** AS5600 encoder: 12-bit angle (0..4095). Signed shortest delta, handling wraparound. */
export function knobDelta(prev: number, next: number): number {
  let d = next - prev;
  if (d > 2048) d -= 4096;
  else if (d < -2048) d += 4096;
  return d;
}
