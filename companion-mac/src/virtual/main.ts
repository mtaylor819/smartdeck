#!/usr/bin/env node
// Run: npx tsx src/virtual/main.ts [--port 7778] [--ui-port 7780] [--token virtual-deck] [--data-dir DIR] [--name "Smart Deck"]
import { startVirtualDeck } from './index.js';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const port = flag('--port'), uiPort = flag('--ui-port');

const token = flag('--token') ?? 'virtual-deck';
const d = await startVirtualDeck({
  port: port !== undefined ? Number(port) : 7778,
  uiPort: uiPort !== undefined ? Number(uiPort) : 7780,
  token, dataDir: flag('--data-dir'), name: flag('--name'),
  log: (m) => console.log(`[deck] ${m}`),
});
console.log(`Virtual deck ready
  host link : tcp://127.0.0.1:${d.tcpPort}   (token: ${token}; challenge-response, the token is never sent)
  screen    : ${d.uiUrl}`);
const quit = async () => { await d.close(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
