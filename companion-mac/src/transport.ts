import { EventEmitter } from 'node:events';
import net from 'node:net';
import { clientProof, ctEqualHex, deckProof, NONCE_RE } from './linkauth.js';
import { SerialPort, ReadlineParser } from 'serialport';

/** What the deck controller needs from a connection. Real = serial; tests use a fake. */
export interface Transport extends EventEmitter {
  /** emits: 'line' (string), 'close' */
  write(data: string | Buffer): Promise<void>;
  close(): Promise<void>;
}

export class SerialTransport extends EventEmitter implements Transport {
  private constructor(private port: SerialPort) {
    super();
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line: string) => this.emit('line', line.replace(/\r$/, '')));
    port.on('close', () => this.emit('close'));
    port.on('error', (e) => { if (this.listenerCount('error')) this.emit('error', e); }); // an early error must not crash the process
  }

  static open(path: string): Promise<SerialTransport> {
    return new Promise((resolve, reject) => {
      // hupcl:false + dtr/rts low: avoid the DTR/RTS toggle that resets many ESP32 boards on open.
      const port = new SerialPort(
        { path, baudRate: 115200, autoOpen: false, hupcl: false, rtscts: false },
        undefined,
      );
      port.open((err) => {
        if (err) return reject(err);
        port.set({ dtr: false, rts: false }, () => resolve(new SerialTransport(port)));
      });
    });
  }

  write(data: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) =>
      this.port.write(data, (err) => (err ? reject(err) : this.port.drain((e) => (e ? reject(e) : resolve())))),
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.port.isOpen ? this.port.close(() => resolve()) : resolve()));
  }
}

/** Serial ports that look like an ESP32 on macOS (and Linux, for development). */
export async function listCandidatePorts(): Promise<string[]> {
  const ports = await SerialPort.list();
  const looksLikeEsp = (p: (typeof ports)[number]) =>
    /cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)|ttyACM|ttyUSB/.test(p.path) ||
    ['303a', '10c4', '1a86', '0403'].includes((p.vendorId ?? '').toLowerCase());
  // On macOS prefer /dev/cu.* (call-out) over /dev/tty.* (waits for carrier detect).
  return ports.filter(looksLikeEsp).map((p) => p.path).filter((p) => !p.includes('/tty.'));
}

/** Open each candidate, send PING_DECK, and return the first one that answers PONG_DECK. */
export async function findDeck(
  candidates: string[],
  timeoutMs = 1500,
): Promise<{ transport: SerialTransport; name: string; path: string } | null> {
  for (const path of candidates) {
    let t: SerialTransport | undefined;
    try {
      t = await SerialTransport.open(path);
      const name = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        t!.on('line', (line: string) => {
          if (line.startsWith('PONG_DECK:')) {
            clearTimeout(timer);
            resolve(line.slice('PONG_DECK:'.length).trim());
          }
        });
        t!.write('PING_DECK\n').catch(() => resolve(null));
      });
      if (name !== null) {
        t.removeAllListeners('line');
        return { transport: t, name, path };
      }
      await t.close();
    } catch {
      await t?.close();
    }
  }
  return null;
}

/** Line-based TCP link to a deck over WiFi (or to the virtual deck). Mutual HMAC challenge-response; the token is never sent. */
export class TcpTransport extends EventEmitter implements Transport {
  private buf = '';
  private constructor(private sock: net.Socket) {
    super();
    sock.setNoDelay(true);
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      this.buf += chunk;
      if (this.buf.length > 64 * 1024) { this.sock.destroy(new Error('line too long')); return; }
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        this.emit('line', line);
      }
    });
    sock.on('close', () => this.emit('close'));
    sock.on('error', (e) => { if (this.listenerCount('error')) this.emit('error', e); });
  }

  /**
   * Connect and authenticate (deck sends CHALLENGE:<nonce>; we answer AUTH:<hmac>; the deck must answer AUTH_OK:<hmac> which we verify).
   * Rejects on timeout, refusal, AUTH_FAIL, a malformed challenge, or a deck that cannot prove it knows the token.
   */
  static connect(address: string, token: string, timeoutMs = 4000): Promise<TcpTransport> {
    const m = /^(.+?)(?::(\d{1,5}))?$/.exec(address);
    if (!m) return Promise.reject(new Error(`bad address: ${address}`));
    const host = m[1];
    const port = m[2] ? Number(m[2]) : 7778;
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      const fail = (e: Error) => { clearTimeout(timer); sock.destroy(); reject(e); };
      const timer = setTimeout(() => fail(new Error(`timeout connecting to ${host}:${port}`)), timeoutMs);
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.setEncoding('utf8');
        let acc = '';
        let nonce: string | undefined;
        const onData = (chunk: string) => {
          acc += chunk;
          if (acc.length > 4096) return fail(new Error('handshake too long'));
          for (;;) {
            const nl = acc.indexOf('\n');
            if (nl < 0) return;
            const line = acc.slice(0, nl).replace(/\r$/, '').trim();
            acc = acc.slice(nl + 1);
            if (!nonce) {
              if (line === 'AUTH_FAIL') return fail(new Error('deck rejected the token'));
              const c = /^CHALLENGE:(.+)$/.exec(line);
              if (!c || !NONCE_RE.test(c[1])) return fail(new Error(`unexpected reply from deck: ${line.slice(0, 40)}`));
              nonce = c[1];
              sock.write(`AUTH:${clientProof(token, nonce)}\n`);
              continue;
            }
            if (line === 'AUTH_FAIL') return fail(new Error('deck rejected the token'));
            const ok = /^AUTH_OK:([0-9a-f]{64})$/.exec(line);
            if (!ok) return fail(new Error(`unexpected reply from deck: ${line.slice(0, 40)}`));
            // the deck must prove it knows the token too: otherwise it is an impostor
            if (!ctEqualHex(ok[1], deckProof(token, nonce))) return fail(new Error('the device at that address could not prove it knows the token (impostor?)'));
            clearTimeout(timer);
            sock.off('data', onData);
            sock.off('error', fail);
            const t = new TcpTransport(sock);
            // anything after AUTH_OK in the same chunk belongs to the stream
            if (acc) { const rest = acc; setImmediate(() => sock.emit('data', rest)); }
            return resolve(t);
          }
        };
        sock.on('data', onData);
      });
    });
  }

  write(data: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) => this.sock.write(data, (err) => (err ? reject(err) : resolve())));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.sock.destroyed) return resolve();
      this.sock.once('close', () => resolve());
      this.sock.end();
      setTimeout(() => this.sock.destroy(), 500).unref();
    });
  }
}
