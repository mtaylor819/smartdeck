import { EventEmitter } from 'node:events';
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
    port.on('error', (e) => this.emit('error', e));
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
): Promise<{ transport: SerialTransport; name: string } | null> {
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
        return { transport: t, name };
      }
      await t.close();
    } catch {
      await t?.close();
    }
  }
  return null;
}
