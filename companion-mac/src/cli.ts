#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, writeDefaultConfig } from './config.js';
import { Daemon } from './daemon.js';
import { flashArgs, runEsptool, verifyChecksum } from './flash.js';
import { startServer } from './server.js';
import { otaUpdate } from './ota.js';
import { installService } from './service.js';
import { listCandidatePorts } from './transport.js';

/** Talk to the already-running daemon's local API (fetches the page for its per-process CSRF token first). */
async function daemonPost(path: string, body: unknown): Promise<void> {
  const base = `http://127.0.0.1:${loadConfig().ui?.port ?? 7777}`;
  let page: string;
  try {
    page = await (await fetch(base + '/')).text();
  } catch {
    throw new Error(`Can't reach the SmartDeck daemon at ${base}. Is \`smartdeck-mac run\` running?`);
  }
  const token = /name="csrf-token" content="([^"]+)"/.exec(page)?.[1];
  if (!token) throw new Error('daemon did not provide a token');
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SmartDeck-Token': token }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
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
      console.log('usage: smartdeck-mac [run|open|init|ports|sync|flash|ota|alert|provision|install-service] [--port /dev/cu.usbmodemXXXX]');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
