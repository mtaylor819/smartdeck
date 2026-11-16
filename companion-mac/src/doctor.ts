import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Capture } from './actions.js';
import type { Config } from './config.js';
import { cmd, NetStatus, parseLine } from './protocol.js';
import type { Transport } from './transport.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface Check { name: string; status: CheckStatus; detail: string; fix?: string }

export interface DeckProbe {
  link: 'usb' | 'wifi';
  name: string;
  net: NetStatus | null; // null = stock firmware (no NET_STATUS reply)
  via: 'daemon' | 'direct';
}

export interface DoctorDeps {
  platform: string;
  nodeVersion: string; // e.g. "v24.1.0"
  capture: Capture;
  configFile: string;
  loadConfig: () => Config; // throws on invalid
  listPorts: () => Promise<string[]>;
  /** Find the deck (running daemon first, else direct USB/WiFi). null = no deck reachable. */
  probeDeck: () => Promise<DeckProbe | null>;
  uiPort: number;
  /** True if something other than/including our daemon answers on the UI port. */
  daemonRunning: () => Promise<boolean>;
  repoRoot?: string; // to find firmware/dist and sounds/
  exists?: (p: string) => boolean;
  mode?: (p: string) => number | undefined;
}

const SECRET_KEYS: string[][] = [
  ['integrations', 'homeassistant', 'token'], ['device', 'wifi', 'password'], ['device', 'token'], ['device', 'ha', 'token'],
];
const get = (o: any, path: string[]) => path.reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);

/** Probe a connected transport for NET_STATUS (old firmware never answers). */
export function probeNet(t: Transport, timeoutMs = 1500): Promise<NetStatus | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { t.off('line', onLine); resolve(null); }, timeoutMs);
    const onLine = (line: string) => {
      const ev = parseLine(line);
      if (ev.type !== 'netStatus') return;
      clearTimeout(timer);
      t.off('line', onLine);
      resolve(ev.status);
    };
    t.on('line', onLine);
    t.write(cmd.getNet() + '\n').catch(() => { clearTimeout(timer); t.off('line', onLine); resolve(null); });
  });
}

