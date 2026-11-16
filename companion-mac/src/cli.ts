#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ActionExecutor } from './actions.js';
import { configPath, loadConfig, writeDefaultConfig } from './config.js';
import { Deck, UploadFile } from './deck.js';
import { findDeck, listCandidatePorts } from './transport.js';

const log = (m: string) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(explicitPort?: string) {
  const candidates = explicitPort ? [explicitPort] : await listCandidatePorts();
  return findDeck(candidates);
}

function loadIcons(dir: string): UploadFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.jpe?g$/i.test(f))
    .map((name) => ({ name, data: readFileSync(join(dir, name)) }));
}

async function main() {
  const [command = 'run', ...rest] = process.argv.slice(2);
  const portFlag = rest.indexOf('--port');
  const port = portFlag >= 0 ? rest[portFlag + 1] : undefined;

  switch (command) {
    case 'init': {
      const created = writeDefaultConfig();
      console.log(created ? `Wrote ${configPath()}` : `Config already exists: ${configPath()}`);
      return;
    }
    case 'ports': {
      for (const p of await listCandidatePorts()) console.log(p);
      return;
    }
    case 'sync': {
      // Upload the config (and ./icons/*.jpg next to it) to the deck. The deck reboots.
      const config = loadConfig();
      const found = await connect(port);
      if (!found) throw new Error('No SmartDeck found. Is it plugged in? Try `ports` or --port.');
      const deck = new Deck(found.transport, config, new ActionExecutor(undefined, log), log);
      log(`Connected to "${found.name}", uploading...`);
      await deck.uploadConfig(loadIcons(join(configPath(), '..', 'icons')));
      log('Upload complete; the deck is rebooting.');
      await deck.close();
      return;
    }
    case 'run': {
      writeDefaultConfig();
      const config = loadConfig();
      const exec = new ActionExecutor(undefined, log);
      for (;;) {
        const found = await connect(port);
        if (!found) {
          await sleep(2000);
          continue;
        }
        log(`Connected to "${found.name}"`);
        const deck = new Deck(found.transport, config, exec, log);
        const closed = new Promise<void>((r) => deck.once('close', r));
        found.transport.on('error', (e: Error) => log(`serial error: ${e.message}`));
        await deck.start();
        await closed;
        log('Disconnected; reconnecting...');
      }
    }
    default:
      console.log('usage: smartdeck-mac [run|init|ports|sync] [--port /dev/cu.usbmodemXXXX]');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
