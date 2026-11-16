import { spawn } from 'node:child_process';
import type { SecurityRunner } from './secrets.js';

/** Real process runner for Keychain: stdin carries secrets (never argv); non-zero exit rejects with `.code`. */
export const securityRunner: SecurityRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const e = new Error(`${file} exited with ${code}`) as Error & { code?: number; stderr?: string };
      e.code = code ?? undefined;
      e.stderr = err;
      reject(e);
    });
    child.stdin.on('error', () => { /* process may exit before reading */ });
    child.stdin.end(input ?? '');
  });

/** Read a secret without echoing it: hidden prompt on a TTY, otherwise the whole of stdin (for pipes). */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return resolve(buf); }
        if (c === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
        if (c === '\u007f') buf = buf.slice(0, -1); else buf += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
