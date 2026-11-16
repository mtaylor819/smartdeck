import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { isKeychainRef, Keychain, migrateSecrets, refName, resolveConfigSecrets, SECRET_PATHS, SecurityRunner } from '../src/secrets.js';

function fake() {
  const store = new Map<string, string>();
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const run: SecurityRunner = async (file, args, input) => {
    calls.push({ file, args, input });
    if (args[0] === '-i') {
      const m = /^add-generic-password -U -s smartdeck-mac -a (\S+) -X ([0-9a-f]+)\n$/.exec(input ?? '');
      if (!m) throw new Error('bad interactive command');
      store.set(m[1], Buffer.from(m[2], 'hex').toString('utf8'));
      return '';
    }
    const a = args[args.indexOf('-a') + 1];
    if (args[0] === 'find-generic-password') {
      if (!store.has(a)) throw Object.assign(new Error('The specified item could not be found in the keychain.'), { code: 44 });
      return store.get(a)! + '\n';
    }
    if (args[0] === 'delete-generic-password') {
      if (!store.delete(a)) throw Object.assign(new Error('could not be found'), { code: 44 });
      return '';
    }
    throw new Error('unexpected');
  };
  return { store, calls, kc: new Keychain(run) };
}

test('ref detection and names', () => {
  assert.ok(isKeychainRef('keychain:ha-token'));
  assert.ok(isKeychainRef('keychain:a.b_c-1'));
  for (const bad of ['keychain:', 'keychain:a b', 'Keychain:x', 'keychain:x;rm', '', 'plain', 5, null, 'keychain:' + 'a'.repeat(65)])
    assert.equal(isKeychainRef(bad), false, String(bad));
  assert.equal(refName('keychain:ha-token'), 'ha-token');
  assert.throws(() => refName('nope'), /not a keychain reference/);
});

test('set sends the command via stdin, hex-encoded: no secret in any argv', async () => {
  const { kc, calls, store } = fake();
  const secret = 'p@ss "w\\ord" \'x\' $HOME ünï ✓';
  await kc.set('ha-token', secret);
  assert.equal(calls.length, 2); // the write, then a read-back to verify it (security -i can exit 0 on failure)
  assert.deepEqual(calls[0].args, ['-i']);
  assert.equal(calls[1].args[0], 'find-generic-password');
  assert.ok(calls[0].input!.endsWith('\n'));
  assert.ok(!calls[0].input!.includes('p@ss'), 'plaintext must not be in the command text either');
  assert.equal(store.get('ha-token'), secret);
  for (const c of calls) assert.ok(!c.args.join(' ').includes('p@ss'));
});

test('get returns the secret without the trailing newline; missing => undefined; argv has no secret', async () => {
  const { kc, calls } = fake();
  await kc.set('t', 'abc def');
  assert.equal(await kc.get('t'), 'abc def');
  assert.equal(await kc.get('nope'), undefined);
  const find = calls.filter((c) => c.args[0] === 'find-generic-password');
  assert.deepEqual(find[0].args, ['find-generic-password', '-s', 'smartdeck-mac', '-a', 't', '-w']);
});

test('get surfaces real failures without leaking details', async () => {
  const kc = new Keychain(async () => {
    throw Object.assign(new Error('secret=hunter2 denied'), { code: 51 });
  });
  await assert.rejects(kc.get('x'), (e: Error) => /keychain read failed for "x"/.test(e.message) && !e.message.includes('hunter2'));
});

test('remove: deletes, tolerates missing', async () => {
  const { kc, store } = fake();
  await kc.set('a', '1');
  await kc.remove('a');
  assert.equal(store.has('a'), false);
  await kc.remove('a'); // not found => fine
});

test('rejects newline / NUL / empty values and bad names', async () => {
  const { kc, calls } = fake();
  await assert.rejects(kc.set('a', 'x\ny'), /newlines/);
  await assert.rejects(kc.set('a', 'x\0y'), /NUL/);
  await assert.rejects(kc.set('a', 'x\ry'), /newlines/);
  await assert.rejects(kc.set('a', ''), /empty/);
  await assert.rejects(kc.set('a b', 'x'), /invalid keychain name/);
  await assert.rejects(kc.get('a;b'), /invalid keychain name/);
  assert.equal(calls.length, 0);
});

test('resolveConfigSecrets replaces refs, leaves everything else, throws naming the ref on a missing item', async () => {
  const { kc } = fake();
  await kc.set('ha-token', 'S1');
  await kc.set('wifi', 'S2');
  const cfg = defaultConfig();
  cfg.integrations = { homeassistant: { url: 'http://h', token: 'keychain:ha-token' } };
  cfg.device = { token: 'plain-token-1', wifi: { ssid: 'x', password: 'keychain:wifi' } };
  const out = await resolveConfigSecrets(cfg, kc);
  assert.equal(out.integrations!.homeassistant!.token, 'S1');
  assert.equal(out.device!.wifi!.password, 'S2');
  assert.equal(out.device!.token, 'plain-token-1');
  assert.equal(cfg.integrations!.homeassistant!.token, 'keychain:ha-token', 'input untouched');
  cfg.device.token = 'keychain:gone';
  await assert.rejects(resolveConfigSecrets(cfg, kc), (e: Error) => e.message.includes('keychain:gone'));
});

test('resolve ignores refs outside the secret paths', async () => {
  const { kc } = fake();
  const cfg = defaultConfig();
  cfg.title = 'keychain:zzz';
  assert.equal((await resolveConfigSecrets(cfg, kc)).title, 'keychain:zzz');
});

test('migrateSecrets moves plaintext, skips *** / empty / refs, is idempotent', async () => {
  const { kc, store } = fake();
  const cfg = defaultConfig();
  cfg.integrations = { homeassistant: { url: 'http://h', token: 'ha-secret' } };
  cfg.device = { token: '***', wifi: { ssid: 's', password: 'wifi-secret' }, ha: { url: 'http://h', token: '' } };
  const r = await migrateSecrets(cfg, kc);
  assert.deepEqual(r.moved.sort(), ['device.wifi.password', 'integrations.homeassistant.token']);
  assert.equal(r.config.integrations!.homeassistant!.token, 'keychain:ha-token');
  assert.equal(r.config.device!.wifi!.password, 'keychain:wifi-password');
  assert.equal(r.config.device!.token, '***');
  assert.equal(r.config.device!.ha!.token, '');
  assert.equal(store.get('ha-token'), 'ha-secret');
  assert.equal(store.get('wifi-password'), 'wifi-secret');
  const again = await migrateSecrets(r.config, kc);
  assert.deepEqual(again.moved, []);
  assert.deepEqual(again.config, r.config);
  assert.equal(JSON.stringify(r.config).includes('ha-secret'), false);
});

test('SECRET_PATHS matches the server set', () => {
  assert.deepEqual(
    SECRET_PATHS.map((p) => p.join('.')).sort(),
    ['device.ha.token', 'device.token', 'device.wifi.password', 'integrations.homeassistant.token'],
  );
});

test('set fails loudly when the read-back does not match (security -i can fail silently)', async () => {
  const kc = new Keychain(async (_f, a) => {
    if (a[0] === 'find-generic-password') { const e: any = new Error('nf'); e.code = 44; throw e; }
    return ''; // "success" but nothing was stored
  });
  await assert.rejects(kc.set('x', 'secret-value'), /could not be verified/);
});
