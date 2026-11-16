// WiFi TCP host link (PROTOCOL.md): first line AUTH:<token>, then the normal line protocol both ways.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, Server, Socket } from 'node:net';
import type { DeckEmulator } from './emulator.js';

export interface TcpLinkOptions {
  port: number;
  host?: string;
  /** Failed AUTHs before lockout, and lockout length. */
  maxFails?: number;
  lockoutMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export interface TcpLink {
  port: number;
  close(): Promise<void>;
  hasClient(): boolean;
}

const AUTH_WINDOW_MS = 5000;
const MAX_PRE_AUTH_BYTES = 512;

/** Constant-time compare that doesn't leak the token length (hash both sides first). */
export function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function startTcpLink(deck: DeckEmulator, opts: TcpLinkOptions): Promise<TcpLink> {
  const now = opts.now ?? Date.now;
  const maxFails = opts.maxFails ?? 5;
  const lockoutMs = opts.lockoutMs ?? 30_000;
  const log = opts.log ?? (() => {});
  let client: Socket | null = null;
  let fails = 0;
  let lockedUntil = 0;
  const sockets = new Set<Socket>();

  deck.setClientCounter(() => (client ? 1 : 0));
  deck.on('out', (data: string) => {
    if (client && !client.destroyed) client.write(data);
  });
  // The deck "reboots": every link drops until it is back up.
  deck.on('reboot', () => {
    for (const s of sockets) s.destroy();
    client = null;
  });

  const server: Server = createServer((sock) => {
    if (deck.state.rebooting) { sock.destroy(); return; }
    sockets.add(sock);
    sock.on('close', () => { sockets.delete(sock); if (client === sock) { client = null; deck.emit('change'); } });
    sock.on('error', () => sock.destroy());
    let pre = Buffer.alloc(0);
    let authed = false;
    const timer = setTimeout(() => { if (!authed) sock.destroy(); }, AUTH_WINDOW_MS);
    timer.unref?.();

    sock.on('data', (chunk: Buffer) => {
      if (authed) {
        if (client === sock) deck.feed(chunk);
        return;
      }
      pre = Buffer.concat([pre, chunk]);
      const nl = pre.indexOf(10);
      if (nl < 0) { if (pre.length > MAX_PRE_AUTH_BYTES) sock.destroy(); return; }
      const line = pre.subarray(0, nl).toString('utf8').trim();
      const rest = pre.subarray(nl + 1);
      clearTimeout(timer);

      const t = now();
      const expected = deck.currentToken();
      const given = line.startsWith('AUTH:') ? line.slice(5) : null;
      if (t < lockedUntil) { sock.end('AUTH_FAIL\r\n'); return; }
      if (given === null || !expected || !tokenEquals(given, expected)) {
        if (++fails >= maxFails) { lockedUntil = t + lockoutMs; fails = 0; log('host link locked out after repeated AUTH failures'); }
        sock.end('AUTH_FAIL\r\n');
        return;
      }
      fails = 0;
      authed = true;
      if (client && client !== sock) client.destroy(); // a new authenticated client replaces the old one
      client = sock;
      sock.write('AUTH_OK\r\n');
      log('host linked over TCP');
      deck.emit('change');
      if (rest.length) deck.feed(rest);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : opts.port,
        hasClient: () => client !== null,
        close: () => new Promise<void>((res) => {
          for (const s of sockets) s.destroy();
          server.close(() => res());
        }),
      });
    });
  });
}