export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string, fix?: string) => out.push({ name, status, detail, fix });
  const exists = d.exists ?? existsSync;
  const isMac = d.platform === 'darwin';

  // --- runtime ---
  const major = Number(/^v?(\d+)/.exec(d.nodeVersion)?.[1]);
  if (major >= 20) add('Node.js', 'ok', d.nodeVersion);
  else add('Node.js', 'fail', `${d.nodeVersion} is too old`, 'Install Node 20 or newer: brew install node');
  if (!isMac) add('Platform', 'warn', `${d.platform}: macOS-only checks (Accessibility, afplay, Shortcuts) are skipped`);

  // --- config ---
  let cfg: Config | undefined;
  try {
    cfg = d.loadConfig();
    add('Config', 'ok', `${d.configFile} (${cfg.pages.length} page(s), ${cfg.grid.cols}x${cfg.grid.rows})`);
  } catch (e) {
    add('Config', 'fail', e instanceof Error ? e.message : String(e), `Fix ${d.configFile}, or delete it to regenerate the defaults (run: smartdeck-mac init)`);
  }
  if (cfg) {
    const mode = (d.mode ?? ((p) => { try { return statSync(p).mode & 0o777; } catch { return undefined; } }))(d.configFile);
    if (mode !== undefined && mode & 0o077) add('Config permissions', 'warn', `mode ${mode.toString(8)}: other users can read it`, `chmod 600 "${d.configFile}"`);
    const plain = SECRET_KEYS.filter((k) => { const v = get(cfg, k); return typeof v === 'string' && v && !v.startsWith('keychain:') && v !== '***'; });
    if (plain.length) add('Secrets', 'warn', `${plain.length} secret(s) stored in plain text in the config`, 'Move them to the macOS Keychain: smartdeck-mac keychain migrate');
    else add('Secrets', 'ok', 'no plain-text secrets in the config');
  }

  // --- macOS integration ---
  if (isMac) {
    try {
      await d.capture('osascript', ['-e', 'tell application "System Events" to keystroke ""']);
      add('Accessibility permission', 'ok', 'hotkeys, typing and media keys are allowed');
    } catch {
      add('Accessibility permission', 'fail', 'macOS is blocking synthetic key presses',
        'System Settings > Privacy & Security > Accessibility: enable your terminal (or the SmartDeck app), then retry');
    }
    for (const [tool, why] of [['afplay', 'button sounds'], ['shortcuts', 'Shortcuts.app actions'], ['osascript', 'hotkeys/AppleScript']] as const) {
      try { await d.capture('/usr/bin/env', ['which', tool]); add(`Tool: ${tool}`, 'ok', why); }
      catch { add(`Tool: ${tool}`, tool === 'osascript' ? 'fail' : 'warn', `not found (${why})`); }
    }
  }
  try { await d.capture('/usr/bin/env', ['which', 'esptool']); add('Tool: esptool', 'ok', 'USB firmware flashing available'); }
  catch {
    try { await d.capture('/usr/bin/env', ['which', 'esptool.py']); add('Tool: esptool', 'ok', 'USB firmware flashing available'); }
    catch { add('Tool: esptool', 'info', 'not installed (only needed to flash firmware over USB)', 'pip3 install esptool'); }
  }

  // --- deck ---
  const ports = await d.listPorts().catch(() => [] as string[]);
  add('Serial ports', ports.length ? 'ok' : 'info', ports.length ? ports.join(', ') : 'no ESP32-looking ports (fine if you use WiFi or the virtual deck)',
    ports.length ? undefined : 'Plug the deck in with a DATA cable (some USB-C cables are charge-only)');
  const running = await d.daemonRunning().catch(() => false);
  add('SmartDeck service', running ? 'ok' : 'info', running ? `running on port ${d.uiPort}` : `not running (port ${d.uiPort} free)`, running ? undefined : 'Start it with: npm start');

  const probe = await d.probeDeck().catch(() => null);
  if (!probe) {
    const wifi = cfg?.device?.address ? ` Tried WiFi address ${cfg.device.address} too.` : '';
    add('Deck connection', 'fail', `no deck reachable.${wifi}`, 'Check the cable/power, the port list above, and device.address/device.token in Settings');
  } else {
    add('Deck connection', 'ok', `"${probe.name}" over ${probe.link === 'usb' ? 'USB' : 'WiFi'} (${probe.via === 'daemon' ? 'via the running service' : 'direct probe'})`);
    if (!probe.net) {
      add('Firmware', 'warn', 'stock firmware: no WiFi/Bluetooth/alerts/gestures/live widgets', 'Flash firmware/dist/smartdeck-jc8048w550-merged.bin: smartdeck-mac flash ../firmware/dist/smartdeck-jc8048w550-merged.bin');
    } else {
      const n = probe.net;
      add('Firmware', 'ok', `${n.fw ?? 'unknown version'}; capabilities: ${(n.caps ?? []).join(', ') || 'none reported'}`);
      if (cfg?.device?.wifi?.ssid) {
        if (n.wifi === 'connected') add('Deck WiFi', 'ok', `${n.ssid ?? cfg.device.wifi.ssid} ${n.ip ?? ''} (${n.rssi ?? '?'} dBm)`);
        else add('Deck WiFi', 'warn', `deck reports "${n.wifi ?? 'unknown'}"`, 'Re-send settings over USB: Settings > Push to deck. Check the SSID/password and that the network is 2.4 GHz');
      }
      if (cfg?.device?.ble?.enabled) {
        if (n.ble && n.ble !== 'off') add('Deck Bluetooth', 'ok', `${n.ble}${n.ble_peer ? ' with ' + n.ble_peer : ''}`);
        else add('Deck Bluetooth', 'warn', 'enabled in config but the deck reports it is off', 'Push settings to the deck over USB');
      }
    }
  }

  // --- artifacts ---
  if (d.repoRoot) {
    const dist = join(d.repoRoot, 'firmware', 'dist');
    for (const f of ['smartdeck-jc8048w550-merged.bin', 'smartdeck-jc8048w550-app.bin']) {
      const bin = join(dist, f);
      if (!exists(bin)) { add(`Firmware file ${f}`, 'info', 'not found'); continue; }
      const sum = bin + '.sha256';
      if (!exists(sum)) { add(`Firmware file ${f}`, 'warn', 'no .sha256 next to it'); continue; }
      const want = readFileSync(sum, 'utf8').trim().split(/\s+/)[0].toLowerCase();
      const got = createHash('sha256').update(readFileSync(bin)).digest('hex');
      add(`Firmware file ${f}`, want === got ? 'ok' : 'fail', want === got ? 'checksum matches' : 'CHECKSUM MISMATCH: do not flash this file', want === got ? undefined : 'git checkout -- firmware/dist');
    }
  }
  return out;
}

export function formatChecks(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  const lines = checks.map((c) => `${icon[c.status]} ${c.name}: ${c.detail}${c.fix ? `\n    -> ${c.fix}` : ''}`);
  const f = checks.filter((c) => c.status === 'fail').length, w = checks.filter((c) => c.status === 'warn').length;
  lines.push('', f ? `${f} problem(s) to fix${w ? `, ${w} warning(s)` : ''}.` : w ? `No blocking problems, ${w} warning(s).` : 'All good.');
  return lines.join('\n');
}
