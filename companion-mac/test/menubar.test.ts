import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSwiftbarPluginDir, installSwiftbarPlugin, PLUGIN_FILENAME, swiftbarPluginSource } from '../src/menubar.js';

test('plugin source: structure, items, and params', () => {
  const s = swiftbarPluginSource({ nodePath: '/usr/local/bin/node', cliPath: '/Users/me/smartdeck/dist/cli.js' });
  assert.ok(s.startsWith('#!/bin/bash\n'));
  assert.match(s, /status --short/);
  assert.match(s, /^---$/m);
  assert.match(s, /Open SmartDeck UI \| href=http:\/\/127\.0\.0\.1:7777\//);
  assert.match(s, /Red alert \(30s\) \| shell="\/usr\/local\/bin\/node" param1="\/Users\/me\/smartdeck\/dist\/cli\.js" param2="alert" param3="red" param4="30" param5="Red alert" terminal=false refresh=true/);
  assert.match(s, /param2="alert" param3="off" terminal=false refresh=true/);
  assert.match(s, /Yellow alert/);
  assert.match(s, /Blue notice/);
  assert.match(s, /Sync to deck/);
  assert.match(s, /launchctl param1=kickstart param2=-k param3="gui\/%s\/com\.smartdeck\.mac"/);
  assert.match(s, /smartdeck-mac\.log/);
});

test('paths with spaces and single quotes are escaped for bash and quoted for SwiftBar', () => {
  const s = swiftbarPluginSource({ nodePath: "/Users/Mark's Mac/bin/node", cliPath: '/Users/Mark/My Apps/smart deck/cli.js' });
  assert.ok(s.includes(`NODE='/Users/Mark'\\''s Mac/bin/node'`));
  assert.ok(s.includes(`CLI='/Users/Mark/My Apps/smart deck/cli.js'`));
  assert.ok(s.includes(`shell="/Users/Mark's Mac/bin/node" param1="/Users/Mark/My Apps/smart deck/cli.js"`));
  // the menu is emitted from a quoted heredoc, so $ and backticks in paths are not expanded
  assert.ok(s.includes("cat <<'MENU'"));
});

test('paths that would break the format are rejected', () => {
  for (const bad of ['/a\nb', '/a|b', '/a"b', '', '/a\rb'])
    assert.throws(() => swiftbarPluginSource({ nodePath: bad, cliPath: '/ok/cli.js' }), /not allowed/, JSON.stringify(bad));
  assert.throws(() => swiftbarPluginSource({ nodePath: '/ok/node', cliPath: '/x|y' }), /cliPath/);
});

const fsWith = (...dirs: string[]) => ({ existsSync: (p: string) => dirs.includes(p) });

test('plugin dir discovery order: SwiftBar pref, SwiftBar default, xbar', async () => {
  const sb = '/Users/me/Library/Application Support/SwiftBar/Plugins';
  const xb = '/Users/me/Library/Application Support/xbar/plugins';
  const ok = async () => '/custom/plugins\n';
  const none = async (): Promise<string> => {
    throw new Error('domain does not exist');
  };
  assert.equal(await findSwiftbarPluginDir(ok, fsWith('/custom/plugins', sb, xb), '/Users/me'), '/custom/plugins');
  assert.equal(await findSwiftbarPluginDir(ok, fsWith(sb, xb), '/Users/me'), sb, 'pref dir missing on disk -> fall through');
  assert.equal(await findSwiftbarPluginDir(none, fsWith(sb, xb), '/Users/me'), sb);
  assert.equal(await findSwiftbarPluginDir(none, fsWith(xb), '/Users/me'), xb);
  assert.equal(await findSwiftbarPluginDir(none, fsWith(), '/Users/me'), undefined);
});

test('defaults is called with the SwiftBar domain', async () => {
  let seen: string[] = [];
  await findSwiftbarPluginDir(
    async (f, a) => {
      seen = [f, ...a];
      return '';
    },
    fsWith(),
    '/h',
  );
  assert.deepEqual(seen, ['defaults', 'read', 'com.ameba.SwiftBar', 'PluginDirectory']);
});

test('installSwiftbarPlugin writes smartdeck.10s.sh mode 0755', () => {
  const log: unknown[] = [];
  const fs = {
    mkdirSync: (p: string, o?: { recursive: boolean }) => log.push(['mkdir', p, o]),
    writeFileSync: (p: string, d: string, o?: { mode: number }) => log.push(['write', p, d, o]),
    chmodSync: (p: string, m: number) => log.push(['chmod', p, m]),
  };
  const p = installSwiftbarPlugin('/plugins', 'SRC', fs);
  assert.equal(p, `/plugins/${PLUGIN_FILENAME}`);
  assert.equal(PLUGIN_FILENAME, 'smartdeck.10s.sh');
  assert.deepEqual(log, [['mkdir', '/plugins', { recursive: true }], ['write', p, 'SRC', { mode: 0o755 }], ['chmod', p, 0o755]]);
});
