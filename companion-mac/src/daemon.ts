import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ActionExecutor, Action, defaultCapture, Capture, Runner } from './actions.js';
import { AppWatcher } from './appwatch.js';
import type { DaemonApi, DeckStatus } from './api.js';
import { Config, configPath, loadConfig, validate, writeDefaultConfig } from './config.js';
import { Deck, UploadFile } from './deck.js';
import { cmd } from './protocol.js';
import { findDeck, listCandidatePorts, SerialTransport } from './transport.js';
import { defaultCpuTimes, WidgetManager } from './widgets.js';
import { weatherLine } from './weather.js';

const WEATHER_EVERY_MS = 15 * 60_000;

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

  // ---- lifecycle ----
  async run(): Promise<void> {
    this.appWatch.start();
    this.weatherTimer = setInterval(() => void this.pushWeather(), WEATHER_EVERY_MS);
    while (!this.stopped) {
      const candidates = this.opts.port ? [this.opts.port] : await listCandidatePorts();
      const found = await findDeck(candidates);
      if (!found) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      this.portPath = found.path;
      this.deviceName = found.name;
      this.log(`connected to "${found.name}"`);
      const deck = new Deck(found.transport as SerialTransport, () => this.config, this.exec, (m) => this.log(m));
      this.deck = deck;
      found.transport.on('error', (e: Error) => this.log(`serial error: ${e.message}`));
      const closed = new Promise<void>((r) => deck.once('close', r));
      try {
        await deck.start();
        await this.pushWeather();
        this.widgets.reset();
        this.widgets.start();
      } catch (e) {
        this.log(`start failed: ${e instanceof Error ? e.message : e}`);
      }
      await closed;
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
    await this.deck?.close();
  }
}
