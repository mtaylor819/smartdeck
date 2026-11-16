import type { Config } from './config.js';

/** Config paths that hold secrets. Same set as SECRET_PATHS in src/server.ts. */
export const SECRET_PATHS: string[][] = [
  ['integrations', 'homeassistant', 'token'],
  ['device', 'wifi', 'password'],
  ['device', 'token'],
  ['device', 'ha', 'token'],
];

/** Stable Keychain account names used when migrating each path. */
const DERIVED_NAMES: Record<string, string> = {
  'integrations.homeassistant.token': 'ha-token',
  'device.wifi.password': 'wifi-password',
  'device.token': 'device-token',
  'device.ha.token': 'device-ha-token',
};

export const SERVICE = 'smartdeck-mac';
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REF_RE = /^keychain:([A-Za-z0-9._-]{1,64})$/;

/** True for "keychain:<name>" with a valid name. */
export function isKeychainRef(v: unknown): v is string {
  return typeof v === 'string' && REF_RE.test(v);
}

export function refName(ref: string): string {
  const m = REF_RE.exec(ref);
  if (!m) throw new Error(`not a keychain reference: ${ref}`);
  return m[1];
}

/** Runs a process; resolves with stdout, rejects on non-zero exit (error may carry `.code`). `input` goes to stdin. */
export type SecurityRunner = (file: string, args: string[], input?: string) => Promise<string>;

const notFound = (e: unknown): boolean => {
  const err = e as { code?: unknown; message?: string; stderr?: string };
  return err?.code === 44 || /could not be found|SecKeychainSearchCopyNext/i.test(`${err?.message ?? ''} ${err?.stderr ?? ''}`);
};

/**
 * macOS Keychain access via the `security` tool (service "smartdeck-mac").
 * Secret values never appear in argv: writes go through `security -i` on stdin, hex-encoded (-X) so no quoting of
 * the value is needed at all; reads use `find-generic-password -w` (the secret comes back on stdout).
 */
export class Keychain {
  constructor(private run: SecurityRunner) {}

  private check(name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`invalid keychain name: ${name}`);
  }

  async get(name: string): Promise<string | undefined> {
    this.check(name);
    try {
      const out = await this.run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      return out.replace(/\r?\n$/, '');
    } catch (e) {
      if (notFound(e)) return undefined;
      throw new Error(`keychain read failed for "${name}"`);
    }
  }

  async set(name: string, value: string): Promise<void> {
    this.check(name);
    if (value === '') throw new Error('refusing to store an empty secret');
    if (/[\r\n\0]/.test(value)) throw new Error('secret must not contain newlines or NUL characters');
    const hex = Buffer.from(value, 'utf8').toString('hex');
    // -U updates an existing item; -X takes the password as hex. Command goes via stdin (interactive mode).
    const cmd = `add-generic-password -U -s ${SERVICE} -a ${name} -X ${hex}\n`;
    try {
      await this.run('security', ['-i'], cmd);
    } catch {
      throw new Error(`keychain write failed for "${name}"`);
    }
  }

  async remove(name: string): Promise<void> {
    this.check(name);
    try {
      await this.run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
    } catch (e) {
      if (notFound(e)) return;
      throw new Error(`keychain delete failed for "${name}"`);
    }
  }
}

function slot(root: any, path: string[]): { parent: any; key: string } | null {
  let cur = root;
  for (const k of path.slice(0, -1)) {
    cur = cur?.[k];
    if (cur === null || typeof cur !== 'object') return null;
  }
  return { parent: cur, key: path[path.length - 1] };
}

const copy = (cfg: Config): Config => JSON.parse(JSON.stringify(cfg)) as Config;

/** Deep copy of cfg with every `keychain:<name>` secret replaced by its value. Missing item => Error naming the ref. */
export async function resolveConfigSecrets(cfg: Config, kc: Keychain): Promise<Config> {
  const out = copy(cfg);
  for (const p of SECRET_PATHS) {
    const t = slot(out, p);
    const v = t?.parent[t.key];
    if (!t || !isKeychainRef(v)) continue;
    const secret = await kc.get(refName(v));
    if (secret === undefined) throw new Error(`Keychain item not found for ${v} (config ${p.join('.')})`);
    t.parent[t.key] = secret;
  }
  return out;
}

/** Move plaintext secrets into the Keychain and replace them with refs. Idempotent; leaves '***', empty values and refs alone. */
export async function migrateSecrets(cfg: Config, kc: Keychain): Promise<{ config: Config; moved: string[] }> {
  const out = copy(cfg);
  const moved: string[] = [];
  for (const p of SECRET_PATHS) {
    const t = slot(out, p);
    const v = t?.parent[t.key];
    if (!t || typeof v !== 'string' || v === '' || v === '***' || isKeychainRef(v)) continue;
    const key = p.join('.');
    const name = DERIVED_NAMES[key];
    await kc.set(name, v);
    t.parent[t.key] = `keychain:${name}`;
    moved.push(key);
  }
  return { config: out, moved };
}
