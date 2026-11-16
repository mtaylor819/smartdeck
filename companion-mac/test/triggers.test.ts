import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, TriggerConfig } from '../src/config.js';
import { cleanAlertText, TriggerEngine, validateTriggers } from '../src/triggers.js';

const jsonRes = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

interface Alert { kind: string; seconds: number; text: string }

function rig(triggers: TriggerConfig[], opts: { fetchImpl?: any; capture?: any; ha?: any; alert?: any } = {}) {
  const cfg = defaultConfig();
  cfg.triggers = triggers;
  const alerts: Alert[] = [];
  const logs: string[] = [];
  let now = 1_000_000;
  const e = new TriggerEngine({
    getConfig: () => cfg,
    fetchImpl: opts.fetchImpl ?? (async () => jsonRes({})),
    capture: opts.capture ?? (async () => ''),
    alert: opts.alert ?? (async (kind, seconds, text) => void alerts.push({ kind, seconds, text })),
    ha: opts.ha ?? (() => ({ url: 'http://ha.local:8123', token: 'ha-secret-token' })),
    log: (m) => logs.push(m),
    now: () => now,
  });
  /** advance the clock then run due triggers */
  const step = async (sec = 30) => { now += sec * 1000; await e.tick(); };
  return { e, cfg, alerts, logs, step, set: (ms: number) => (now = ms), get now() { return now; } };
}

const T = (over: Partial<TriggerConfig> & { source: TriggerConfig['source'] }): TriggerConfig => ({
  name: 'T1', alert: { kind: 'red' }, interval: 10, cooldownMin: 5, ...over,
});

// ---------------------------------------------------------------- edge / baseline / cooldown

test('HA equals: baseline does not alert; rising edge alerts once; persistent state does not repeat', async () => {
  let state = 'on';
  const r = rig([T({ source: { type: 'ha_state', entity: 'binary_sensor.door', equals: 'on' }, alert: { kind: 'yellow', text: 'Door open' } })],
    { fetchImpl: async () => jsonRes({ state }) });
  await r.e.tick(); // baseline: already 'on'
  assert.equal(r.alerts.length, 0, 'pre-existing state must not alert');
  await r.step(); await r.step();
  assert.equal(r.alerts.length, 0);
  state = 'off'; await r.step();
  assert.equal(r.alerts.length, 0);
  state = 'on'; await r.step(); // cooldown never started (nothing fired yet) -> fires
  assert.deepEqual(r.alerts, [{ kind: 'yellow', seconds: 60, text: 'Door open' }]);
  await r.step(); await r.step(); // still on -> no repeat
  assert.equal(r.alerts.length, 1);
  assert.equal(r.e.status()['T1'].state, 'firing');
});

test('cooldown suppresses a quick re-trigger, and does not re-fire when the cooldown ends while still active', async () => {
  let state = 'off';
  const r = rig([T({ source: { type: 'ha_state', entity: 'sensor.x', equals: 'on' }, cooldownMin: 5 })],
    { fetchImpl: async () => jsonRes({ state }) });
  await r.e.tick();
  state = 'on'; await r.step(); assert.equal(r.alerts.length, 1);
  state = 'off'; await r.step();
  state = 'on'; await r.step(); // 60 s after first fire: inside the 5 min cooldown
  assert.equal(r.alerts.length, 1, 'suppressed by cooldown');
  assert.equal(r.e.status()['T1'].state, 'cooldown');
  await r.step(600); // cooldown over, still on
  assert.equal(r.alerts.length, 1, 'persistent condition must not alert again');
  state = 'off'; await r.step(); state = 'on'; await r.step(); // clears and returns after cooldown
  assert.equal(r.alerts.length, 2);
});

test('cooldownMin 0 allows immediate re-fire on the next rising edge', async () => {
  let state = 'off';
  const r = rig([T({ source: { type: 'ha_state', entity: 'sensor.x', equals: 'on' }, cooldownMin: 0 })], { fetchImpl: async () => jsonRes({ state }) });
  await r.e.tick();
  for (let i = 0; i < 3; i++) { state = 'on'; await r.step(); state = 'off'; await r.step(); }
  assert.equal(r.alerts.length, 3);
});

