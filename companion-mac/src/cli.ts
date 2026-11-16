#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, writeDefaultConfig } from './config.js';
import { Daemon } from './daemon.js';
import { flashArgs, runEsptool, verifyChecksum } from './flash.js';
import { startServer } from './server.js';
import { otaUpdate } from './ota.js';
import { installService } from './service.js';
import { defaultCapture } from './actions.js';
import type { DeckStatus } from './api.js';
import { DeckProbe, formatChecks, probeNet, runDoctor } from './doctor.js';
import { findDeck, listCandidatePorts, TcpTransport } from './transport.js';

const uiBase = () => `http://127.0.0.1:${(() => { try { return loadConfig().ui?.port ?? 7777; } catch { return 7777; } })()}`;

/** Fetch the running daemon's page for its per-process CSRF token (localhost only). */
async function daemonToken(base = uiBase()): Promise<string> {
  let page: string;
  try {
    page = await (await fetch(base + '/')).text();
  } catch {
    throw new Error(`Can't reach the SmartDeck daemon at ${base}. Is \`smartdeck-mac run\` running?`);
  }
  const token = /name="csrf-token" content="([^"]+)"/.exec(page)?.[1];
  if (!token) throw new Error('daemon did not provide a token');
  return token;
}

/** Talk to the already-running daemon's local API. */
async function daemonPost(path: string, body: unknown): Promise<void> {
  const base = uiBase();
  const token = await daemonToken(base);
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SmartDeck-Token': token }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
}

