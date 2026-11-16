import type { Config } from './config.js';

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Brightness the schedule asks for at `now`, or undefined if no window matches. Windows may wrap midnight. First match wins. */
export function scheduledBrightness(schedule: Config['brightnessSchedule'], now: Date): number | undefined {
  const m = now.getHours() * 60 + now.getMinutes();
  for (const r of schedule ?? []) {
    const a = toMin(r.from), b = toMin(r.to);
    const inside = a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
    if (inside) return r.brightness;
  }
  return undefined;
}
