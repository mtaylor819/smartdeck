import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comboToAppleScript, parseCombo } from './keymap.js';

export type Action =
  | { type: 'key'; combo: string }
  | { type: 'text'; text: string }
  | { type: 'app'; app: string }
  | { type: 'website'; url: string }
  | { type: 'script'; command: string }
  | { type: 'media'; key: MediaKey }
  | { type: 'sound'; file: string }
  | { type: 'http'; url: string; method?: string; body?: string; headers?: Record<string, string> }
  | { type: 'multi'; steps: Array<Action | { type: 'delay'; ms: number }> }
  | { type: 'delay'; ms: number }
  | { type: 'goto'; page: number }
  | { type: 'timer'; duration: number }
  | { type: 'counter'; counterStartValue?: number; counterAction?: 'increment' | 'decrement' | 'reset' }
  | { type: 'toggle'; on?: Action; off?: Action; onColor?: string }
  | { type: 'mouse'; op: 'click' | 'double' | 'right' | 'move' | 'scroll'; x?: number; y?: number; dx?: number; dy?: number }
  | { type: 'shortcut'; name: string; input?: string }
  | { type: 'applescript'; script: string }
  | { type: 'urlscheme'; url: string }
  | { type: 'paste'; text: string }
  | { type: 'ha'; service: string; entity?: string; data?: Record<string, unknown> }
  | { type: 'none' };

export type MediaKey =
  | 'play_pause' | 'next' | 'previous' | 'volume_up' | 'volume_down' | 'mute';

/** Runs a process and resolves when it exits. Injected so tests never touch the OS. */
export type Runner = (file: string, args: string[], opts?: { detached?: boolean }) => Promise<void>;

export const defaultRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached: opts?.detached });
    child.on('error', reject);
    if (opts?.detached) {
      child.unref();
      resolve();
      return;
    }
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`)),
    );
  });

// NX_KEYTYPE_* codes used by macOS system-defined media key events.
const NX: Record<MediaKey, number> = {
  volume_up: 0, volume_down: 1, mute: 7, play_pause: 16, next: 17, previous: 18,
};

// JXA: posts a system-defined media key down+up. Needs Accessibility permission.
const mediaKeyScript = (code: number) => `
ObjC.import('Cocoa');
function send(down) {
  var flags = down ? 0xa00 : 0xb00;
  var ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
    14, $.NSMakePoint(0, 0), flags, 0, 0, 0, 8, (${code} << 16) | flags, -1);
  $.CGEventPost(0, ev.CGEvent);
}
send(true); send(false);`;

/** Runs a process and returns its stdout. */
export type Capture = (file: string, args: string[]) => Promise<string>;

export const defaultCapture: Capture = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 10_000, maxBuffer: 1 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    ),
  );

export interface HaSettings {
  url: string;
  token?: string;
  tokenEnv?: string;
}

/** JXA mouse events via CGEvent. Needs Accessibility permission. */
export function mouseScript(a: Extract<Action, { type: 'mouse' }>): string {
  const num = (n: number | undefined) => (Number.isFinite(n) ? Number(n) : 0);
  const head = `ObjC.import('Cocoa');
function pos(){ var e=$.CGEventCreate(null); return $.CGEventGetLocation(e); }
function post(t,p,b){ var e=$.CGEventCreateMouseEvent(null,t,p,b); $.CGEventPost(0,e); }
function pt(x,y){ return {x:x,y:y}; }`;
  const at = a.x !== undefined && a.y !== undefined ? `pt(${num(a.x)},${num(a.y)})` : 'pos()';
  switch (a.op) {
    case 'move':
      return `${head}
post($.kCGEventMouseMoved, ${at}, 0);`;
    case 'click':
      return `${head}
var p=${at}; post($.kCGEventLeftMouseDown,p,0); post($.kCGEventLeftMouseUp,p,0);`;
    case 'right':
      return `${head}
var p=${at}; post($.kCGEventRightMouseDown,p,1); post($.kCGEventRightMouseUp,p,1);`;
    case 'double':
      return `${head}
var p=${at};
for (var i=1;i<=2;i++){ var d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,p,0);
  $.CGEventSetIntegerValueField(d,1,i); $.CGEventPost(0,d);
  var u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,p,0);
  $.CGEventSetIntegerValueField(u,1,i); $.CGEventPost(0,u); }`;
    case 'scroll':
      return `${head}