async function daemonStatus(): Promise<DeckStatus> {
  const base = uiBase();
  const token = await daemonToken(base);
  const res = await fetch(base + '/api/status', { headers: { 'X-SmartDeck-Token': token } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DeckStatus;
}

/** Where the repo (firmware/, sounds/) lives relative to this file, if we are running from a checkout. */
function repoRoot(): string | undefined {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return existsSync(join(root, 'firmware')) ? root : undefined;
}

async function probeDeck(): Promise<DeckProbe | null> {
  try {
    const st = await daemonStatus();
    if (st.connected) return { link: st.link ?? 'usb', name: st.deviceName ?? 'Deck', net: st.net && Object.keys(st.net).length ? st.net : null, via: 'daemon' };
    return null; // daemon owns the serial port: a direct probe would fight it
  } catch { /* daemon not running: probe directly */ }
  const found = await findDeck(await listCandidatePorts());
  if (found) {
    const net = await probeNet(found.transport);
    await found.transport.close();
    return { link: 'usb', name: found.name, net, via: 'direct' };
  }
  let cfg;
  try { cfg = loadConfig(); } catch { return null; }
  const d = cfg.device;
  if (d?.address && d.token) {
    try {
      const t = await TcpTransport.connect(d.address, d.token);
      const net = await probeNet(t);
      await t.close();
      return { link: 'wifi', name: 'SmartDeck (WiFi)', net, via: 'direct' };
    } catch { return null; }
  }
  return null;
}

async function main() {
  const [command = 'run', ...rest] = process.argv.slice(2);
  const flag = (n: string) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);

  switch (command) {
    case 'init': {
      const created = writeDefaultConfig();
      console.log(created ? `Wrote ${configPath()}` : `Config already exists: ${configPath()}`);
      return;
    }
    case 'ports':
      for (const p of await listCandidatePorts()) console.log(p);
      return;
    case 'sync': {
      // One-shot upload without the UI: stop the background service first (it owns the serial port).
      const d = new Daemon({ port: flag('--port') });
      void d.run();
      for (let i = 0; i < 20 && !d.status().connected; i++) await new Promise((r) => setTimeout(r, 1000));
      await d.sync();
      await d.stop();
      return;
    }
    case 'run': {
      const daemon = new Daemon({ port: flag('--port') });
      const cfg = loadConfig();
      const ui = await startServer(daemon, { port: cfg.ui?.port ?? 7777 });
      console.log(`SmartDeck UI: ${ui.url}`);
      const quit = async () => {
        await ui.close();
        await daemon.stop();
        process.exit(0);
      };
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
      await daemon.run();
      return;
    }
    case 'flash': {
      // smartdeck-mac flash <firmware.bin> [--port P]   (stop the background service first)
      const bin = rest.find((a) => !a.startsWith('--') && a !== flag('--port'));
      if (!bin) throw new Error('usage: smartdeck-mac flash <merged-firmware.bin> [--port /dev/cu.usbmodemXXXX]');
      const port = flag('--port') ?? (await listCandidatePorts())[0];
      if (!port) throw new Error('No serial port found. Hold BOOT while plugging in the deck, then retry.');
      console.log(`Checksum: ${verifyChecksum(bin)}`);
      await runEsptool(flashArgs(port, bin));
      return;
    }
    case 'doctor': {
      const checks = await runDoctor({
        platform: platform(), nodeVersion: process.version, capture: defaultCapture, configFile: configPath(),
        loadConfig: () => loadConfig(), listPorts: listCandidatePorts, probeDeck, uiPort: Number(new URL(uiBase()).port),
        daemonRunning: async () => { try { await daemonToken(); return true; } catch { return false; } }, repoRoot: repoRoot(),
      });
      console.log(formatChecks(checks));
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
      return;
    }
    case 'status': {
      // smartdeck-mac status [--short]   (used by the menu-bar plugin)
      try {
        const st = await daemonStatus();
        const extra = [st.link === 'wifi' ? 'WiFi' : st.link === 'usb' ? 'USB' : '', st.net?.ble && st.net.ble !== 'off' ? `BT ${st.net.ble}` : ''].filter(Boolean).join(' · ');
        console.log(st.connected ? `${st.deviceName ?? 'Deck'}${extra ? ' · ' + extra : ''} · page ${st.page + 1}` : 'Deck not connected');
        if (!st.connected) process.exitCode = 2;
      } catch (e) {
        console.log('SmartDeck not running');
        process.exitCode = 3;
      }
      return;
    }
    case 'alert': {
      // smartdeck-mac alert red [seconds] [text...]   |   smartdeck-mac alert off
      const [kind, secs, ...text] = rest.filter((a) => a !== '--port');
      if (!kind) throw new Error('usage: smartdeck-mac alert <red|yellow|blue|green|off> [seconds] [text]');
      await daemonPost('/api/alert', { kind, seconds: secs === undefined ? 0 : Number(secs), text: text.join(' ') });
      console.log('alert sent');
      return;
    }
    case 'provision': {
      await daemonPost('/api/provision', {});
      console.log('provisioning sent');
      return;
    }
    case 'ota': {
      // smartdeck-mac ota firmware/dist/parts/smart_deck.ino.bin   (uses device.address + device.token from the config)
      const bin = rest.find((a) => !a.startsWith('--'));
      const d = loadConfig().device;
      if (!bin) throw new Error('usage: smartdeck-mac ota <smart_deck.ino.bin>   (the APP image, not the merged one)');
      if (!d?.address || !d.token) throw new Error('set device.address and device.token in the config first');
      await otaUpdate(d.address, d.token, bin, fetch, (m) => console.log(m));
      return;
    }
    case 'virtual': {
      // Software deck for testing without hardware. Point the Mac app at it with device.address "127.0.0.1" + the same token.
      const { startVirtualDeck } = await import('./virtual/index.js');
      const port = flag('--port'), uiPort = flag('--ui-port');
      const token = flag('--token') ?? 'virtual-deck';
      const d = await startVirtualDeck({
        port: port !== undefined ? Number(port) : 7778, uiPort: uiPort !== undefined ? Number(uiPort) : 7780,
        token, dataDir: flag('--data-dir'), log: (m) => console.log(`[deck] ${m}`),
      });
      console.log(`Virtual deck ready\n  host link : 127.0.0.1:${d.tcpPort}  (token: ${token})\n  screen    : ${d.uiUrl}\n` +
        'To connect the app: set device.address "127.0.0.1" and device.token to the token above (and unplug any real deck).');
      const quit = async () => { await d.close(); process.exit(0); };
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
      await new Promise(() => {});
      return;
    }
    case 'open': {
      const port = loadConfig().ui?.port ?? 7777;
      execFile('open', [`http://127.0.0.1:${port}/`]);
      return;
    }
    case 'install-service': {
      const { plist, commands } = installService(process.execPath, fileURLToPath(import.meta.url));
      console.log(`Wrote ${plist}\nRun (after \`npm run build\`):\n  ${commands.join('\n  ')}`);
      return;
    }
    default:
      console.log('usage: smartdeck-mac [run|open|init|ports|sync|flash|ota|alert|provision|virtual|doctor|status|install-service] [--port /dev/cu.usbmodemXXXX]');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
