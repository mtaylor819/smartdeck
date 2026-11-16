import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeckEmulator, EmulatorOptions, VirtualDeckState } from './emulator.js';
import { startTcpLink } from './tcp.js';
import { startVirtualUi } from './ui.js';

export { DeckEmulator } from './emulator.js';
export type { VirtualDeckState, EmulatorOptions } from './emulator.js';

export interface VirtualDeckOptions {
  /** TCP host-link port (default 7778; 0 = pick a free one). */
  port?: number;
  /** Browser UI port (default 7780; 0 = pick a free one). */
  uiPort?: number;
  token: string;
  /** "SD card" directory: esp_config.json, icons, prefs.json. Default: a fresh temp dir. */
  dataDir?: string;
  name?: string;
  log?: (m: string) => void;
  /** Test hooks, passed to the emulator. */
  emulator?: Partial<EmulatorOptions>;
}

export interface RunningVirtualDeck {
  tcpPort: number;
  uiUrl: string;
  /** CSRF token the UI page was served with (tests need it for POSTs). */
  uiToken: string;
  close(): Promise<void>;
  state: VirtualDeckState;
  /** The emulator itself: UI-side hooks (touch, swipe, knob, ackAlert...) for tests and scripts. */
  deck: DeckEmulator;
}

export async function startVirtualDeck(opts: VirtualDeckOptions): Promise<RunningVirtualDeck> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'smartdeck-virtual-'));
  const deck = new DeckEmulator({ name: opts.name, dataDir, token: opts.token, log: opts.log, ...opts.emulator });
  const tcp = await startTcpLink(deck, { port: opts.port ?? 7778, log: opts.log });
  let ui;
  try {
    ui = await startVirtualUi(deck, dataDir, { port: opts.uiPort ?? 7780 });
  } catch (e) {
    await tcp.close();
    throw e;
  }
  const timer = setInterval(() => deck.tick(), 250);
  timer.unref?.();
  return {
    tcpPort: tcp.port, uiUrl: ui.url, uiToken: ui.token, state: deck.state, deck,
    close: async () => { clearInterval(timer); await ui.close(); await tcp.close(); },
  };
}