test('notEquals works; per-trigger intervals are independent', async () => {
  const hits: string[] = [];
  const r = rig([
    T({ name: 'fast', interval: 10, source: { type: 'ha_state', entity: 'sensor.a', notEquals: 'ok' } }),
    T({ name: 'slow', interval: 100, source: { type: 'ha_state', entity: 'sensor.b', notEquals: 'ok' } }),
  ], { fetchImpl: async (u: string) => (hits.push(u), jsonRes({ state: 'ok' })) });
  await r.e.tick();
  assert.equal(hits.length, 2);
  await r.step(10); // only 'fast' due
  assert.equal(hits.filter((u) => u.includes('sensor.a')).length, 2);
  assert.equal(hits.filter((u) => u.includes('sensor.b')).length, 1);
  await r.step(100);
  assert.equal(hits.filter((u) => u.includes('sensor.b')).length, 2);
});

test('disabled triggers never poll; editing a trigger re-baselines it', async () => {
  let calls = 0;
  let state = 'on';
  const r = rig([T({ enabled: false, source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })],
    { fetchImpl: async () => (calls++, jsonRes({ state })) });
  await r.e.tick(); await r.step();
  assert.equal(calls, 0);
  assert.equal(r.e.status()['T1'].state, 'disabled');
  r.cfg.triggers![0].enabled = true;
  await r.step(); // baseline on enable
  assert.equal(r.alerts.length, 0);
  r.cfg.triggers![0] = { ...r.cfg.triggers![0], alert: { kind: 'blue' } }; // edit => baseline again
  await r.step();
  assert.equal(r.alerts.length, 0, 'edited trigger re-baselines instead of alerting on the existing state');
});

// ---------------------------------------------------------------- sources

test('moonraker: printing->complete and printing->error, baseline ignored, default texts', async () => {
  let st = 'standby';
  const fetchImpl = async (u: string) => (assert.match(u, /^http:\/\/printer:7125\/printer\/objects\/query\?print_stats$/), jsonRes({ result: { status: { print_stats: { state: st } } } }));
  const r = rig([T({ source: { type: 'moonraker', url: 'http://printer:7125/', on: 'finished_or_error' }, cooldownMin: 0 })], { fetchImpl });
  await r.e.tick();
  st = 'printing'; await r.step(); assert.equal(r.alerts.length, 0);
  st = 'complete'; await r.step();
  assert.deepEqual(r.alerts.at(-1), { kind: 'red', seconds: 60, text: 'Print finished' });
  st = 'standby'; await r.step();
  st = 'printing'; await r.step();
  st = 'error'; await r.step();
  assert.equal(r.alerts.at(-1)!.text, 'Print failed');
  assert.equal(r.alerts.length, 2);
});

test('moonraker: a print already running at start is not "news", but its completion is', async () => {
  let st = 'printing';
  const r = rig([T({ source: { type: 'moonraker', url: 'http://p', on: 'finished' } })],
    { fetchImpl: async () => jsonRes({ result: { status: { print_stats: { state: st } } } }) });
  await r.e.tick(); assert.equal(r.alerts.length, 0);
  st = 'complete'; await r.step(); assert.equal(r.alerts.length, 1);
});

test('moonraker: "finished" ignores errors and vice versa; custom text overrides', async () => {
  let st = 'printing';
  const f = async () => jsonRes({ result: { status: { print_stats: { state: st } } } });
  const a = rig([T({ source: { type: 'moonraker', url: 'http://p', on: 'finished' } })], { fetchImpl: f });
  await a.e.tick(); st = 'error'; await a.step(); assert.equal(a.alerts.length, 0);
  st = 'printing';
  const b = rig([T({ source: { type: 'moonraker', url: 'http://p', on: 'error' }, alert: { kind: 'red', text: 'Spaghetti' } })], { fetchImpl: f });
  await b.e.tick(); st = 'error'; await b.step();
  assert.equal(b.alerts[0].text, 'Spaghetti');
});

