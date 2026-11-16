import { spawn } from 'node:child_process';
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

const asString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class ActionExecutor {
  constructor(
    private run: Runner = defaultRunner,
    private log: (msg: string) => void = () => {},
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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

  private osa(script: string): Promise<void> {
    return this.run('osascript', ['-e', script]);
  }
}
