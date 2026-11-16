import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { clientProof, deckProof, newNonce, ctEqualHex } from '../src/linkauth.js';
import type { Transport } from '../src/transport.js';

/** In-memory stand-in for the serial port. `onWrite` plays the role of firmware. */
export class FakeTransport extends EventEmitter implements Transport {
  written: Array<string | Buffer> = [];
  constructor(public onWrite?: (data: string | Buffer, self: FakeTransport) => void) {
    super();
  }
  async write(data: string | Buffer): Promise<void> {
    this.written.push(data);
    // reply asynchronously like a real device
    setImmediate(() => this.onWrite?.(data, this));
  }
  async close(): Promise<void> {
    this.emit('close');
  }
  /** Simulate the deck sending a line. */
  deck(line: string) {
    this.emit('line', line);
  }
  lines(): string[] {
    return this.written.filter((w): w is string => typeof w === 'string').map((s) => s.trim());
  }
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Client side of the v4 handshake on a raw socket: waits for CHALLENGE, answers, verifies AUTH_OK:<deck proof>. `pipelined` is sent right behind AUTH. */
export function handshake(sock: Socket, token: string, pipelined = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let nonce: string | undefined;
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) return;
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        const c = /^CHALLENGE:([0-9a-f]{32})$/.exec(line);
        if (c && !nonce) { nonce = c[1]; sock.write(`AUTH:${clientProof(token, nonce)}\n${pipelined}`); continue; }
        if (nonce && line.startsWith('AUTH_OK:')) {
          sock.off('data', onData);
          return ctEqualHex(line.slice(8), deckProof(token, nonce)) ? resolve() : reject(new Error('deck proof mismatch'));
        }
        if (line === 'AUTH_FAIL') { sock.off('data', onData); return reject(new Error('AUTH_FAIL')); }
      }
    };
    sock.on('data', onData);
  });
}

/** Server side of the v4 handshake for fake decks in tests. Calls onAuthed(sock, rest) once the client proved the token. */
export function serveHandshake(sock: Socket, token: string, onAuthed: (rest: string) => void, onFail: () => void = () => sock.end('AUTH_FAIL\n')): (chunk: string) => boolean {
  const nonce = newNonce();
  sock.write(`CHALLENGE:${nonce}\n`);
  let buf = '';
  let done = false;
  /** feed raw data while unauthenticated; returns true while the handshake is still in progress */
  return (chunk: string) => {
    if (done) return false;
    buf += chunk;
    const i = buf.indexOf('\n');
    if (i < 0) return true;
    const line = buf.slice(0, i).trim();
    const rest = buf.slice(i + 1);
    done = true;
    if (line.startsWith('AUTH:') && ctEqualHex(line.slice(5), clientProof(token, nonce))) {
      sock.write(`AUTH_OK:${deckProof(token, nonce)}\n`);
      onAuthed(rest);
    } else onFail();
    return false;
  };
}
