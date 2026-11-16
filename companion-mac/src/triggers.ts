import type { Capture, HaSettings } from './actions.js';
import type { Config, TriggerConfig } from './config.js';
import { jsonPath } from './widgets.js';

export type TriggerAlertKind = 'red' | 'yellow' | 'blue' | 'green';

export interface TriggerDeps {
  getConfig: () => Config;
  fetchImpl: typeof fetch;
  capture: Capture;
  alert: (kind: TriggerAlertKind, seconds: number, text: string) => Promise<void>;
  ha: () => HaSettings | undefined;
  log: (m: string) => void;
  now?: () => number;
}

export interface TriggerStatus {
  /** idle = watching; firing = condition active and alert delivered; cooldown = condition active/recent but suppressed by cooldown. */
  state: 'idle' | 'firing' | 'cooldown' | 'error' | 'disabled';
  lastFired?: number;
  lastValue?: string;
  error?: string;
}

export const MIN_INTERVAL_S = 10;
export const DEFAULT_INTERVAL_S = 30;
export const DEFAULT_COOLDOWN_MIN = 5;
/** Alert length when the trigger doesn't say (0 would mean "until touched", which is easy to forget about). */
export const DEFAULT_ALERT_SECONDS = 60;
const FETCH_TIMEOUT_MS = 8000;
const PENDING_TTL_MS = 10 * 60_000;

// ------------------------------------------------------------------ validation

const SOURCE_TYPES = ['moonraker', 'ha_state', 'http_json', 'github', 'command'];
const KINDS = ['red', 'yellow', 'blue', 'green'];
const OPS = ['>', '<', '==', '!=', 'contains'];

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function httpUrl(v: unknown, what: string): void {
  if (typeof v !== 'string' || !v) throw new Error(`${what} is required`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${what} must be http:// or https://`);
}

/** Throws a user-readable Error when `list` is not a valid triggers array. undefined is fine (no triggers). */
export function validateTriggers(list: unknown): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new Error('triggers must be a list');
  const seen = new Set<string>();
  list.forEach((t, i) => {
    if (!isObj(t)) throw new Error(`trigger #${i + 1} must be an object`);
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (!name) throw new Error(`trigger #${i + 1} needs a name`);
    if (name.length > 40) throw new Error(`trigger "${name.slice(0, 20)}…" name is longer than 40 characters`);
    const w = `trigger "${name}"`;
    if (seen.has(name)) throw new Error(`${w}: name is used twice (names must be unique)`);
    seen.add(name);
    if (t.enabled !== undefined && typeof t.enabled !== 'boolean') throw new Error(`${w}: enabled must be true or false`);

    const s = t.source;
    if (!isObj(s) || typeof s.type !== 'string' || !SOURCE_TYPES.includes(s.type))
      throw new Error(`${w}: source type must be one of ${SOURCE_TYPES.join(', ')}`);
    switch (s.type) {
      case 'moonraker':
        httpUrl(s.url, `${w}: Moonraker URL`);
        if (!['finished', 'error', 'finished_or_error'].includes(s.on)) throw new Error(`${w}: "on" must be finished, error or finished_or_error`);
        break;
      case 'ha_state':
        if (typeof s.entity !== 'string' || !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(s.entity))
          throw new Error(`${w}: entity must look like light.desk`);
        if (s.equals !== undefined && typeof s.equals !== 'string') throw new Error(`${w}: equals must be text`);
        if (s.notEquals !== undefined && typeof s.notEquals !== 'string') throw new Error(`${w}: notEquals must be text`);
        if (s.equals === undefined && s.notEquals === undefined) throw new Error(`${w}: set equals or notEquals`);
        break;
      case 'http_json':
        httpUrl(s.url, `${w}: URL`);
        if (typeof s.jsonPath !== 'string') throw new Error(`${w}: jsonPath is required (e.g. data.temp)`);
        if (!OPS.includes(s.op)) throw new Error(`${w}: op must be one of ${OPS.join(' ')}`);
        if (typeof s.value !== 'string' && !(typeof s.value === 'number' && Number.isFinite(s.value)))
          throw new Error(`${w}: value must be text or a number`);
        break;
      case 'github':
        if (typeof s.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repo)) throw new Error(`${w}: repo must look like owner/name`);
        if (s.tokenEnv !== undefined && (typeof s.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.tokenEnv)))
          throw new Error(`${w}: tokenEnv must be an environment variable name`);
        break;
      case 'command':
        if (typeof s.command !== 'string' || !s.command.trim()) throw new Error(`${w}: command is required`);
        if (s.command.length > 500) throw new Error(`${w}: command is longer than 500 characters`);
        if (s.on !== undefined && s.on !== 'nonzero' && s.on !== 'output') throw new Error(`${w}: "on" must be nonzero or output`);
        if (s.match !== undefined && (typeof s.match !== 'string' || s.match.length > 200)) throw new Error(`${w}: match must be text up to 200 characters`);
        if (s.on === 'output' && !s.match) throw new Error(`${w}: "output" needs a match text`);
        break;
    }

    const a = t.alert;
    if (!isObj(a) || !KINDS.includes(a.kind)) throw new Error(`${w}: alert kind must be red, yellow, blue or green`);
    if (a.seconds !== undefined && !(typeof a.seconds === 'number' && Number.isFinite(a.seconds) && a.seconds >= 0 && a.seconds <= 3600))
      throw new Error(`${w}: alert seconds must be 0-3600`);
    if (a.text !== undefined) {
      if (typeof a.text !== 'string' || a.text.length > 24) throw new Error(`${w}: alert text must be 24 characters or fewer`);
      if (!/^[\x20-\x7e]*$/.test(a.text) || a.text.includes(':')) throw new Error(`${w}: alert text must be plain ASCII without colons`);
    }
    if (t.interval !== undefined && !(typeof t.interval === 'number' && Number.isFinite(t.interval) && t.interval >= MIN_INTERVAL_S && t.interval <= 86400))
      throw new Error(`${w}: interval must be ${MIN_INTERVAL_S}-86400 seconds`);
    if (t.cooldownMin !== undefined && !(typeof t.cooldownMin === 'number' && Number.isFinite(t.cooldownMin) && t.cooldownMin >= 0 && t.cooldownMin <= 10080))
      throw new Error(`${w}: cooldownMin must be 0-10080 minutes`);
  });
}

