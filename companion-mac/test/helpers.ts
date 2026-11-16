import { EventEmitter } from 'node:events';
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
