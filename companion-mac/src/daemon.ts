import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ActionExecutor, Action, defaultCapture, defaultRunner, Capture, Runner } from './actions.js';
import { DiagCollector, makeCpuMeter } from './diag.js';
import { SoundPlayer } from './sounds.js';
import { AppWatcher } from './appwatch.js';
import type { DaemonApi, DeckStatus } from './api.js';
import { Config, configPath, loadConfig, validate, writeDefaultConfig } from './config.js';
import { Deck, UploadFile } from './deck.js';
import { AlertKind, cmd } from './protocol.js';
import { scheduledBrightness } from './schedule.js';
import { findDeck, listCandidatePorts, TcpTransport, Transport } from './transport.js';
import { defaultCpuTimes, WidgetManager } from './widgets.js';
import { weatherLine } from './weather.js';

const WEATHER_EVERY_MS = 15 * 60_000;
const DIAG_EVERY_MS = 5_000;
const SCHEDULE_EVERY_MS = 30_000;
const WIFI_RETRY_MS = 3_000;

export interface DaemonOptions {
  configFile?: string;
  port?: string; // explicit serial port
  runner?: Runner;
  capture?: Capture;
  fetchImpl?: typeof fetch;
}

/** Long-running process: connects to the deck, runs features, and exposes DaemonApi to the UI. */
export class Daemon implements DaemonApi {
  private config: Config;
  private deck?: Deck;
  private portPath?: string;
  private deviceName?: string;
  private logLines: string[] = [];
  private stopped = false;
  private exec: ActionExecutor;
  private widgets: WidgetManager;
  private appWatch: AppWatcher;
  private weatherTimer?: NodeJS.Timeout;
  private diagTimer?: NodeJS.Timeout;
  private schedTimer?: NodeJS.Timeout;
  private lastSched?: number;
  private link?: 'usb' | 'wifi';
  private lastWifiTry = 0;
  private lastWifiErr = '';
  private diag: DiagCollector;
  private sounds: SoundPlayer;
  private readonly file: string;
  private readonly capture: Capture;
  private readonly fetchImpl: typeof fetch;

  constructor(private opts: DaemonOptions = {}) {
    this.file = opts.configFile ?? configPath();
    writeDefaultConfig(this.file);
    this.config = loadConfig(this.file);
    this.capture = opts.capture ?? defaultCapture;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const ha = () => this.config.integrations?.homeassistant;
    this.exec = new ActionExecutor(opts.runner, (m) => this.log(m), this.fetchImpl, undefined, ha);
    this.widgets = new WidgetManager(
      () => this.config,
      (l) => this.send(l),
      { capture: this.capture, fetchImpl: this.fetchImpl, ha, cpuTimes: defaultCpuTimes },
      (m) => this.log(m),
    );
    this.diag = new DiagCollector(this.capture, makeCpuMeter());
    this.sounds = new SoundPlayer(() => this.config, opts.runner ?? defaultRunner, (m) => this.log(m));
    this.appWatch = new AppWatcher(() => this.config, this.capture, (p) => this.send(cmd.setPage(p)), (m) => this.log(m));
  }

  private log(msg: string): void {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(line);
    this.logLines.push(line);
    if (this.logLines.length > 200) this.logLines.shift();
  }

  private async send(line: string): Promise<void> {
    if (!this.deck) throw new Error('deck not connected');
    await this.deck.send(line);
  }

  // ---- DaemonApi ----
  getConfig(): Config {
    return this.config;
  }

