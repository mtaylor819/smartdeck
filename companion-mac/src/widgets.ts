import { cpus, freemem, totalmem } from 'node:os';
import type { Capture, HaSettings } from './actions.js';
import { Button, Config, toDeviceButton, Widget } from './config.js';
import { cmd } from './protocol.js';

export const MIN_INTERVAL_S = 10;
const MAX_LABEL = 24;

export interface WidgetDeps {
  capture: Capture;
  fetchImpl: typeof fetch;
  ha: () => HaSettings | undefined;
  cpuTimes: () => Array<{ idle: number; total: number }>;
}

export const defaultCpuTimes = () =>
  cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });

/** Walk "a.b.0.c" into a JSON value. */
export function jsonPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Turn a raw value into the label + (optional) colour pushed to the deck. */
export function renderWidget(w: Widget, value: string): { label: string; btnColor?: string } {
  const label = (w.format ? w.format.replaceAll('{value}', value) : value).slice(0, MAX_LABEL);
  const n = Number(value);
  let btnColor: string | undefined;
  if (w.thresholds && Number.isFinite(n)) {
    let best = -Infinity;
    for (const t of w.thresholds) if (n > t.above && t.above > best) ((best = t.above), (btnColor = t.color));
  }
  return { label, btnColor };
}

/** Fetch the current value of a widget's data source as a display string. */
export async function readWidget(w: Widget, d: WidgetDeps, state: { prevCpu?: Array<{ idle: number; total: number }> }): Promise<string> {
  switch (w.source) {
    case 'clock': {
      const n = new Date();
      return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
    }
    case 'cpu': {
      const now = d.cpuTimes();
      const prev = state.prevCpu;
      state.prevCpu = now;
      if (!prev || prev.length !== now.length) return '0';
      let idle = 0, total = 0;
      now.forEach((c, i) => ((idle += c.idle - prev[i].idle), (total += c.total - prev[i].total)));
      return total > 0 ? String(Math.round((1 - idle / total) * 100)) : '0';
    }
    case 'memory':
      return String(Math.round((1 - freemem() / totalmem()) * 100));
    case 'nowplaying': {
      const script = `
        if application "Spotify" is running then
          tell application "Spotify" to if player state is playing then return (artist of current track) & " - " & (name of current track)
        end if
        if application "Music" is running then
          tell application "Music" to if player state is playing then return (artist of current track) & " - " & (name of current track)
        end if
        return "Not playing"`;
      return (await d.capture('osascript', ['-e', script])).trim();
    }
    case 'ha_state': {
      const ha = d.ha();
      const token = ha?.token || (ha?.tokenEnv ? process.env[ha.tokenEnv] : undefined);
      if (!ha?.url || !token || !w.entity) throw new Error('ha_state widget needs Home Assistant config + entity');
      const r = await d.fetchImpl(`${ha.url.replace(/\/+$/, '')}/api/states/${encodeURIComponent(w.entity)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HA states HTTP ${r.status}`);
      return String(((await r.json()) as { state: unknown }).state);
    }
    case 'http_json': {
      if (!w.url || !/^https?:\/\//i.test(w.url)) throw new Error('http_json widget needs an http(s) url');
      const r = await d.fetchImpl(w.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = jsonPath(await r.json(), w.jsonPath ?? '');
      return v === undefined ? '?' : String(v);
    }
    case 'moonraker': {
      // Klipper/Moonraker: print progress while printing, otherwise hotend temp.
      if (!w.url || !/^https?:\/\//i.test(w.url)) throw new Error('moonraker widget needs an http(s) url');
      const q = '/printer/objects/query?print_stats&display_status&extruder';
      const r = await d.fetchImpl(w.url.replace(/\/+$/, '') + q);
      if (!r.ok) throw new Error(`Moonraker HTTP ${r.status}`);
      const st = ((await r.json()) as any).result?.status ?? {};
      if (st.print_stats?.state === 'printing') return `${Math.round((st.display_status?.progress ?? 0) * 100)}%`;
      const t = st.extruder?.temperature;
      return t === undefined ? String(st.print_stats?.state ?? '?') : `${Math.round(t)}°`;
    }
  }
}

interface Entry {
  page: number;
  index: number;
  button: Button;
  last?: string;
  nextAt: number;
}

/**
 * Keeps widget buttons fresh. Every deck update is a SET_BTN_DATA that the firmware writes
 * to SD, so we only send on change, enforce a 10s minimum per button, and space out writes.
 */
export class WidgetManager {
  private timer?: NodeJS.Timeout;
  private entries = new Map<string, Entry>();
  private cpuState: { prevCpu?: Array<{ idle: number; total: number }> } = {};
  private sendQueue: string[] = [];
  private sending = false;
  /** Latest rendered label per "page:index" for the UI. */
  values: Record<string, string> = {};

  constructor(
    private getConfig: () => Config,
    private send: (line: string) => Promise<void>,
    private deps: WidgetDeps,
    private log: (m: string) => void = () => {},
    private now: () => number = Date.now,
    private spacingMs = 250,
  ) {}

  start(tickMs = 1000): void {
    this.stop();
    this.entries.clear();
    this.timer = setInterval(() => void this.tick(), tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Forget cached values (e.g. after reconnect or a full sync) so everything is re-pushed. */
  reset(): void {
    for (const e of this.entries.values()) e.last = undefined;
  }

  async tick(): Promise<void> {
    const cfg = this.getConfig();
    const seen = new Set<string>();
    cfg.pages.forEach((p, page) =>
      p.buttons.forEach((b, index) => {
        if (!b?.widget) return;
        const key = `${page}:${index}`;
        seen.add(key);
        const e = this.entries.get(key);
        if (!e) this.entries.set(key, { page, index, button: b, nextAt: 0 });
        else e.button = b;
      }),
    );
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k);

    const now = this.now();
    await Promise.all(
      [...this.entries.entries()].map(async ([key, e]) => {
        if (now < e.nextAt) return;
        const w = e.button.widget!;
        e.nextAt = now + Math.max(MIN_INTERVAL_S, w.interval ?? 30) * 1000;
        try {
          const raw = await readWidget(w, this.deps, this.cpuState);
          const r = renderWidget(w, raw);
          const sig = `${r.label}|${r.btnColor ?? ''}`;
          this.values[key] = r.label;
          if (sig === e.last) return;
          e.last = sig;
          const dev = toDeviceButton(e.button)!;
          dev.label = r.label;
          if (r.btnColor) dev.btnColor = r.btnColor;
          this.enqueue(cmd.setBtnData(e.page, e.index, dev));
        } catch (err) {
          this.log(`widget ${key} (${w.source}): ${err instanceof Error ? err.message : err}`);
        }
      }),
    );
  }

  private enqueue(line: string): void {
    this.sendQueue.push(line);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.sendQueue.length) {
        await this.send(this.sendQueue.shift()!);
        await new Promise((r) => setTimeout(r, this.spacingMs));
      }
    } catch (e) {
      this.log(`widget send failed: ${e instanceof Error ? e.message : e}`);
      this.sendQueue = [];
    } finally {
      this.sending = false;
    }
  }
}
