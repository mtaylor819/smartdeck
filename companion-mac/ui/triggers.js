// Alert-trigger editor. Loaded as a separate script; call window.renderTriggersEditor(container, cfg, onChange).
// It edits cfg.triggers in place and calls onChange() after every edit. Strict CSP: no inline handlers, user text via textContent only.
(function () {
  'use strict';

  const SOURCES = {
    moonraker: { label: 'QIDI / Klipper print (Moonraker)', def: () => ({ type: 'moonraker', url: 'http://printer.local:7125', on: 'finished_or_error' }) },
    ha_state: { label: 'Home Assistant state', def: () => ({ type: 'ha_state', entity: '', equals: 'on' }) },
    http_json: { label: 'JSON from a URL', def: () => ({ type: 'http_json', url: 'https://', jsonPath: '', op: '>', value: 0 }) },
    github: { label: 'GitHub Actions failure', def: () => ({ type: 'github', repo: '' }) },
    command: { label: 'Shell command', def: () => ({ type: 'command', command: '', on: 'nonzero' }) },
  };
  const KINDS = ['red', 'yellow', 'blue', 'green'];

  /** tiny element builder (app.js's h() isn't importable from here) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const row = (label, input) => h('div', { class: 'row' }, h('label', {}, label), input);

  function uniqueName(list) {
    const names = new Set(list.map((t) => t.name));
    for (let i = list.length + 1; ; i++) if (!names.has('Trigger ' + i)) return 'Trigger ' + i;
  }

  function statusText(st) {
    if (!st) return 'not running yet';
    const bits = [st.state];
    if (st.error) bits.push('error: ' + st.error);
    else if (st.lastValue !== undefined && st.lastValue !== '') bits.push('last value: ' + st.lastValue);
    if (st.lastFired) bits.push('last fired ' + new Date(st.lastFired).toLocaleTimeString());
    return bits.join(' · ');
  }

  window.renderTriggersEditor = function renderTriggersEditor(container, cfg, onChange) {
    const changed = () => { if (typeof onChange === 'function') onChange(); };
    const list = () => (cfg.triggers ||= []);
    /** status line elements by trigger name, refreshed while the editor is on screen */
    let statusEls = new Map();
    if (container.__trigTimer) clearInterval(container.__trigTimer);

    // text input bound to obj[key]; empty => delete (optional) or keep '' (required)
    const text = (obj, key, extra = {}, required = false) => h('input', {
      type: 'text', ...extra, value: obj[key] ?? '',
      oninput: (e) => { if (e.target.value === '' && !required) delete obj[key]; else obj[key] = e.target.value; changed(); },
    });
    const num = (obj, key, extra = {}) => h('input', {
      type: 'number', ...extra, value: obj[key] ?? '',
      oninput: (e) => { if (e.target.value === '') delete obj[key]; else obj[key] = Number(e.target.value); changed(); },
    });
    const select = (obj, key, options, afterChange) => h('select', {
      onchange: (e) => { obj[key] = e.target.value; changed(); if (afterChange) afterChange(); },
    }, options.map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l)));

    function sourceFields(t, redraw) {
      const s = t.source;
      switch (s.type) {
        case 'moonraker':
          return [
            row('Printer URL', text(s, 'url', { placeholder: 'http://printer.local:7125' }, true)),
            row('Alert when', select(s, 'on', [['finished', 'Print finished'], ['error', 'Print failed'], ['finished_or_error', 'Finished or failed']])),
          ];
        case 'ha_state':
          return [
            row('Entity id', text(s, 'entity', { placeholder: 'binary_sensor.front_door' }, true)),
            row('Alert when', h('div', { class: 'inline' },
              h('select', { onchange: (e) => {
                const val = s.equals ?? s.notEquals ?? '';
                delete s.equals; delete s.notEquals;
                s[e.target.value] = val;
                changed(); redraw();
              } }, [['equals', 'state is'], ['notEquals', 'state is not']].map(([v, l]) => h('option', { value: v, selected: (s.notEquals !== undefined ? 'notEquals' : 'equals') === v }, l))),
              h('input', { type: 'text', placeholder: 'on', value: s.notEquals !== undefined ? s.notEquals : (s.equals ?? ''),
                oninput: (e) => { s[s.notEquals !== undefined ? 'notEquals' : 'equals'] = e.target.value; changed(); } }))),
            h('div', { class: 'muted' }, 'Uses the Home Assistant URL and token from Settings.'),
          ];
        case 'http_json':
          return [
            row('URL', text(s, 'url', { placeholder: 'https://example.com/status.json' }, true)),
            row('JSON path', text(s, 'jsonPath', { placeholder: 'data.temp' }, true)),
            row('Alert when', h('div', { class: 'inline' },
              select(s, 'op', ['>', '<', '==', '!=', 'contains'].map((o) => [o, o])),
              h('input', { type: 'text', value: s.value ?? '',
                oninput: (e) => { const v = e.target.value; s.value = v !== '' && Number.isFinite(Number(v)) ? Number(v) : v; changed(); } }))),
          ];
        case 'github':
          return [
            row('Repository', text(s, 'repo', { placeholder: 'owner/name' }, true)),
            row('Token env var', text(s, 'tokenEnv', { placeholder: 'GITHUB_TOKEN (private repos)' })),
            h('div', { class: 'muted' }, 'Alerts when the latest workflow run fails or times out. The token is read from an environment variable, never stored here.'),
          ];
        case 'command':
          return [
            row('Command', h('textarea', { value: s.command ?? '', placeholder: 'curl -fsS https://example.com/health', oninput: (e) => { s.command = e.target.value; changed(); } })),
            row('Alert when', select(s, 'on', [['nonzero', 'it exits with an error'], ['output', 'output contains…']], redraw)),
            (s.on === 'output') ? row('Match text', text(s, 'match', { placeholder: 'DOWN' }, true)) : null,
            h('div', { class: 'muted' }, 'Runs in /bin/sh on this Mac. Anything you can script (calendar, backups, disk space) can raise an alert.'),
          ];
        default:
          return [h('div', { class: 'err' }, 'Unknown source type: ' + String(s.type))];
      }
    }

    function triggerBox(t, i, redraw) {
      const statusEl = h('div', { class: 'muted' }, statusText(window.__triggerStatus?.[t.name]));
      statusEls.set(t.name, statusEl);
      const box = h('div', { class: 'box' });
      box.append(
        h('div', { class: 'inline' },
          h('input', { type: 'checkbox', title: 'Enabled', checked: t.enabled !== false,
            onchange: (e) => { if (e.target.checked) delete t.enabled; else t.enabled = false; changed(); } }),
          h('input', { type: 'text', value: t.name ?? '', placeholder: 'Name (unique)', maxLength: 40,
            oninput: (e) => { statusEls.delete(t.name); t.name = e.target.value; statusEls.set(t.name, statusEl); changed(); } }),
          h('button', { class: 'small danger', title: 'Remove trigger', onclick: () => { list().splice(i, 1); if (!list().length) delete cfg.triggers; changed(); redraw(); } }, '✕')),
        statusEl,
        // changing the source type swaps the whole source object
        row('Watch', h('select', { onchange: (e) => { t.source = SOURCES[e.target.value].def(); changed(); redraw(); } },
          Object.entries(SOURCES).map(([k, v]) => h('option', { value: k, selected: t.source.type === k }, v.label)))),
      );
      box.append(...sourceFields(t, redraw).filter(Boolean));
      box.append(
        h('h4', {}, 'Then'),
        row('Alert', h('div', { class: 'inline' },
          select(t.alert, 'kind', KINDS.map((k) => [k, k])),
          h('input', { type: 'number', min: 0, max: 3600, placeholder: '60', title: 'Seconds (0 = until touched)', value: t.alert.seconds ?? '',
            oninput: (e) => { if (e.target.value === '') delete t.alert.seconds; else t.alert.seconds = Number(e.target.value); changed(); } }),
          h('span', { class: 'muted' }, 'sec'))),
        row('Banner text', text(t.alert, 'text', { placeholder: 'defaults to the trigger name', maxLength: 24 })),
        row('Check every (s)', num(t, 'interval', { min: 10, placeholder: '30' })),
        row('Cooldown (min)', num(t, 'cooldownMin', { min: 0, placeholder: '5' })),
      );
      return box;
    }

    function draw() {
      statusEls = new Map();
      container.replaceChildren(
        h('h3', {}, 'Alert triggers'),
        h('div', { class: 'muted' }, 'Turn outside events into an LED-ring alert on the deck. Each trigger fires once when something goes wrong, then waits out its cooldown. Existing problems when the app starts don’t alert.'),
      );
      (cfg.triggers || []).forEach((t, i) => container.append(triggerBox(t, i, draw))); // don't create cfg.triggers just by rendering
      container.append(h('button', { class: 'small', onclick: () => {
        list().push({ name: uniqueName(list()), source: SOURCES.ha_state.def(), alert: { kind: 'red', seconds: 60 } });
        changed(); draw();
      } }, '+ Trigger'));
    }
    draw();

    // keep the status lines fresh while this editor is on screen (window.__triggerStatus is filled by the status poller)
    container.__trigTimer = setInterval(() => {
      if (!document.body.contains(container)) { clearInterval(container.__trigTimer); return; }
      for (const [name, el] of statusEls) el.textContent = statusText(window.__triggerStatus?.[name]);
    }, 2000);
  };
})();