  setConfig(next: Config): void {
    validate(next);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); // may hold a HA token
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
    this.config = next;
    this.widgets.reset();
    this.log('config saved');
    void this.applyLiveSettings();
  }

  status(): DeckStatus {
    return {
      connected: !!this.deck,
      deviceName: this.deviceName,
      port: this.portPath,
      page: this.deck?.currentPage ?? 0,
      log: [...this.logLines],
      widgets: { ...this.widgets.values },
      link: this.deck ? this.link : undefined,
      net: this.deck?.net,
      lux: this.deck?.lux,
    };
  }

  async sync(): Promise<void> {
    if (!this.deck) throw new Error('No deck connected');
    this.log('uploading config to deck...');
    await this.deck.uploadConfig(this.loadIcons());
    this.widgets.reset();
    this.log('upload complete; deck is rebooting');
  }

  testAction(action: Action): Promise<void> {
    return this.exec.execute(action);
  }

  async alert(kind: AlertKind | 'off', seconds = 0, text = ''): Promise<void> {
    await this.send(kind === 'off' ? cmd.alertOff() : cmd.alert(kind, seconds, text));
  }

  /** Force-send WiFi/BLE/standalone/auto-dim/gesture settings to the deck. */
  async provision(): Promise<void> {
    if (!this.deck) throw new Error('No deck connected');
    await this.provisionIfNeeded(true);
  }

  iconsDir(): string {
    return join(dirname(this.file), 'icons');
  }

  iconsChanged(): void {
    this.log('icons changed (run Sync to upload them)');
  }

  private loadIcons(): UploadFile[] {
    const dir = this.iconsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /\.jpe?g$/i.test(f))
      .map((name) => ({ name, data: readFileSync(join(dir, name)) }));
  }

  /** Re-send settings that don't need a full upload (brightness, power, knob LED, weather). */
  private async applyLiveSettings(): Promise<void> {
    if (!this.deck) return;
    try {
      const c = this.config;
      await this.deck.send(cmd.setBrightness(c.brightness));
      if (c.knob.led) await this.deck.send(cmd.setKnobLed(c.knob.led.r, c.knob.led.g, c.knob.led.b, c.knob.led.tail));
      const pw = c.power;
      if (pw?.sleepMinutes !== undefined) await this.deck.send(cmd.setSleep(pw.sleepMinutes));
      if (pw?.deepSleepMinutes !== undefined) await this.deck.send(cmd.setDeepSleep(pw.deepSleepMinutes));
      if (pw?.dimLed) await this.deck.send(cmd.setDimLed(pw.dimLed));
      if (pw?.ledBrightness !== undefined) await this.deck.send(cmd.setLedBrightness(pw.ledBrightness));
      if (c.sleepScreen) await this.deck.send(cmd.setSleepScreen(c.sleepScreen));
      await this.pushDiag();
      await this.pushWeather();
    } catch (e) {
      this.log(`apply settings: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async pushWeather(): Promise<void> {
    const w = this.config.weather;
    if (!w || !this.deck) return;
    try {
      await this.deck.send(await weatherLine(w, this.fetchImpl));
    } catch (e) {
      this.log(`weather: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async pushDiag(): Promise<void> {
    if (!['diag', 'diag-anim'].includes(this.config.sleepScreen ?? '') || !this.deck) return;
    try {
      await this.deck.send(await this.diag.line());
    } catch (e) {
      this.log(`diagnostics: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Settings blob for SET_NET. Secrets (WiFi password, token, HA token) are only included when `secrets` is true. */
  provisionBlob(secrets: boolean): Record<string, unknown> {
    const d = this.config.device;
    const net: Record<string, unknown> = {};
    if (!d) return net;
    if (d.host) net.host = d.host;
    if (d.tz) net.tz = d.tz;
    if (d.standalone) net.standalone = d.standalone;
    if (d.wifi?.ssid) net.ssid = d.wifi.ssid;
    if (d.ha?.url) net.ha_url = d.ha.url;
    if (secrets) {
      if (d.wifi?.password !== undefined) net.pass = d.wifi.password;
      if (d.token) net.token = d.token;
      if (d.ha?.token) net.ha_token = d.ha.token;
    }
    return net;
  }

  /**
   * Send provisioning to the deck when it changed since last time (or the deck forgot, e.g. after a reflash).
   * Secrets are only ever sent over USB: the WiFi link is plain TCP on your LAN.
   */
  private async provisionIfNeeded(force = false): Promise<void> {
    const deck = this.deck;
    const d = this.config.device;
    if (!deck || !d) return;
    const secrets = this.link === 'usb';
    const net = this.provisionBlob(secrets);
    const payload = JSON.stringify({ net, ble: d.ble, autodim: d.autodim, gestures: d.gestures });
    const hash = createHash('sha256').update(payload + (secrets ? 'usb' : 'wifi')).digest('hex');
    const stamp = join(dirname(this.file), `.provisioned-${secrets ? 'usb' : 'wifi'}`);
    const known = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
    const forgot = !!d.wifi?.ssid && secrets && deck.net.wifi === 'off';
    if (!force && known === hash && !forgot) return;
    if (Object.keys(net).length) await deck.send(cmd.setNet(net));
    if (d.ble) await deck.send(cmd.setBle(d.ble));
    if (d.autodim) await deck.send(cmd.setAutodim(d.autodim.enabled, d.autodim.min, d.autodim.max, d.autodim.luxLow, d.autodim.luxHigh));
    if (d.gestures) await deck.send(cmd.setGestures(d.gestures.swipe, d.gestures.holdMs ?? 600));
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, hash + '\n', { mode: 0o600 });
    this.log(`provisioned deck over ${this.link}${secrets ? '' : ' (no secrets)'}`);
  }

  private async applySchedule(): Promise<void> {
    if (!this.deck) return;
    const want = scheduledBrightness(this.config.brightnessSchedule, new Date());
    const target = want ?? (this.lastSched !== undefined ? this.config.brightness : undefined);
    if (target === undefined || target === this.lastSched && want !== undefined) return;
    if (want === undefined) this.lastSched = undefined;
    else this.lastSched = want;
    try {
      await this.deck.send(cmd.setBrightness(target));
    } catch (e) {
      this.log(`schedule: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** USB first (always preferred), then WiFi if configured. */
  private async connectLink(): Promise<{ transport: Transport; name: string; path: string; kind: 'usb' | 'wifi' } | null> {
    const candidates = this.opts.port ? [this.opts.port] : await listCandidatePorts();
    const usb = await findDeck(candidates);
    if (usb) return { ...usb, kind: 'usb' };
    const d = this.config.device;
    if (!d?.address || !d.token || Date.now() - this.lastWifiTry < WIFI_RETRY_MS) return null;
    this.lastWifiTry = Date.now();
    try {
      const t = await TcpTransport.connect(d.address, d.token);
      const name = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('SmartDeck (WiFi)'), 1500);
        t.on('line', (l: string) => {
          if (l.startsWith('PONG_DECK:')) { clearTimeout(timer); resolve(l.slice(10).trim()); }
        });
        t.write('PING_DECK\n').catch(() => {});
      });
      this.lastWifiErr = '';
      return { transport: t, name, path: d.address, kind: 'wifi' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== this.lastWifiErr) this.log(`WiFi deck ${d.address}: ${msg}`);
      this.lastWifiErr = msg;
      return null;
    }
  }

  // ---- lifecycle ----
  async run(): Promise<void> {
    this.appWatch.start();
    this.weatherTimer = setInterval(() => void this.pushWeather(), WEATHER_EVERY_MS);
    this.diagTimer = setInterval(() => void this.pushDiag(), DIAG_EVERY_MS);
    this.schedTimer = setInterval(() => void this.applySchedule(), SCHEDULE_EVERY_MS);
    while (!this.stopped) {
      const found = await this.connectLink();
      if (!found) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      this.portPath = found.path;
      this.deviceName = found.name;
      this.link = found.kind;
      this.log(`connected to "${found.name}" over ${found.kind === 'usb' ? 'USB' : 'WiFi'}`);
      const deck = new Deck(found.transport, () => this.config, this.exec, (m) => this.log(m), undefined, (k) => this.sounds.play(k));
      this.deck = deck;
      found.transport.on('error', (e: Error) => this.log(`link error: ${e.message}`));
      const closed = new Promise<void>((r) => deck.once('close', r));
      try {
        await deck.start();
        // Does this deck run the new firmware? Only then is the heartbeat safe (see Deck.startHeartbeat).
        const net = await deck.requestNetStatus();
        if (net) {
          deck.startHeartbeat();
          await this.provisionIfNeeded();
        } else {
          this.log('deck has the stock firmware (no WiFi/BLE module): heartbeat and provisioning skipped');
        }
        await this.pushWeather();
        this.lastSched = undefined;
        await this.applySchedule();
        this.widgets.reset();
        this.widgets.start();
      } catch (e) {
        this.log(`start failed: ${e instanceof Error ? e.message : e}`);
      }
      await closed;
      this.lastWifiTry = 0; // a dropped link (e.g. deck reboot after upload) should reconnect right away
      this.widgets.stop();
      this.deck = undefined;
      this.log('disconnected; reconnecting...');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.widgets.stop();
    this.appWatch.stop();
    if (this.weatherTimer) clearInterval(this.weatherTimer);
    if (this.diagTimer) clearInterval(this.diagTimer);
    if (this.schedTimer) clearInterval(this.schedTimer);
    await this.deck?.close();
  }
}
