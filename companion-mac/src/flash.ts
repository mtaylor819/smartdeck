import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** esptool arguments to write a merged firmware image (bootloader+partitions+app) at 0x0. */
export function flashArgs(port: string, binPath: string): string[] {
  if (!/^\/dev\/(cu|tty)\.[A-Za-z0-9._-]+$|^\/dev\/tty(ACM|USB)\d+$/.test(port)) throw new Error(`Suspicious serial port path: ${port}`);
  return ['--chip', 'esp32s3', '--port', port, '--baud', '460800', 'write_flash', '-z', '--flash_mode', 'dio', '--flash_freq', '80m', '--flash_size', 'detect', '0x0', binPath];
}

/** If a `.sha256` file sits next to the image, make sure it matches before flashing. */
export function verifyChecksum(binPath: string): 'ok' | 'none' {
  const sumFile = binPath + '.sha256';
  if (!existsSync(sumFile)) return 'none';
  const want = readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  const got = createHash('sha256').update(readFileSync(binPath)).digest('hex');
  if (want !== got) throw new Error(`Checksum mismatch for ${binPath} (expected ${want}, got ${got})`);
  return 'ok';
}

export function runEsptool(args: string[]): Promise<void> {
  const tryRun = (exe: string) =>
    new Promise<void>((resolve, reject) => {
      const c = spawn(exe, args, { stdio: 'inherit' });
      c.on('error', reject);
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${exe} exited with ${code}`))));
    });
  // esptool v5 installs `esptool`; v4 installs `esptool.py`.
  return tryRun('esptool').catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
    return tryRun('esptool.py').catch((e2: NodeJS.ErrnoException) => {
      if (e2.code === 'ENOENT') throw new Error('esptool not found. Install it with: pip3 install esptool');
      throw e2;
    });
  });
}
