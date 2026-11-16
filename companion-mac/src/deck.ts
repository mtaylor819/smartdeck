import { EventEmitter } from 'node:events';
import { ActionExecutor } from './actions.js';
import { Config, findButton, toDeviceConfig } from './config.js';
import { cmd, DeviceEvent, knobDelta, NetStatus, parseLine } from './protocol.js';
import type { Transport } from './transport.js';

export interface UploadFile {
  name: string;
  data: Buffer;
}

const MAX_PENDING_KNOB_STEPS = 12;

/** Drives one connected deck: handles its events and executes the configured actions. */
export class Deck extends EventEmitter {
  private lastKnob: number | null = null;
  private knobAcc = 0;
  private pendingSteps = 0; // signed
  private draining = false;
  private page = 0;
  private waiters = new Set<(line: string) => boolean>();
  private pending = new Set<{ cancel: (why: string) => void }>();
  private uploading = false;
  private getConfig: () => Config;
  private hbTimer?: NodeJS.Timeout;
  /** Last NET_STATUS the deck reported (WiFi/BLE state). */
  net: NetStatus = {};
  lux?: number;

  private get config(): Config {
    return this.getConfig();
  }

  constructor(
    private t: Transport,
    cfg: Config | (() => Config),
    private exec: ActionExecutor,
    private log: (msg: string) => void = () => {},
    private now: () => Date = () => new Date(),
    private feedback: (kind: 'press' | 'error') => void = () => {},
  ) {
    super();
    this.getConfig = typeof cfg === 'function' ? cfg : () => cfg;
    t.on('line', (line: string) => this.onLine(line));
    t.on('close', () => {
      if (this.hbTimer) clearInterval(this.hbTimer);
      for (const e of [...this.pending]) e.cancel('link closed'); // no orphaned timers after a dropped link
      this.emit('close');
    });
  }

  /** Push state the deck needs after connecting. */
  async start(): Promise<void> {
    await this.send(cmd.setTime(this.now()));
    await this.send(cmd.setBrightness(this.config.brightness));
    const led = this.config.knob.led;
    if (led) await this.send(cmd.setKnobLed(led.r, led.g, led.b, led.tail));
    const pw = this.config.power;
    if (pw?.sleepMinutes !== undefined) await this.send(cmd.setSleep(pw.sleepMinutes));
    if (pw?.deepSleepMinutes !== undefined) await this.send(cmd.setDeepSleep(pw.deepSleepMinutes));
    if (pw?.dimLed) await this.send(cmd.setDimLed(pw.dimLed));
    if (pw?.ledBrightness !== undefined) await this.send(cmd.setLedBrightness(pw.ledBrightness));
    if (this.config.sleepScreen) await this.send(cmd.setSleepScreen(this.config.sleepScreen));
    await this.send(cmd.getSync()); // deck replies with SYNC_PAGE / KNOB_RAW / SYNC_STATE...
  }