// ------------------------------------------------------------------ engine

interface Eval {
  /** Is the "bad" condition true right now? (For event-like sources: true for exactly the poll that saw the event.) */
  cond: boolean;
  value: string;
  /** Default alert banner text for this event. */
  text?: string;
}

interface Pending {
  kind: TriggerAlertKind;
  seconds: number;
  text: string;
  expires: number;
}

interface Runtime {
  sig: string;
  baseline: boolean;
  active: boolean;
  firedForActive: boolean;
  busy: boolean;
  nextAt: number;
  cooldownUntil: number;
  lastFired?: number;
  lastValue?: string;
  error?: string;
  lastErrKey?: string;
  pending?: Pending;
  // per-source memory
  prevPrintState?: string;
  judgedInit?: boolean;
  judgedId?: number;
}

/** Printable ASCII, no colons (the ALERT command is colon-delimited), max 24. */
export function cleanAlertText(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '').replace(/:/g, ' ').trim().slice(0, 24).trim() || 'Alert';
}

/** Polls external sources and turns *new* bad events into deck alerts. Edge-triggered, with a cooldown. */
export class TriggerEngine {
  private timer?: NodeJS.Timeout;
  private rts = new Map<string, Runtime>();
  /** Secrets seen while evaluating the current trigger; scrubbed from anything we log or store. */
  private secrets: string[] = [];

  constructor(private d: TriggerDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  start(tickMs = 1000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick().catch((e) => this.d.log(`triggers: ${this.scrub(e instanceof Error ? e.message : String(e))}`)), tickMs);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): Record<string, TriggerStatus> {
    const out: Record<string, TriggerStatus> = {};
    const now = this.now();
    for (const t of this.d.getConfig().triggers ?? []) {
      const rt = this.rts.get(t.name);
      if (t.enabled === false) {
        out[t.name] = { state: 'disabled' };
        continue;
      }
      if (!rt) {
        out[t.name] = { state: 'idle' };
        continue;
      }
      const state: TriggerStatus['state'] = rt.error
        ? 'error'
        : rt.active && rt.firedForActive
          ? 'firing'
          : now < rt.cooldownUntil
            ? 'cooldown'
            : 'idle';
      out[t.name] = { state, lastFired: rt.lastFired, lastValue: rt.lastValue, error: rt.error };
    }
    return out;
  }

