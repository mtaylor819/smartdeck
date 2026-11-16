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
  | { type: 'getTime' }
  | { type: 'setupDone' }
  | { type: 'log'; line: string };

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
    case 'GET_TIME':
      return { type: 'getTime' };
    case 'SETUP_DONE':
      return { type: 'setupDone' };
  }
  return { type: 'log', line };
}

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
  setBrightness: (pct: number) => `SET_BRIGHTNESS:${clamp(Math.round(pct), 0, 100)}`,
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