test('HA state uses the bearer token and tokenEnv', async () => {
  const seen: any[] = [];
  process.env.SD_TEST_HA = 'env-token-123';
  const r = rig([T({ source: { type: 'ha_state', entity: 'light.desk', equals: 'on' } })], {
    ha: () => ({ url: 'http://ha:8123/', tokenEnv: 'SD_TEST_HA' }),
    fetchImpl: async (u: string, o: any) => (seen.push([u, o.headers.Authorization]), jsonRes({ state: 'off' })),
  });
  await r.e.tick();
  assert.deepEqual(seen[0], ['http://ha:8123/api/states/light.desk', 'Bearer env-token-123']);
  delete process.env.SD_TEST_HA;
});

test('http_json operators, numeric vs string compare, and missing path', async () => {
  let body: any = { data: { temp: 20, name: 'warp core stable', s: '7' } };
  const mk = (jsonPath: string, op: any, value: any) =>
    rig([T({ source: { type: 'http_json', url: 'http://x/api', jsonPath, op, value } })], { fetchImpl: async () => jsonRes(body) });
  const fires = async (jsonPath: string, op: any, value: any, before = 'none') => {
    const r = mk(jsonPath, op, value);
    const orig = body;
    // baseline with a value that does NOT satisfy, then flip to the real one so a rising edge occurs
    body = { data: { temp: before === 'none' ? -999 : 0, name: 'zzz', s: '-1' } };
    await r.e.tick();
    body = orig;
    await r.step();
    return r.alerts.length === 1;
  };
  assert.equal(await fires('data.temp', '>', 10), true);
  assert.equal(await fires('data.temp', '<', 10), false);
  assert.equal(await fires('data.temp', '==', '20'), true, 'string "20" compares numerically');
  assert.equal(await fires('data.temp', '!=', -999), true, 'baseline -999 != -999 is false, then 20 != -999 is a rising edge');
  assert.equal(await fires('data.name', 'contains', 'core'), true);
  assert.equal(await fires('data.s', '>', 5), true, 'numeric string compared as number');
  const bad = rig([T({ source: { type: 'http_json', url: 'http://x', jsonPath: 'data.name', op: '>', value: 3 } })], { fetchImpl: async () => jsonRes(body) });
  await bad.e.tick();
  assert.match(bad.e.status()['T1'].error!, /cannot compare/);
  const missing = rig([T({ source: { type: 'http_json', url: 'http://x', jsonPath: 'nope.x', op: '==', value: 1 } })], { fetchImpl: async () => jsonRes(body) });
  await missing.e.tick();
  assert.match(missing.e.status()['T1'].error!, /not found/);
});

test('github: ignores history at baseline, alerts per NEW failed run, ignores in-progress and successes', async () => {
  let run: any = { id: 1, status: 'completed', conclusion: 'failure', run_number: 7 };
  const urls: string[] = [];
  const r = rig([T({ source: { type: 'github', repo: 'me/proj' }, alert: { kind: 'red' }, cooldownMin: 0 })],
    { fetchImpl: async (u: string, o: any) => (urls.push(u), assert.equal(o.headers['User-Agent'], 'smartdeck-mac'), jsonRes({ workflow_runs: [run] })) });
  await r.e.tick(); assert.equal(r.alerts.length, 0, 'old failure at start is history');
  run = { id: 2, status: 'in_progress', conclusion: null }; await r.step(); assert.equal(r.alerts.length, 0);
  run = { id: 2, status: 'completed', conclusion: 'failure' }; await r.step();
  assert.deepEqual(r.alerts, [{ kind: 'red', seconds: 60, text: 'proj CI failed' }]);
  await r.step(); assert.equal(r.alerts.length, 1, 'same run id is not re-alerted');
  run = { id: 3, status: 'completed', conclusion: 'success' }; await r.step(); assert.equal(r.alerts.length, 1);
  run = { id: 4, status: 'completed', conclusion: 'timed_out' }; await r.step(); assert.equal(r.alerts.length, 2);
  assert.equal(urls[0], 'https://api.github.com/repos/me/proj/actions/runs?per_page=1');
});

