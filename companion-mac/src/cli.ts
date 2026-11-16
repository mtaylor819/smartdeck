#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, writeDefaultConfig } from './config.js';
import { Daemon } from './daemon.js';
import { flashArgs, runEsptool, verifyChecksum } from './flash.js';
import { startServer } from './server.js';
import { installService } from './service.js';
import { listCandidatePorts } from './transport.js';

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
      console.log('usage: smartdeck-mac [run|open|init|ports|sync|flash|install-service] [--port /dev/cu.usbmodemXXXX]');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