var e=$.CGEventCreateScrollWheelEvent(null,0,2,${-num(a.dy)},${num(a.dx)}); $.CGEventPost(0,e);`;
  }
}

const asString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class ActionExecutor {
  constructor(
    private run: Runner = defaultRunner,
    private log: (msg: string) => void = () => {},
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private ha: () => HaSettings | undefined = () => undefined,
  ) {}

  /** Execute an action. `toggleState` is the state the deck reports for toggle buttons. */
  async execute(action: Action, toggleState?: 0 | 1): Promise<void> {
    switch (action.type) {
      case 'key':
        return this.osa(comboToAppleScript(parseCombo(action.combo)));
      case 'text':
        return this.osa(`tell application "System Events" to keystroke ${asString(action.text)}`);
      case 'app':
        return this.run('open', action.app.includes('/') ? [action.app] : ['-a', action.app]);
      case 'website':
        if (!/^https?:\/\//i.test(action.url)) throw new Error(`Refusing non-http URL: ${action.url}`);
        return this.run('open', [action.url]);
      case 'script':
        return this.run('/bin/sh', ['-c', action.command], { detached: true });
      case 'sound':
        return this.run('afplay', [action.file], { detached: true });
      case 'media':
        return this.run('osascript', ['-l', 'JavaScript', '-e', mediaKeyScript(NX[action.key])]);
      case 'http': {
        const res = await this.fetchImpl(action.url, {
          method: action.method ?? 'GET',
          headers: action.headers,
          body: action.body,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${action.url}`);
        return;
      }
      case 'mouse':
        return this.run('osascript', ['-l', 'JavaScript', '-e', mouseScript(action)]);
      case 'shortcut': {
        const args = ['run', action.name];
        if (action.input !== undefined) {
          const f = join(mkdtempSync(join(tmpdir(), 'smartdeck-')), 'input.txt');
          writeFileSync(f, action.input, { mode: 0o600 });
          args.push('-i', f);
        }
        return this.run('shortcuts', args, { detached: true });
      }
      case 'applescript':
        return this.osa(action.script);
      case 'urlscheme':
        if (!/^[a-z][a-z0-9+.-]*:/i.test(action.url) || /^(file|javascript|data):/i.test(action.url))
          throw new Error(`Refusing URL scheme: ${action.url}`);
        return this.run('open', [action.url]);
      case 'paste':
        return this.osa(
          `set old to the clipboard\nset the clipboard to ${asString(action.text)}\n` +
            `tell application "System Events" to keystroke "v" using {command down}\n` +
            `delay 0.4\ntry\nset the clipboard to old\nend try`,
        );
      case 'ha':
        return this.callHomeAssistant(action);
      case 'delay':
        return this.sleep(action.ms);
      case 'multi':
        for (const step of action.steps) await this.execute(step);
        return;
      case 'toggle': {
        const next = toggleState === 0 ? action.off : action.on;
        if (next) await this.execute(next);
        return;
      }
      case 'goto': // handled on-device
      case 'timer':
      case 'counter':
      case 'none':
        return;
      default: {
        const t = (action as { type: string }).type;
        this.log(`Unsupported action type "${t}"`);
      }
    }
  }

  private async callHomeAssistant(a: Extract<Action, { type: 'ha' }>): Promise<void> {
    const ha = this.ha();
    const token = ha?.token || (ha?.tokenEnv ? process.env[ha.tokenEnv] : undefined);
    if (!ha?.url || !token) throw new Error('Home Assistant is not configured (url + token)');
    const m = /^([a-z_]+)\.([a-z0-9_]+)$/.exec(a.service);
    if (!m) throw new Error(`Bad HA service "${a.service}" (expected domain.service)`);
    const res = await this.fetchImpl(`${ha.url.replace(/\/+$/, '')}/api/services/${m[1]}/${m[2]}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(a.entity ? { entity_id: a.entity } : {}), ...a.data }),
    });
    if (!res.ok) throw new Error(`Home Assistant ${a.service}: HTTP ${res.status}`);
  }

  private osa(script: string): Promise<void> {
    return this.run('osascript', ['-e', script]);
  }
}