test('github: a run in progress at start that later fails still alerts; token header from env, never logged', async () => {
  process.env.SD_TEST_GH = 'ghp_supersecret';
  let run: any = { id: 9, status: 'in_progress', conclusion: null };
  let auth = '';
  let fail = false;
  const r = rig([T({ source: { type: 'github', repo: 'a/b', tokenEnv: 'SD_TEST_GH' } })], {
    fetchImpl: async (_u: string, o: any) => { auth = o.headers.Authorization; if (fail) throw new Error('boom ghp_supersecret leaked'); return jsonRes({ workflow_runs: [run] }); },
  });
  await r.e.tick();
  assert.equal(auth, 'Bearer ghp_supersecret');
  run = { id: 9, status: 'completed', conclusion: 'failure' }; await r.step();
  assert.equal(r.alerts.length, 1);
  fail = true; await r.step();
  assert.ok(!JSON.stringify(r.logs).includes('ghp_supersecret'), 'token must be scrubbed from logs');
  assert.ok(!JSON.stringify(r.e.status()).includes('ghp_supersecret'), 'token must be scrubbed from status');
  assert.match(r.e.status()['T1'].error!, /boom \*\*\* leaked/);
  delete process.env.SD_TEST_GH;
});

test('command: nonzero fires on the first look (no baseline), once per failure episode', async () => {
  let code: number | null = 1;
  const capture = async (f: string, a: string[]) => {
    assert.equal(f, '/bin/sh'); assert.deepEqual(a.slice(0, 1), ['-c']);
    if (code) throw Object.assign(new Error('Command failed'), { code });
    return 'fine';
  };
  const r = rig([T({ source: { type: 'command', command: 'check.sh' }, cooldownMin: 0 })], { capture });
  await r.e.tick();
  assert.equal(r.alerts.length, 1);
  await r.step(); assert.equal(r.alerts.length, 1);
  code = null; await r.step();
  code = 2; await r.step(); assert.equal(r.alerts.length, 2);
});

