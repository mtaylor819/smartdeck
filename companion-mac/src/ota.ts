import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** ESP32 images start with 0xE9 and the ESP32-S3 chip id lives in the extended header. Reject obvious mistakes. */
export function checkAppImage(buf: Buffer, name = 'image'): void {
  if (buf.length < 64 * 1024) throw new Error(`${name} is too small to be a firmware image`);
  if (buf[0] !== 0xe9) throw new Error(`${name} is not an ESP32 app image (bad magic byte)`);
  if (buf.length > 3 * 1024 * 1024) throw new Error(`${name} is larger than the 3 MB app slot`);
  // merged images start with the bootloader at 0x0 and also begin with 0xE9, but contain the partition table at 0x8000
  if (buf.length > 0x8000 + 2 && buf[0x8000] === 0xaa && buf[0x8001] === 0x50)
    throw new Error(`${name} looks like a MERGED image; OTA needs the app image (smart_deck.ino.bin, firmware/dist/parts/)`);
}

/** Upload an app image to the deck's OTA endpoint (http://<address>:7779/update). */
export async function otaUpdate(
  address: string,
  token: string,
  binPath: string,
  fetchImpl: typeof fetch = fetch,
  log: (m: string) => void = () => {},
): Promise<void> {
  const data = readFileSync(binPath);
  checkAppImage(data, basename(binPath));
  const host = address.replace(/:\d+$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Error(`bad address: ${address}`);
  const sha = createHash('sha256').update(data).digest('hex').slice(0, 12);
  log(`uploading ${basename(binPath)} (${data.length} bytes, sha256 ${sha}…) to ${host}:7779`);
  const res = await fetchImpl(`http://${host}:7779/update`, {
    method: 'POST',
    headers: { 'X-SmartDeck-Token': token, 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) },
    body: data,
  });
  const text = (await res.text()).trim().slice(0, 200);
  if (res.status === 401) throw new Error('deck rejected the token');
  if (!res.ok) throw new Error(`OTA failed: HTTP ${res.status} ${text}`);
  log(`deck says: ${text || 'OK'} (it will reboot)`);
}