  /**
   * Tell the deck a host is present (so it reports presses to us instead of acting standalone).
   * Only call this once the deck has proven it understands the new protocol: the stock firmware treats
   * any unknown command (including HB) as activity and would never go to sleep.
   */
  startHeartbeat(everyMs = 5000): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => void this.send(cmd.hb()).catch(() => {}), everyMs);
    this.hbTimer.unref?.();
    void this.send(cmd.hb()).catch(() => {});
  }

  /** Ask for NET_STATUS. Resolves null if the deck doesn't answer (= firmware without the WiFi/BLE module). */
  requestNetStatus(timeoutMs = 1500): Promise<NetStatus | null> {
    return new Promise((resolve) => {
      const onEv = (ev: DeviceEvent) => {
        if (ev.type !== 'netStatus') return;
        clearTimeout(timer);
        this.off('event', onEv);
        resolve(ev.status);
      };
      const timer = setTimeout(() => { this.off('event', onEv); resolve(null); }, timeoutMs);
      this.on('event', onEv);
      this.send(cmd.getNet()).catch(() => { clearTimeout(timer); this.off('event', onEv); resolve(null); });
    });
  }

  /** Send one protocol line. Refuses embedded newlines (command injection) and anything during an upload (it would end up inside the file). */
  send(line: string): Promise<void> {
    if (/[\r\n]/.test(line)) return Promise.reject(new Error('refusing to send a line containing a newline'));
    if (this.uploading) return Promise.reject(new Error('upload in progress'));
    return this.t.write(line + '\n');
  }

  close(): Promise<void> {
    return this.t.close();
  }

  private onLine(line: string): void {
    for (const w of [...this.waiters]) if (w(line)) this.waiters.delete(w);
    const ev = parseLine(line);
    this.handle(ev).catch((e) => this.log(`error handling "${line}": ${e instanceof Error ? e.message : e}`));
  }

  private async handle(ev: DeviceEvent): Promise<void> {
    switch (ev.type) {
      case 'button': {
        const b = findButton(this.config, ev.page, ev.index);
        if (!b) return this.log(`button ${ev.page}:${ev.index} has no action`);
        this.log(`button ${ev.page}:${ev.index} ${b.label ?? ''} (${b.action.type})`);
        this.feedback('press');
        try {
          await this.exec.execute(b.action, ev.state);
        } catch (e) {
          this.feedback('error');
          this.log(`action failed: ${e instanceof Error ? e.message : e}`);
        }
        return;
      }
      case 'hold': {
        const b = findButton(this.config, ev.page, ev.index);
        if (!b?.hold) return this.log(`hold ${ev.page}:${ev.index} has no hold action`);
        this.log(`hold ${ev.page}:${ev.index} ${b.label ?? ''} (${b.hold.type})`);
        this.feedback('press');
        try {
          await this.exec.execute(b.hold);
        } catch (e) {
          this.feedback('error');
          this.log(`hold action failed: ${e instanceof Error ? e.message : e}`);
        }
        return;
      }
      case 'netStatus':
        this.net = ev.status;
        this.emit('event', ev);
        return;
      case 'lux':
        this.lux = ev.value;
        return;
      case 'alertAck':
        this.log(`alert acknowledged on deck (${ev.kind})`);
        this.emit('event', ev);
        return;
      case 'knob':
        return this.onKnob(ev.raw);
      case 'page':
        this.page = ev.page;
        return;
      case 'getTime':
        return this.send(cmd.setTime(this.now()));
      default:
        this.emit('event', ev);
    }
  }

  get currentPage(): number {
    return this.page;
  }

  private onKnob(raw: number): void {
    if (this.lastKnob === null) {
      this.lastKnob = raw;
      return;
    }
    this.knobAcc += knobDelta(this.lastKnob, raw);
    this.lastKnob = raw;
    const { step, invert } = this.config.knob;
    const steps = Math.trunc(this.knobAcc / step);
    if (steps === 0) return;
    this.knobAcc -= steps * step;
    const signed = invert ? -steps : steps;
    this.pendingSteps = clampAbs(this.pendingSteps + signed, MAX_PENDING_KNOB_STEPS);
    void this.drainKnob();
  }

  /** Executes queued knob steps one at a time so slow osascript calls can't pile up. */
  private async drainKnob(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingSteps !== 0) {
        const dir = this.pendingSteps > 0 ? 1 : -1;
        this.pendingSteps -= dir;
        const action = dir > 0 ? this.config.knob.cw : this.config.knob.ccw;
        try {
          await this.exec.execute(action);
        } catch (e) {
          this.log(`knob action failed: ${e instanceof Error ? e.message : e}`);
          this.pendingSteps = 0;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private waitFor(match: (line: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    const p = new Promise<string>((resolve, reject) => {
      const entry = {
        cancel: (why: string) => {
          clearTimeout(timer);
          this.waiters.delete(w);
          this.pending.delete(entry);
          reject(new Error(why));
        },
      };
      const timer = setTimeout(() => entry.cancel(`timed out waiting for ${what}`), timeoutMs);
      const w = (line: string) => {
        if (!match(line)) return false;
        clearTimeout(timer);
        this.pending.delete(entry);
        resolve(line);
        return true;
      };
      this.waiters.add(w);
      this.pending.add(entry);
    });
    p.catch(() => {}); // an orphaned waiter (upload aborted, link dropped) must never become an unhandled rejection
    return p;
  }

  /**
   * Upload files to the deck's SD card (USB upload mode). The deck reboots afterwards.
   * Always include esp_config.json to replace the layout; JPGs are button icons.
   */
  async upload(files: UploadFile[]): Promise<void> {
    if (this.uploading) throw new Error('an upload is already in progress');
    for (const f of files) if (/[:/\\\r\n]/.test(f.name)) throw new Error(`bad upload filename: ${f.name}`);
    this.uploading = true;
    const line = (l: string) => this.t.write(l + '\n'); // internal: bypasses the upload guard in send()
    const expect = (m: string, ms = 5000) => this.waitFor((l) => l.trim() === m, ms, m);
    try {
      const ready = expect('READY');
      await line(cmd.startUpload());
      await ready;
      for (const f of files) {
        const ok = this.waitFor((l) => /^(OK_FILE|ERR_[A-Z_]+)/.test(l.trim()), 5000, 'OK_FILE');
        await line(cmd.fileHeader(f.name, f.data.length));
        const r = (await ok).trim();
        if (r !== 'OK_FILE') throw new Error(`deck rejected ${f.name}: ${r}`);
        const done = this.waitFor((l) => /^(OK_DATA|ERR_[A-Z_]+)/.test(l.trim()), 15000, 'OK_DATA');
        await this.t.write(f.data);
        const d = (await done).trim();
        if (d !== 'OK_DATA') throw new Error(`upload of ${f.name} failed: ${d}`);
      }
      const end = expect('DONE_REBOOT', 10000);
      await line(cmd.endUpload());
      await end;
    } finally {
      this.uploading = false;
      for (const e of [...this.pending]) e.cancel('upload finished'); // drop any waiter left over from an aborted step
    }
  }

  /** Convenience: upload the current config as esp_config.json plus any icon files. */
  uploadConfig(icons: UploadFile[] = []): Promise<void> {
    const json = Buffer.from(JSON.stringify(toDeviceConfig(this.config)));
    return this.upload([{ name: 'esp_config.json', data: json }, ...icons]);
  }
}

function clampAbs(n: number, max: number): number {
  return Math.max(-max, Math.min(max, n));
}