test('command: output match; timeouts and missing shell are errors, not alerts', async () => {
  let out = 'all good';
  const r = rig([T({ source: { type: 'command', command: 'x', on: 'output', match: 'DOWN' } })], { capture: async () => out });
  await r.e.tick(); assert.equal(r.alerts.length, 0);
  out = 'host2 DOWN\n'; await r.step(); assert.equal(r.alerts.length, 1);

  const timeout = rig([T({ source: { type: 'command', command: 'sleep 99' } })], { capture: async () => { throw Object.assign(new Error('t'), { killed: true, code: null }); } });
  await timeout.e.tick();
  assert.equal(timeout.alerts.length, 0);
  assert.equal(timeout.e.status()['T1'].error, 'command timed out');
  const enoent = rig([T({ source: { type: 'command', command: 'x' } })], { capture: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  await enoent.e.tick();
  assert.equal(enoent.alerts.length, 0);
  assert.match(enoent.e.status()['T1'].error!, /ENOENT/);
});

// ---------------------------------------------------------------- robustness

test('errors are recorded, logged once per distinct message, recover, and polling continues', async () => {
  let mode: 'bad' | 'ok' = 'bad';
  const r = rig([T({ source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })],
    { fetchImpl: async () => (mode === 'bad' ? jsonRes({}, false, 503) : jsonRes({ state: 'off' })) });
  await r.e.tick(); await r.step(); await r.step();
  assert.equal(r.e.status()['T1'].state, 'error');
  assert.equal(r.e.status()['T1'].error, 'HTTP 503');
  assert.equal(r.logs.filter((l) => l.includes('HTTP 503')).length, 1, 'same error logged once');
  mode = 'ok'; await r.step();
  assert.equal(r.e.status()['T1'].state, 'idle');
  assert.equal(r.e.status()['T1'].error, undefined);
});

test('a failing alert() does not kill the engine; it is retried and delivered once', async () => {
  let fail = true;
  const delivered: Alert[] = [];
  let state = 'off';
  const r = rig([T({ source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })], {
    fetchImpl: async () => jsonRes({ state }),
    alert: async (kind: string, seconds: number, text: string) => { if (fail) throw new Error('deck not connected'); delivered.push({ kind, seconds, text }); },
  });
  await r.e.tick();
  state = 'on'; await r.step();
  assert.equal(delivered.length, 0);
  assert.ok(r.logs.some((l) => l.includes('not delivered')));
  await r.step(); assert.equal(delivered.length, 0, 'still failing, engine still alive');
  fail = false; await r.step();
  assert.equal(delivered.length, 1);
  await r.step(); assert.equal(delivered.length, 1, 'no duplicate after delivery');
});

test('pending alert expires after 10 minutes', async () => {
  let fail = true; let state = 'off'; let n = 0;
  const r = rig([T({ source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })], {
    fetchImpl: async () => jsonRes({ state }),
    alert: async () => { if (fail) throw new Error('x'); n++; },
  });
  await r.e.tick(); state = 'on'; await r.step();
  await r.step(700); // 11+ minutes later
  fail = false; await r.step();
  assert.equal(n, 0, 'stale alert dropped');
});

test('removing a trigger drops its state; alert text is sanitised; default text is the trigger name', async () => {
  let state = 'off';
  const r = rig([T({ name: 'Print: done ✓ very long name indeed', source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })], { fetchImpl: async () => jsonRes({ state }) });
  await r.e.tick(); state = 'on'; await r.step();
  assert.equal(r.alerts[0].text, 'Print  done  very long n'); // 24 chars, colon and non-ASCII removed
  assert.ok(r.alerts[0].text.length <= 24 && !r.alerts[0].text.includes(':'));
  r.cfg.triggers = [];
  await r.e.tick();
  assert.deepEqual(r.e.status(), {});
  assert.equal(cleanAlertText('✓✓'), 'Alert');
});

test('start()/stop() run on a timer without leaking', async () => {
  let n = 0;
  const r = rig([T({ source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })], { fetchImpl: async () => (n++, jsonRes({ state: 'off' })) });
  r.e.start(5);
  await new Promise((res) => setTimeout(res, 40));
  r.e.stop();
  assert.ok(n >= 1);
  const after = n;
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(n, after);
});

test('no secrets in logs for HA failures', async () => {
  const r = rig([T({ source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })], {
    fetchImpl: async () => { throw new Error('connect failed using Bearer ha-secret-token'); },
  });
  await r.e.tick();
  assert.ok(!r.logs.join('\n').includes('ha-secret-token'));
  assert.ok(!r.e.status()['T1'].error!.includes('ha-secret-token'));
  const none = rig([T({ source: { type: 'ha_state', entity: 'a.b', equals: 'on' } })], { ha: () => undefined });
  await none.e.tick();
  assert.match(none.e.status()['T1'].error!, /not configured/);
});

// ---------------------------------------------------------------- validation

const good = (): TriggerConfig => ({ name: 'ok', source: { type: 'ha_state', entity: 'light.x', equals: 'on' }, alert: { kind: 'red' } });

test('validateTriggers accepts every source type and optional fields', () => {
  validateTriggers(undefined);
  validateTriggers([]);
  validateTriggers([
    good(),
    { name: 'm', source: { type: 'moonraker', url: 'http://p:7125', on: 'finished_or_error' }, alert: { kind: 'blue', seconds: 0, text: 'Done' }, interval: 10, cooldownMin: 0 },
    { name: 'h', source: { type: 'http_json', url: 'https://a/b', jsonPath: 'x.y', op: 'contains', value: 'a' }, alert: { kind: 'yellow' }, enabled: false },
    { name: 'g', source: { type: 'github', repo: 'o/n', tokenEnv: 'GH_TOKEN' }, alert: { kind: 'green', seconds: 3600 } },
    { name: 'c', source: { type: 'command', command: 'ls', on: 'output', match: 'x' }, alert: { kind: 'red' } },
  ]);
});

test('validateTriggers rejects bad input with readable messages', () => {
  const bad = (mut: (t: any) => void, re: RegExp) => {
    const t: any = JSON.parse(JSON.stringify(good()));
    mut(t);
    assert.throws(() => validateTriggers([t]), re);
  };
  assert.throws(() => validateTriggers('x'), /must be a list/);
  assert.throws(() => validateTriggers([null]), /must be an object/);
  assert.throws(() => validateTriggers([good(), good()]), /used twice/);
  bad((t) => (t.name = ''), /needs a name/);
  bad((t) => (t.name = 'x'.repeat(41)), /longer than 40/);
  bad((t) => (t.enabled = 'yes'), /enabled/);
  bad((t) => (t.source.type = 'carrier-pigeon'), /source type/);
  bad((t) => (t.source = undefined), /source type/);
  bad((t) => (t.source.entity = 'nodot'), /entity/);
  bad((t) => { delete t.source.equals; }, /equals or notEquals/);
  bad((t) => (t.alert.kind = 'purple'), /alert kind/);
  bad((t) => (t.alert.seconds = 3601), /seconds/);
  bad((t) => (t.alert.seconds = -1), /seconds/);
  bad((t) => (t.alert.text = 'a'.repeat(25)), /24/);
  bad((t) => (t.alert.text = 'a:b'), /colons/);
  bad((t) => (t.alert.text = 'héllo'), /ASCII/);
  bad((t) => (t.interval = 9), /interval/);
  bad((t) => (t.interval = 'fast'), /interval/);
  bad((t) => (t.cooldownMin = -1), /cooldownMin/);
  const src = (s: any) => ({ name: 's', source: s, alert: { kind: 'red' } });
  assert.throws(() => validateTriggers([src({ type: 'moonraker', url: 'ftp://p', on: 'finished' })]), /http/);
  assert.throws(() => validateTriggers([src({ type: 'moonraker', url: 'not a url', on: 'finished' })]), /valid URL/);
  assert.throws(() => validateTriggers([src({ type: 'moonraker', url: 'http://p', on: 'sometimes' })]), /"on"/);
  assert.throws(() => validateTriggers([src({ type: 'http_json', url: 'file:///etc/passwd', jsonPath: 'a', op: '>', value: 1 })]), /http/);
  assert.throws(() => validateTriggers([src({ type: 'http_json', url: 'http://a', jsonPath: 'a', op: '~', value: 1 })]), /op must/);
  assert.throws(() => validateTriggers([src({ type: 'http_json', url: 'http://a', jsonPath: 'a', op: '>', value: {} })]), /value/);
  assert.throws(() => validateTriggers([src({ type: 'http_json', url: 'http://a', op: '>', value: 1 })]), /jsonPath/);
  assert.throws(() => validateTriggers([src({ type: 'github', repo: 'noslash' })]), /owner\/name/);
  assert.throws(() => validateTriggers([src({ type: 'github', repo: 'a/b', tokenEnv: 'bad name' })]), /environment variable/);
  assert.throws(() => validateTriggers([src({ type: 'command', command: '' })]), /command is required/);
  assert.throws(() => validateTriggers([src({ type: 'command', command: 'x'.repeat(501) })]), /500/);
  assert.throws(() => validateTriggers([src({ type: 'command', command: 'x', on: 'output' })]), /match/);
  assert.throws(() => validateTriggers([src({ type: 'command', command: 'x', on: 'sometimes' })]), /"on"/);
});