  /** Run every trigger that is due. Called once a second by start(); call directly in tests. */
  async tick(): Promise<void> {
    const list = this.d.getConfig().triggers ?? [];
    const names = new Set(list.map((t) => t.name));
    for (const k of [...this.rts.keys()]) if (!names.has(k)) this.rts.delete(k);

    const now = this.now();
    await Promise.all(
      list.map(async (t) => {
        if (t.enabled === false) return;
        const sig = JSON.stringify(t);
        let rt = this.rts.get(t.name);
        if (!rt || rt.sig !== sig) {
          // new or edited trigger: forget everything and re-baseline
          rt = { sig, baseline: false, active: false, firedForActive: false, busy: false, nextAt: 0, cooldownUntil: 0 };
          this.rts.set(t.name, rt);
        }
        if (rt.busy || now < rt.nextAt) return;
        rt.busy = true;
        rt.nextAt = now + Math.max(MIN_INTERVAL_S, t.interval ?? DEFAULT_INTERVAL_S) * 1000;
        try {
          await this.runOne(t, rt, now);
        } finally {
          rt.busy = false;
        }
      }),
    );
  }

  private async runOne(t: TriggerConfig, rt: Runtime, now: number): Promise<void> {
    // 1. deliver an alert that failed earlier (e.g. deck was unplugged), if it's still fresh
    if (rt.pending) {
      if (now > rt.pending.expires) rt.pending = undefined;
      else if (await this.deliver(t, rt, rt.pending, now)) rt.pending = undefined;
    }

    // 2. look at the source
    this.secrets = [];
    let ev: Eval;
    try {
      ev = await this.evaluate(t, rt);
      rt.error = undefined;
      rt.lastErrKey = undefined;
    } catch (e) {
      const msg = this.scrub(e instanceof Error ? e.message : String(e));
      rt.error = msg;
      if (rt.lastErrKey !== msg) this.d.log(`trigger "${t.name}": ${msg}`);
      rt.lastErrKey = msg;
      return;
    }
    rt.lastValue = ev.value;

    // 3. edge detection
    const wasActive = rt.active;
    rt.active = ev.cond;
    if (!ev.cond) rt.firedForActive = false;
    if (!rt.baseline) {
      rt.baseline = true;
      // First look only records what's already true; but a failing `command` is news by definition.
      if (t.source.type !== 'command') return;
    }
    if (!ev.cond || wasActive) return;
    if (now < rt.cooldownUntil) return; // suppressed; stays active so it won't re-fire when the cooldown ends

    const alert: Pending = {
      kind: t.alert.kind,
      seconds: t.alert.seconds ?? DEFAULT_ALERT_SECONDS,
      text: cleanAlertText(t.alert.text ?? ev.text ?? t.name),
      expires: now + PENDING_TTL_MS,
    };
    if (!(await this.deliver(t, rt, alert, now))) rt.pending = alert;
  }

  private async deliver(t: TriggerConfig, rt: Runtime, a: Pending, now: number): Promise<boolean> {
    try {
      await this.d.alert(a.kind, a.seconds, a.text);
    } catch (e) {
      this.d.log(`trigger "${t.name}": alert not delivered (${this.scrub(e instanceof Error ? e.message : String(e))}); will retry`);
      return false;
    }
    rt.lastFired = now;
    rt.firedForActive = true;
    rt.cooldownUntil = now + (t.cooldownMin ?? DEFAULT_COOLDOWN_MIN) * 60_000;
    this.d.log(`trigger "${t.name}" fired (${a.kind}: ${a.text})`);
    return true;
  }

  // ---------------------------------------------------------------- sources

  private scrub(msg: string): string {
    let out = msg;
    for (const s of this.secrets) if (s) out = out.split(s).join('***');
    return out;
  }

