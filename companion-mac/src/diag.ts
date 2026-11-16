import { hostname, totalmem, freemem, uptime } from 'node:os';
import type { Capture } from './actions.js';
import { cmd } from './protocol.js';
import { defaultCpuTimes } from './widgets.js';

/** Returns a function giving CPU busy percent since its previous call. */
export function makeCpuMeter(times: () => Array<{ idle: number; total: number }> = defaultCpuTimes): () => number {
  let prev = times();
  return () => {
    const now = times();
    let idle = 0, total = 0;
    now.forEach((c, i) => { if (prev[i]) { idle += c.idle - prev[i].idle; total += c.total - prev[i].total; } });
    prev = now;
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  };
}

export interface DiagSample {
  cpu: number; mem: number; disk: number; rx: number; tx: number; uptimeMin: number; host: string;
}

/** `vm_stat` -> used-memory percent (active + wired + compressed, like Activity Monitor's "used"). */
export function parseVmStat(out: string, totalBytes: number): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  const get = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1]);
  const active = get('Pages active'), wired = get('Pages wired down'), comp = get('Pages occupied by compressor');
  if (![page, active, wired].every(Number.isFinite) || !totalBytes) return null;
  const used = (active + wired + (Number.isFinite(comp) ? comp : 0)) * page;
  return Math.min(100, Math.round((used / totalBytes) * 100));
}

/** `df -k /` -> capacity percent. */
export function parseDf(out: string): number | null {
  const line = out.trim().split('\n')[1];
  const m = line && /\s(\d+)%/.exec(line);
  return m ? Number(m[1]) : null;
}

/** `netstat -ib` -> total bytes in/out across physical-looking interfaces (en*). */
export function parseNetstat(out: string): { rx: number; tx: number } {
  const seen = new Set<string>();
  let rx = 0, tx = 0;
  for (const line of out.split('\n')) {
    if (!/<Link#\d+>/.test(line)) continue;
    const t = line.trim().split(/\s+/);
    if (!/^en\d+\*?$/.test(t[0]) || seen.has(t[0]) || t.length < 8) continue;
    seen.add(t[0]);
    // Columns end: Ipkts Ierrs Ibytes Opkts Oerrs Obytes [Coll]; Coll is present on macOS.
    const hasColl = t.length >= 11 && /^\d+$/.test(t[t.length - 1]);
    const off = hasColl ? 1 : 0;
    const ib = Number(t[t.length - 4 - off]), ob = Number(t[t.length - 1 - off]);
    if (Number.isFinite(ib) && Number.isFinite(ob)) { rx += ib; tx += ob; }
  }
  return { rx, tx };
}

/** Gathers host metrics for the deck's diagnostics screen. Pure parsers above; I/O via `capture`. */
export class DiagCollector {
  private prevNet?: { rx: number; tx: number; at: number };

  constructor(
    private capture: Capture,
    private cpuPercent: () => number,
    private now: () => number = Date.now,
  ) {}

  async sample(): Promise<DiagSample> {
    const [vm, df, ns] = await Promise.all([
      this.capture('vm_stat', []).catch(() => ''),
      this.capture('df', ['-k', '/']).catch(() => ''),
      this.capture('netstat', ['-ib']).catch(() => ''),
    ]);
    const tot = totalmem();
    const mem = parseVmStat(vm, tot) ?? Math.round((1 - freemem() / tot) * 100);
    const net = parseNetstat(ns);
    const at = this.now();
    let rx = 0, tx = 0;
    if (this.prevNet && at > this.prevNet.at) {
      const s = (at - this.prevNet.at) / 1000;
      rx = Math.max(0, (net.rx - this.prevNet.rx) / 1024 / s);
      tx = Math.max(0, (net.tx - this.prevNet.tx) / 1024 / s);
    }
    this.prevNet = { ...net, at };
    return { cpu: this.cpuPercent(), mem, disk: parseDf(df) ?? 0, rx, tx, uptimeMin: uptime() / 60, host: hostname() };
  }

  async line(): Promise<string> {
    return cmd.diag(await this.sample());
  }
}