  private async getJson(url: string, headers?: Record<string, string>): Promise<any> {
    const res = await this.d.fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // Never put the URL in messages: it may carry credentials (http://user:pass@host).
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private async evaluate(t: TriggerConfig, rt: Runtime): Promise<Eval> {
    const s = t.source;
    switch (s.type) {
      case 'moonraker': {
        const j = await this.getJson(s.url.replace(/\/+$/, '') + '/printer/objects/query?print_stats');
        const st = j?.result?.status?.print_stats?.state;
        if (typeof st !== 'string') throw new Error('unexpected Moonraker response');
        const prev = rt.prevPrintState;
        rt.prevPrintState = st;
        const wantDone = s.on === 'finished' || s.on === 'finished_or_error';
        const wantErr = s.on === 'error' || s.on === 'finished_or_error';
        if (prev === 'printing' && st === 'complete' && wantDone) return { cond: true, value: st, text: 'Print finished' };
        if (prev === 'printing' && st === 'error' && wantErr) return { cond: true, value: st, text: 'Print failed' };
        return { cond: false, value: st };
      }
      case 'ha_state': {
        const ha = this.d.ha();
        const token = ha?.token || (ha?.tokenEnv ? process.env[ha.tokenEnv] : undefined);
        if (!ha?.url || !token) throw new Error('Home Assistant is not configured (url + token)');
        this.secrets.push(token);
        const j = await this.getJson(`${ha.url.replace(/\/+$/, '')}/api/states/${encodeURIComponent(s.entity)}`, { Authorization: `Bearer ${token}` });
        const state = String(j?.state);
        const cond = s.equals !== undefined ? state === s.equals : state !== s.notEquals;
        return { cond, value: state };
      }
      case 'http_json': {
        const j = await this.getJson(s.url);
        const v = jsonPath(j, s.jsonPath);
        if (v === undefined) throw new Error(`"${s.jsonPath}" not found in response`);
        return { cond: compare(v, s.op, s.value), value: String(v) };
      }
      case 'github': {
        const token = s.tokenEnv ? process.env[s.tokenEnv] : undefined;
        if (token) this.secrets.push(token);
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'smartdeck-mac' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const j = await this.getJson(`https://api.github.com/repos/${s.repo}/actions/runs?per_page=1`, headers);
        const run = j?.workflow_runs?.[0];
        if (!run) return { cond: false, value: 'no runs' };
        const first = !rt.judgedInit;
        rt.judgedInit = true;
        if (run.status !== 'completed') return { cond: false, value: 'in progress' };
        // A run that already finished when we started watching is history, not news.
        const fresh = !first && run.id !== rt.judgedId;
        rt.judgedId = run.id;
        const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out';
        return { cond: fresh && failed, value: String(run.conclusion), text: `${s.repo.split('/')[1]} CI failed` };
      }
      case 'command': {
        let out: string;
        try {
          out = await this.d.capture('/bin/sh', ['-c', s.command]);
        } catch (e) {
          const err = e as { code?: unknown; killed?: boolean; message?: string };
          // A nonzero exit has a numeric code. Timeouts (killed) and spawn failures (ENOENT, EACCES...) are real errors.
          const nonzero = !err.killed && (typeof err.code === 'number' || err.code === undefined);
          if ((s.on ?? 'nonzero') === 'nonzero' && nonzero) return { cond: true, value: `exit ${typeof err.code === 'number' ? err.code : '≠0'}` };
          if (nonzero) return { cond: false, value: `exit ${typeof err.code === 'number' ? err.code : '≠0'}` };
          throw new Error(err.killed ? 'command timed out' : `command failed to run: ${String(err.code ?? err.message ?? 'error')}`);
        }
        const trimmed = out.trim();
        if ((s.on ?? 'nonzero') === 'output') return { cond: trimmed.includes(s.match ?? '\u0000'), value: trimmed.slice(0, 80) };
        return { cond: false, value: 'exit 0' };
      }
    }
  }
}

/** Numeric compare when both sides are numbers, otherwise string compare. */
function compare(actual: unknown, op: '>' | '<' | '==' | '!=' | 'contains', want: string | number): boolean {
  const an = typeof actual === 'number' ? actual : typeof actual === 'string' && actual.trim() !== '' ? Number(actual) : NaN;
  const wn = typeof want === 'number' ? want : want.trim() !== '' ? Number(want) : NaN;
  const numeric = Number.isFinite(an) && Number.isFinite(wn);
  switch (op) {
    case '>':
    case '<':
      if (!numeric) throw new Error(`cannot compare "${String(actual).slice(0, 30)}" with "${String(want).slice(0, 30)}" as numbers`);
      return op === '>' ? an > wn : an < wn;
    case '==':
      return numeric ? an === wn : String(actual) === String(want);
    case '!=':
      return numeric ? an !== wn : String(actual) !== String(want);
    case 'contains':
      return String(actual).includes(String(want));
  }
}
