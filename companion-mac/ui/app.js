'use strict';
// SmartDeck web UI. Vanilla JS, no build step. All user text is rendered via textContent / value.

const TOKEN = document.querySelector('meta[name=csrf-token]').content;
const MAX_COLS = 6, MAX_ROWS = 3; // 5" 800x480 deck

const state = {
  cfg: null,
  savedJson: '',
  page: 0,
  sel: null, // selected button index on the current page
  view: 'editor',
  status: null,
  icons: [],
};

// ---------- tiny DOM helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
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
const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const hexIn = (v, fb) => (/^[0-9a-f]{6}$/i.test(v || '') ? '#' + v : fb);

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  if (window.lcarsSound) window.lcarsSound(isError ? 'error' : 'confirm');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), isError ? 5000 : 2200);
}

async function api(method, path, body, raw) {
  const opts = { method, headers: { 'X-SmartDeck-Token': TOKEN } };
  if (raw) opts.body = raw;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- dirty tracking ----------
const isDirty = () => JSON.stringify(trimConfig(state.cfg)) !== state.savedJson;
function markDirty() {
  $('saveBtn').disabled = !isDirty();
  $('saveBtn').textContent = isDirty() ? 'Save •' : 'Save';
}
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- config helpers ----------
const cells = () => state.cfg.grid.cols * state.cfg.grid.rows;
function pageButtons() {
  const p = state.cfg.pages[state.page];
  while (p.buttons.length < cells()) p.buttons.push(null);
  return p.buttons;
}
function trimConfig(cfg) {
  const out = clone(cfg);
  for (const p of out.pages) {
    while (p.buttons.length && !p.buttons[p.buttons.length - 1]) p.buttons.pop();
    p.buttons = p.buttons.slice(0, out.grid.cols * out.grid.rows);
  }
  // Drop empty optional sections the settings view creates as editing scaffolding.
  if (out.power && !Object.keys(out.power).length) delete out.power;
  if (!out.weather) delete out.weather;
  if (out.sounds && !Object.keys(out.sounds).length) delete out.sounds;
  if (out.device) {
    const prune = (o) => {
      for (const k of Object.keys(o)) {
        if (o[k] === '' || o[k] === undefined || o[k] === null) delete o[k];
        else if (typeof o[k] === 'object' && !Array.isArray(o[k])) { prune(o[k]); if (!Object.keys(o[k]).length) delete o[k]; }
      }
    };
    prune(out.device);
    if (out.device.wifi && !out.device.wifi.ssid) delete out.device.wifi;
    if (out.device.ha && !out.device.ha.url) delete out.device.ha;
    if (!Object.keys(out.device).length) delete out.device;
  }
  if (out.brightnessSchedule && !out.brightnessSchedule.length) delete out.brightnessSchedule;
  if (out.appPages) {
    out.appPages = out.appPages.filter((r) => r.app);
    if (!out.appPages.length) delete out.appPages;
  }
  const ha = out.integrations?.homeassistant;
  if (ha && !ha.url && !ha.token && !ha.tokenEnv) delete out.integrations.homeassistant;
  if (out.integrations && !Object.keys(out.integrations).length) delete out.integrations;
  return out;
}

// ---------- action schema ----------
const MEDIA_KEYS = ['play_pause', 'next', 'previous', 'volume_up', 'volume_down', 'mute'];
const TYPES = {
  none: { label: 'None', def: () => ({ type: 'none' }) },
  key: { label: 'Hotkey', def: () => ({ type: 'key', combo: 'cmd+c' }) },
  text: { label: 'Type text', def: () => ({ type: 'text', text: '' }) },
  paste: { label: 'Paste text', def: () => ({ type: 'paste', text: '' }) },
  app: { label: 'Open app', def: () => ({ type: 'app', app: '' }) },
  website: { label: 'Website', def: () => ({ type: 'website', url: 'https://' }) },
  urlscheme: { label: 'URL scheme', def: () => ({ type: 'urlscheme', url: '' }) },
  script: { label: 'Shell script', def: () => ({ type: 'script', command: '' }) },
  applescript: { label: 'AppleScript', def: () => ({ type: 'applescript', script: '' }) },
  shortcut: { label: 'Shortcuts.app', def: () => ({ type: 'shortcut', name: '' }) },
  media: { label: 'Media key', def: () => ({ type: 'media', key: 'play_pause' }) },
  sound: { label: 'Play sound', def: () => ({ type: 'sound', file: '' }) },
  mouse: { label: 'Mouse', def: () => ({ type: 'mouse', op: 'click' }) },
  http: { label: 'HTTP request', def: () => ({ type: 'http', url: 'https://', method: 'GET' }) },
  ha: { label: 'Home Assistant', def: () => ({ type: 'ha', service: 'light.toggle', entity: '' }) },
  alert: { label: 'LED alert (red alert…)', def: () => ({ type: 'alert', kind: 'red', seconds: 10, text: '' }) },
  blehost: { label: 'Bluetooth host (device)', def: () => ({ type: 'blehost', slot: 'next' }), noNest: true },
  multi: { label: 'Multi-action', def: () => ({ type: 'multi', steps: [] }) },
  delay: { label: 'Delay', def: () => ({ type: 'delay', ms: 500 }), stepOnly: true },
  toggle: { label: 'Toggle', def: () => ({ type: 'toggle', on: { type: 'none' }, off: { type: 'none' } }), noNest: true },
  goto: { label: 'Go to page (device)', def: () => ({ type: 'goto', page: 1 }), noNest: true },
  timer: { label: 'Timer (device)', def: () => ({ type: 'timer', duration: 60 }), noNest: true },
  counter: { label: 'Counter (device)', def: () => ({ type: 'counter', counterStartValue: 0, counterAction: 'increment' }), noNest: true },
};

/** Field specs per action type: [key, label, kind, extra] */
const FIELDS = {
  key: [['combo', 'Shortcut', 'combo']],
  text: [['text', 'Text', 'area']],
  paste: [['text', 'Text', 'area']],
  app: [['app', 'App name or path', 'text']],
  website: [['url', 'URL', 'text']],
  urlscheme: [['url', 'URL', 'text']],
  script: [['command', 'Command', 'area']],
  applescript: [['script', 'Script', 'area']],
  shortcut: [['name', 'Shortcut name', 'text'], ['input', 'Input (optional)', 'text']],
  media: [['key', 'Key', 'select', MEDIA_KEYS]],
  sound: [['file', 'Sound file path', 'text']],
  mouse: [['op', 'Operation', 'select', ['click', 'double', 'right', 'move', 'scroll']], ['x', 'X', 'num'], ['y', 'Y', 'num'], ['dx', 'Scroll dx', 'num'], ['dy', 'Scroll dy', 'num']],
  http: [['url', 'URL', 'text'], ['method', 'Method', 'select', ['GET', 'POST', 'PUT', 'DELETE']], ['body', 'Body', 'area'], ['headers', 'Headers (JSON)', 'json']],
  ha: [['service', 'Service (domain.service)', 'text'], ['entity', 'Entity id', 'text'], ['data', 'Extra data (JSON)', 'json']],
  alert: [['kind', 'Alert', 'select', ['red', 'yellow', 'blue', 'green', 'off']], ['seconds', 'Seconds (0 = until acked)', 'num'], ['text', 'Banner text', 'text']],
  blehost: [['slot', 'Switch to', 'slot']],
  delay: [['ms', 'Milliseconds', 'num']],
  goto: [['page', 'Page (1-based)', 'num']],
  timer: [['duration', 'Seconds', 'num']],
  counter: [['counterStartValue', 'Start value', 'num'], ['counterAction', 'On press', 'select', ['increment', 'decrement', 'reset']]],
};

function row(label, input) { return h('div', { class: 'row' }, h('label', {}, label), input); }

function fieldInput(obj, key, kind, extra, onChange) {
  const set = (v) => { if (v === '' || v === undefined) delete obj[key]; else obj[key] = v; onChange(); };
  const cur = obj[key];
  switch (kind) {
    case 'area': return h('textarea', { value: cur ?? '', oninput: (e) => set(e.target.value) });
    case 'num': return h('input', { type: 'number', value: cur ?? '', oninput: (e) => set(e.target.value === '' ? '' : Number(e.target.value)) });
    case 'slot': return h('select', { onchange: (e) => set(e.target.value === 'next' ? 'next' : Number(e.target.value)) },
      [['1', 'Slot 1'], ['2', 'Slot 2'], ['3', 'Slot 3'], ['next', 'Next slot']].map(([v, l]) => h('option', { value: v, selected: String(cur) === v }, l)));
    case 'select': return h('select', { onchange: (e) => set(e.target.value) }, extra.map((o) => h('option', { value: o, selected: o === cur }, o)));
    case 'json': {
      const err = h('div', { class: 'err' });
      return h('div', {}, h('textarea', {
        value: cur ? JSON.stringify(cur, null, 1) : '',
        oninput: (e) => {
          const t = e.target.value.trim();
          if (!t) { err.textContent = ''; return set(''); }
          try { const v = JSON.parse(t); err.textContent = ''; set(v); } catch { err.textContent = 'Invalid JSON'; }
        },
      }), err);
    }
    case 'combo': {
      const input = h('input', { type: 'text', value: cur ?? '', placeholder: 'cmd+shift+4', oninput: (e) => set(e.target.value) });
      const rec = h('button', { type: 'button', class: 'small' }, 'Record');
      rec.addEventListener('click', () => {
        rec.textContent = 'Press keys…';
        const onKey = (e) => {
          e.preventDefault();
          const k = comboFromEvent(e);
          if (!k) return; // only modifiers so far
          window.removeEventListener('keydown', onKey, true);
          rec.textContent = 'Record';
          input.value = k;
          set(k);
        };
        window.addEventListener('keydown', onKey, true);
      });
      return h('div', { class: 'inline' }, input, rec);
    }
    default: return h('input', { type: 'text', value: cur ?? '', oninput: (e) => set(e.target.value) });
  }
}

const CODE_KEYS = { Space: 'space', Enter: 'return', Escape: 'escape', Tab: 'tab', Backspace: 'delete', Delete: 'forwarddelete',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Backquote: '`' };
function comboFromEvent(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code.toLowerCase();
  else key = CODE_KEYS[e.code] || null;
  if (!key) return null;
  const mods = [];
  if (e.metaKey) mods.push('cmd');
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  return [...mods, key].join('+');
}

/**
 * Renders an editor for one action. `holder[key]` is the action object; replaced when the type changes.
 * `mode`: 'top' (all but delay), 'step' (inside multi: no device-only types), 'sub' (toggle on/off).
 */
function actionEditor(holder, key, onChange, mode) {
  const wrap = h('div', {});
  const draw = () => {
    wrap.replaceChildren();
    const a = holder[key];
    const allowed = Object.entries(TYPES).filter(([, t]) => {
      if (mode === 'top') return !t.stepOnly;
      return !t.noNest && (mode !== 'sub' || !t.stepOnly);
    });
    if (!allowed.some(([k]) => k === a.type)) allowed.push([a.type, { label: a.type }]);
    wrap.append(row('Action', h('select', {
      onchange: (e) => { holder[key] = TYPES[e.target.value].def(); onChange(); draw(); },
    }, allowed.map(([k, t]) => h('option', { value: k, selected: k === a.type }, t.label)))));
    for (const [fk, label, kind, extra] of FIELDS[a.type] || []) {
      if (a.type === 'mouse') {
        const scroll = a.op === 'scroll', pos = ['click', 'double', 'right', 'move'].includes(a.op);
        if ((fk === 'dx' || fk === 'dy') && !scroll) continue;
        if ((fk === 'x' || fk === 'y') && !pos) continue;
      }
      wrap.append(row(label, fieldInput(a, fk, kind, extra, () => { onChange(); if (a.type === 'mouse' && fk === 'op') draw(); })));
    }
    if (a.type === 'toggle') {
      wrap.append(row('On colour', colorInput(a, 'onColor', '00ff00', onChange)));
      wrap.append(h('div', { class: 'box' }, h('b', {}, 'When turned ON'), actionEditor(a, 'on', onChange, 'sub')));
      wrap.append(h('div', { class: 'box' }, h('b', {}, 'When turned OFF'), actionEditor(a, 'off', onChange, 'sub')));
    }
    if (a.type === 'multi') wrap.append(stepsEditor(a, onChange));
  };
  draw();
  return wrap;
}

function stepsEditor(a, onChange) {
  const box = h('div', {});
  const draw = () => {
    box.replaceChildren();
    a.steps.forEach((_, i) => {
      const head = h('div', { class: 'step-head' },
        h('b', {}, `${i + 1}.`),
        h('button', { class: 'small', title: 'Move up', disabled: i === 0, onclick: () => { swap(a.steps, i, i - 1); onChange(); draw(); } }, '↑'),
        h('button', { class: 'small', title: 'Move down', disabled: i === a.steps.length - 1, onclick: () => { swap(a.steps, i, i + 1); onChange(); draw(); } }, '↓'),
        h('button', { class: 'small danger', title: 'Remove', onclick: () => { a.steps.splice(i, 1); onChange(); draw(); } }, '✕'));
      box.append(h('div', { class: 'step' }, head, actionEditor(a.steps, i, onChange, 'step')));
    });
    box.append(h('button', { class: 'small', onclick: () => { a.steps.push(TYPES.app.def()); onChange(); draw(); } }, '+ Add step'));
  };
  draw();
  return h('div', { class: 'box' }, h('b', {}, 'Steps'), box);
}
function swap(arr, i, j) { [arr[i], arr[j]] = [arr[j], arr[i]]; }

function colorInput(obj, key, fallbackHex, onChange, clearable = true) {
  const input = h('input', { type: 'color', value: hexIn(obj[key], '#' + fallbackHex), oninput: (e) => { obj[key] = e.target.value.slice(1); onChange(); } });
  if (!clearable) return input;
  return h('div', { class: 'inline' }, input, h('button', { class: 'small', type: 'button', onclick: () => { delete obj[key]; onChange(); redrawPanel(); } }, 'Default'));
}

// ---------- grid ----------
function cellStyle(b) {
  const t = state.cfg.theme;
  return { background: hexIn(b?.btnColor, '#' + t.btn_color), color: hexIn(b?.labelColor, '#' + t.text_color) };
}

function drawGrid() {
  const { cols, rows } = state.cfg.grid;
  const grid = $('grid');
  grid.replaceChildren();
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.parentElement.style.background = hexIn(state.cfg.theme.bg_color, '#000');
  const btns = pageButtons();
  for (let i = 0; i < cols * rows; i++) {
    const b = btns[i];
    const cell = h('div', { class: 'cell' + (b ? '' : ' empty') + (state.sel === i ? ' selected' : ''), draggable: !!b });
    if (b) {
      Object.assign(cell.style, cellStyle(b));
      if (b.icon) cell.append(h('img', { src: '/icons/' + encodeURIComponent(b.icon), alt: '' }));
      cell.append(h('span', { class: 'atype' }, b.action?.type || 'none'));
      if (b.widget) cell.append(h('span', { class: 'badge' }, '● ' + b.widget.source));
      cell.append(h('span', { class: 'lbl' }, b.label || ''));
    } else cell.textContent = '+';
    cell.addEventListener('click', () => {
      if (!btns[i]) { btns[i] = { label: 'New', action: { type: 'none' } }; markDirty(); }
      state.sel = i; drawGrid(); redrawPanel();
    });
    cell.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'btn:' + i); });
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('dragover'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('dragover'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      const d = e.dataTransfer.getData('text/plain');
      if (!d.startsWith('btn:')) return;
      const from = Number(d.slice(4));
      if (from === i) return;
      swap(btns, from, i);
      if (state.sel === from) state.sel = i; else if (state.sel === i) state.sel = from;
      markDirty(); drawGrid(); redrawPanel();
    });
    grid.append(cell);
  }
}

// ---------- page tabs ----------
function drawTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  state.cfg.pages.forEach((p, i) => {
    const t = h('div', { class: 'tab' + (i === state.page ? ' active' : ''), draggable: true }, `${i + 1}. ${p.name}`);
    t.addEventListener('click', () => { state.page = i; state.sel = null; refreshEditor(); });
    t.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'page:' + i));
    t.addEventListener('dragover', (e) => { e.preventDefault(); t.classList.add('dragover'); });
    t.addEventListener('dragleave', () => t.classList.remove('dragover'));
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      const d = e.dataTransfer.getData('text/plain');
      if (!d.startsWith('page:')) return;
      const from = Number(d.slice(5));
      const [moved] = state.cfg.pages.splice(from, 1);
      state.cfg.pages.splice(i, 0, moved);
      state.page = i; state.sel = null;
      markDirty(); refreshEditor();
      toast('Pages reordered — check any "Go to page" buttons');
    });
    tabs.append(t);
  });
  tabs.append(
    h('button', { class: 'small', onclick: () => {
      state.cfg.pages.push({ name: `Page ${state.cfg.pages.length + 1}`, buttons: [] });
      state.page = state.cfg.pages.length - 1; state.sel = null; markDirty(); refreshEditor();
    } }, '+ Page'),
    h('button', { class: 'small', onclick: () => {
      const n = prompt('Page name', state.cfg.pages[state.page].name);
      if (n && n.trim()) { state.cfg.pages[state.page].name = n.trim(); markDirty(); drawTabs(); }
    } }, 'Rename'),
    h('button', { class: 'small danger', disabled: state.cfg.pages.length < 2, onclick: () => {
      if (!confirm(`Delete page "${state.cfg.pages[state.page].name}"?`)) return;
      state.cfg.pages.splice(state.page, 1);
      state.page = Math.max(0, state.page - 1); state.sel = null; markDirty(); refreshEditor();
    } }, 'Delete'));
}

// ---------- button editor panel ----------
function redrawPanel() {
  const panel = $('panel');
  panel.replaceChildren();
  const btns = pageButtons();
  const b = state.sel !== null ? btns[state.sel] : null;
  if (!b) { panel.append(h('p', { class: 'none' }, 'Select a button to edit it.')); return; }
  const changed = () => { markDirty(); drawGrid(); };
  const t = state.cfg.theme;

  panel.append(h('h3', {}, `Button ${state.sel + 1}`));
  panel.append(row('Label', h('input', { type: 'text', value: b.label ?? '', oninput: (e) => { b.label = e.target.value; changed(); } })));
  panel.append(row('Label size', h('input', { type: 'number', min: 8, max: 40, value: b.labelSize ?? '', placeholder: '18',
    oninput: (e) => { if (e.target.value === '') delete b.labelSize; else b.labelSize = Number(e.target.value); changed(); } })));
  panel.append(row('Label colour', colorInput(b, 'labelColor', t.text_color, changed)));
  panel.append(row('Button colour', colorInput(b, 'btnColor', t.btn_color, changed)));

  panel.append(h('h4', {}, 'Icon'), iconPicker(b, changed));
  panel.append(h('h4', {}, 'Action'), actionEditor(b, 'action', changed, 'top'));
  panel.append(h('div', { class: 'inline' },
    h('button', { onclick: async () => {
      try { await api('POST', '/api/test', { action: b.action }); toast('Action ran'); } catch (e) { toast(e.message, true); }
    } }, 'Test action'),
    h('button', { class: 'danger', onclick: () => { btns[state.sel] = null; state.sel = null; markDirty(); drawGrid(); redrawPanel(); } }, 'Clear button')));

  const holdBox = h('div', {});
  const drawHold = () => {
    holdBox.replaceChildren(h('h4', {}, 'Long-press action'),
      row('Enabled', h('input', { type: 'checkbox', checked: !!b.hold, onchange: (e) => { if (e.target.checked) b.hold = { type: 'none' }; else delete b.hold; markDirty(); drawHold(); } })));
    if (b.hold) holdBox.append(h('div', { class: 'box' }, actionEditor(b, 'hold', markDirty, 'step'),
      h('div', { class: 'muted' }, 'Needs the updated firmware: holding sends BTN_HOLD instead of a normal press.')));
  };
  drawHold();
  panel.append(holdBox);

  const haBox = h('div', {});
  const drawHa = () => {
    haBox.replaceChildren(h('h4', {}, 'Home Assistant state'),
      row('Show state', h('input', { type: 'checkbox', checked: !!b.haState, onchange: (e) => { if (e.target.checked) b.haState = { entity: b.action?.type === 'ha' && b.action.entity ? b.action.entity : '' }; else delete b.haState; markDirty(); drawHa(); } })));
    if (b.haState) {
      const hs = b.haState;
      const t2 = (k, ph) => h('input', { type: 'text', placeholder: ph || '', value: hs[k] ?? '', oninput: (e) => { if (e.target.value === '') delete hs[k]; else hs[k] = e.target.value; markDirty(); } });
      haBox.append(row('Entity', t2('entity', 'light.desk')), row('ON colour', colorInput(hs, 'on', '1a8f3c', markDirty)), row('OFF colour', colorInput(hs, 'off', '333333', markDirty)),
        row('ON label', t2('label_on', 'ON')), row('OFF label', t2('label_off', 'OFF')),
        row('Poll every (s)', h('input', { type: 'number', min: 5, placeholder: '10', value: hs.interval ?? '', oninput: (e) => { if (e.target.value === '') delete hs.interval; else hs.interval = Number(e.target.value); markDirty(); } })),
        h('div', { class: 'muted' }, 'The Mac updates the button while connected; the deck polls Home Assistant itself when standalone (needs the updated firmware).'));
    }
  };
  drawHa();
  panel.append(haBox);

  panel.append(h('h4', {}, 'Live widget'), widgetEditor(b, changed));
}

function widgetEditor(b, changed) {
  const box = h('div', {});
  const draw = () => {
    box.replaceChildren();
    const w = b.widget;
    const sources = ['clock', 'cpu', 'memory', 'nowplaying', 'ha_state', 'http_json', 'moonraker'];
    box.append(row('Source', h('select', { onchange: (e) => {
      if (!e.target.value) delete b.widget; else b.widget = { ...(b.widget || {}), source: e.target.value };
      changed(); draw();
    } }, h('option', { value: '' }, 'None'), sources.map((s) => h('option', { value: s, selected: w?.source === s }, s)))));
    if (!w) return;
    box.append(row('Interval (s)', h('input', { type: 'number', min: 10, value: w.interval ?? '', placeholder: '10',
      oninput: (e) => { if (e.target.value === '') delete w.interval; else w.interval = Number(e.target.value); changed(); },
      onchange: (e) => { if (w.interval !== undefined && w.interval < 10) { w.interval = 10; e.target.value = 10; changed(); } } })));
    box.append(h('div', { class: 'muted' }, 'Minimum 10 s — each update rewrites the deck’s SD card.'));
    box.append(row('Format', h('input', { type: 'text', value: w.format ?? '', placeholder: '{value}',
      oninput: (e) => { if (e.target.value) w.format = e.target.value; else delete w.format; changed(); } })));
    if (w.source === 'ha_state') box.append(row('Entity id', fieldInput(w, 'entity', 'text', null, changed)));
    if (w.source === 'http_json' || w.source === 'moonraker') box.append(row('URL', fieldInput(w, 'url', 'text', null, changed)));
    if (w.source === 'http_json') box.append(row('JSON path', fieldInput(w, 'jsonPath', 'text', null, changed)));
    // thresholds
    const th = h('div', { class: 'box' }, h('b', {}, 'Colour thresholds'));
    (w.thresholds || []).forEach((t, i) => {
      th.append(h('div', { class: 'inline' },
        'above', h('input', { type: 'number', value: t.above, oninput: (e) => { t.above = Number(e.target.value); changed(); } }),
        colorInput(t, 'color', 'ff0000', changed, false),
        h('button', { class: 'small danger', onclick: () => { w.thresholds.splice(i, 1); if (!w.thresholds.length) delete w.thresholds; changed(); draw(); } }, '✕')));
    });
    th.append(h('button', { class: 'small', onclick: () => { (w.thresholds ||= []).push({ above: 80, color: 'ff0000' }); changed(); draw(); } }, '+ Threshold'));
    box.append(th);
  };
  draw();
  return box;
}

// ---------- icon picker ----------
function iconPicker(b, changed) {
  const box = h('div', {});
  const grid = h('div', { class: 'icons' });
  const msg = h('div', { class: 'err' });
  const drawIcons = () => {
    grid.replaceChildren(h('div', { class: 'ifyicon', title: 'No icon', onclick: () => { delete b.icon; changed(); drawIcons(); } }, 'none'));
    for (const f of state.icons) {
      grid.append(h('img', { src: '/icons/' + encodeURIComponent(f), title: f, class: b.icon === f ? 'sel' : '', alt: f,
        onclick: () => { b.icon = f; changed(); drawIcons(); } }));
    }
  };
  const bgHex = () => b.btnColor || state.cfg.theme.btn_color;
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const name = file.name.replace(/\.[^.]+$/, '');
      const r = await api('POST', `/api/icons/upload?name=${encodeURIComponent(name)}&bg=${bgHex()}`, undefined, await file.arrayBuffer());
      await loadIcons(); b.icon = r.name; changed(); drawIcons();
    } catch (err) { msg.textContent = err.message; }
    e.target.value = '';
  } });
  const q = h('input', { type: 'text', placeholder: 'Search Iconify (e.g. home, spotify)…' });
  const results = h('div', { class: 'icons' });
  const search = async () => {
    msg.textContent = '';
    try {
      const ids = await api('GET', '/api/iconify/search?q=' + encodeURIComponent(q.value));
      results.replaceChildren(...ids.map((id) => h('div', { class: 'ifyicon', title: id, onclick: async () => {
        try {
          const color = hexIn(b.labelColor, '#' + state.cfg.theme.text_color).slice(1);
          const r = await api('POST', '/api/icons/iconify', { id, color, bg: bgHex() });
          await loadIcons(); b.icon = r.name; changed(); drawIcons(); results.replaceChildren();
        } catch (err) { msg.textContent = err.message; }
      } }, id.split(':')[1])));
      if (!ids.length) msg.textContent = 'No results';
    } catch (err) { msg.textContent = err.message; }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  drawIcons();
  box.append(grid,
    h('div', { class: 'inline' }, h('button', { class: 'small', onclick: () => fileIn.click() }, 'Upload image…'), fileIn,
      h('button', { class: 'small danger', onclick: async () => {
        if (!b.icon || !confirm(`Delete icon file ${b.icon}?`)) return;
        try { await api('DELETE', '/api/icons/' + encodeURIComponent(b.icon)); delete b.icon; await loadIcons(); changed(); drawIcons(); }
        catch (err) { msg.textContent = err.message; }
      } }, 'Delete selected file')),
    h('div', { class: 'inline' }, q, h('button', { class: 'small', onclick: search }, 'Search')),
    results, msg);
  return box;
}
async function loadIcons() { state.icons = await api('GET', '/api/icons'); }

// ---------- settings ----------
function drawSettings() {
  const v = $('settingsView');
  v.replaceChildren();
  const c = state.cfg;
  const chg = () => markDirty();
  const num = (obj, key, extra = {}) => h('input', { type: 'number', ...extra, value: obj[key] ?? '',
    oninput: (e) => { if (e.target.value === '') delete obj[key]; else obj[key] = Number(e.target.value); chg(); } });
  const txt = (obj, key, extra = {}) => h('input', { type: 'text', ...extra, value: obj[key] ?? '',
    oninput: (e) => { if (e.target.value === '') delete obj[key]; else obj[key] = e.target.value; chg(); } });
  c.power ||= {}; c.knob.led ||= { r: 217, g: 70, b: 239, tail: 7 };

  const general = h('div', {}, h('h3', {}, 'Deck'),
    row('Title', txt(c, 'title')),
    row('Columns', h('input', { type: 'number', min: 1, max: MAX_COLS, value: c.grid.cols, oninput: (e) => { c.grid.cols = clampInt(e.target.value, 1, MAX_COLS); chg(); } })),
    row('Rows', h('input', { type: 'number', min: 1, max: MAX_ROWS, value: c.grid.rows, oninput: (e) => { c.grid.rows = clampInt(e.target.value, 1, MAX_ROWS); chg(); } })),
    row('Brightness %', num(c, 'brightness', { min: 0, max: 100 })),
    h('h3', {}, 'Theme'),
    ...[['bg_color', 'Background'], ['btn_color', 'Buttons'], ['text_color', 'Text'], ['stroke_color', 'Border'], ['shadow_color', 'Shadow']]
      .map(([k, l]) => row(l, colorInput(c.theme, k, '000000', chg, false))));

  const knobBox = h('div', {}, h('h3', {}, 'Knob'),
    row('Step (raw units)', num(c.knob, 'step', { min: 1 })),
    row('Invert', h('input', { type: 'checkbox', checked: !!c.knob.invert, onchange: (e) => { c.knob.invert = e.target.checked; chg(); } })),
    h('div', { class: 'box' }, h('b', {}, 'Clockwise'), actionEditor(c.knob, 'cw', chg, 'step')),
    h('div', { class: 'box' }, h('b', {}, 'Counter-clockwise'), actionEditor(c.knob, 'ccw', chg, 'step')),
    row('LED red', num(c.knob.led, 'r', { min: 0, max: 255 })), row('LED green', num(c.knob.led, 'g', { min: 0, max: 255 })),
    row('LED blue', num(c.knob.led, 'b', { min: 0, max: 255 })), row('Tail length', num(c.knob.led, 'tail', { min: 1, max: 15 })));

  const power = h('div', {}, h('h3', {}, 'Power & LEDs'),
    row('Sleep after (min)', num(c.power, 'sleepMinutes', { min: 0 })),
    row('Deep sleep (min)', num(c.power, 'deepSleepMinutes', { min: 0 })),
    row('Dim LED animation', h('select', { onchange: (e) => { if (e.target.value === 'off') delete c.power.dimLed; else c.power.dimLed = e.target.value; chg(); } },
      ['off', 'breathing', 'rainbow', 'pulse', 'comet', 'sparkle'].map((a) => h('option', { value: a, selected: (c.power.dimLed || 'off') === a }, a)))),
    row('LED brightness', num(c.power, 'ledBrightness', { min: 0, max: 255 })));

  c.sounds ||= {};
  const soundOpts = ['none', 'chirp', 'confirm', 'error', 'blip'];
  const soundRow = (label, key) => row(label, h('div', {},
    h('input', { type: 'text', list: 'builtinSounds', placeholder: 'none', value: c.sounds[key] ?? '',
      oninput: (e) => { if (e.target.value === '') delete c.sounds[key]; else c.sounds[key] = e.target.value; chg(); } })));
  const soundsBox = h('div', {}, h('h3', {}, 'Sounds (on this Mac)'),
    h('datalist', { id: 'builtinSounds' }, soundOpts.map((o) => h('option', { value: o }))),
    soundRow('On button press', 'press'), soundRow('On action error', 'error'),
    row('Volume %', num(c.sounds, 'volume', { min: 0, max: 100, placeholder: '60' })),
    h('div', { class: 'muted' }, 'Built-in: chirp, confirm, error, blip — or an absolute path to a .wav/.aiff/.mp3 file.'));

  const sleepBox = h('div', {}, h('h3', {}, 'Sleep screen'),
    row('Show', h('select', { onchange: (e) => { if (e.target.value === 'clock') delete c.sleepScreen; else c.sleepScreen = e.target.value; chg(); } },
      [['clock', 'Clock + weather'], ['diag', 'Starship diagnostics'], ['diag-anim', 'Diagnostics (animated)'], ['warp', 'Warp speed + clock']].map(([v, l]) => h('option', { value: v, selected: (c.sleepScreen || 'clock') === v }, l)))),
    h('div', { class: 'muted' }, 'Diagnostics and animated screens need the updated firmware (firmware/ folder).'));

  c.weather ||= null;
  const wBox = h('div', {}, h('h3', {}, 'Weather (sleep screen)'));
  const drawWeather = () => {
    wBox.replaceChildren(h('h3', {}, 'Weather (sleep screen)'),
      row('Enabled', h('input', { type: 'checkbox', checked: !!c.weather, onchange: (e) => { c.weather = e.target.checked ? { lat: 51.5, lon: -0.12, celsius: true } : null; if (!c.weather) delete c.weather; chg(); drawWeather(); } })));
    if (c.weather) wBox.append(row('Latitude', num(c.weather, 'lat', { step: 'any' })), row('Longitude', num(c.weather, 'lon', { step: 'any' })),
      row('City label', txt(c.weather, 'city')), row('Celsius', h('input', { type: 'checkbox', checked: c.weather.celsius !== false, onchange: (e) => { c.weather.celsius = e.target.checked; chg(); } })));
  };
  drawWeather();

  c.appPages ||= [];
  const rules = h('div', {});
  const drawRules = () => {
    rules.replaceChildren(h('h3', {}, 'App → page rules'), h('div', { class: 'muted' }, 'Switch the deck to a page when this app is frontmost.'));
    c.appPages.forEach((r, i) => rules.append(h('div', { class: 'inline' },
      h('input', { type: 'text', value: r.app, placeholder: 'App name', oninput: (e) => { r.app = e.target.value; chg(); } }),
      h('select', { onchange: (e) => { r.page = Number(e.target.value); chg(); } }, c.pages.map((p, pi) => h('option', { value: pi, selected: pi === r.page }, `${pi + 1}. ${p.name}`))),
      h('button', { class: 'small danger', onclick: () => { c.appPages.splice(i, 1); chg(); drawRules(); } }, '✕'))));
    rules.append(h('button', { class: 'small', onclick: () => { c.appPages.push({ app: '', page: 0 }); chg(); drawRules(); } }, '+ Rule'));
  };
  drawRules();

  c.integrations ||= {};
  const ha = (c.integrations.homeassistant ||= { url: '' });
  const haBox = h('div', {}, h('h3', {}, 'Home Assistant'),
    row('URL', txt(ha, 'url', { placeholder: 'http://homeassistant.local:8123' })),
    row('Access token', h('input', { type: 'password', value: ha.token ?? '', autocomplete: 'off', oninput: (e) => { if (e.target.value) ha.token = e.target.value; else delete ha.token; chg(); } })),
    row('…or env var', txt(ha, 'tokenEnv', { placeholder: 'HA_TOKEN' })),
    h('div', { class: 'muted' }, 'A saved token is shown as ***. Leave it to keep the existing token.'));

  // ---- connectivity / deck-side features ----
  const d = (c.device ||= {});
  const sub = (key, init) => (d[key] ||= init);
  const secret = (obj, key, ph) => h('input', { type: 'password', autocomplete: 'off', placeholder: ph || '', value: obj[key] ?? '',
    oninput: (e) => { if (e.target.value) obj[key] = e.target.value; else delete obj[key]; chg(); } });
  const tokenInput = h('input', { type: 'password', autocomplete: 'off', value: d.token ?? '', placeholder: '8-64 characters',
    oninput: (e) => { if (e.target.value) d.token = e.target.value; else delete d.token; chg(); } });
  const genToken = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); d.token = [...a].map((x) => x.toString(16).padStart(2, '0')).join(''); tokenInput.value = d.token; tokenInput.type = 'text'; chg(); };
  const connBox = h('div', {}, h('h3', {}, 'Deck connectivity (WiFi / Bluetooth)'),
    h('div', { class: 'muted' }, 'Needs the updated firmware. WiFi password and tokens are only ever sent over USB, never over the network.'),
    h('h4', {}, 'WiFi'),
    row('Network (SSID)', h('input', { type: 'text', value: d.wifi?.ssid ?? '', oninput: (e) => { sub('wifi', { ssid: '' }).ssid = e.target.value; chg(); } })),
    row('Password', h('input', { type: 'password', autocomplete: 'off', value: d.wifi?.password ?? '', oninput: (e) => { const w = sub('wifi', { ssid: '' }); if (e.target.value) w.password = e.target.value; else delete w.password; chg(); } })),
    row('Deck address', txt(d, 'address', { placeholder: 'smartdeck.local or 192.168.1.50' })),
    row('Deck hostname', txt(d, 'host', { placeholder: 'smartdeck' })),
    row('Link / OTA token', h('div', { class: 'inline' }, tokenInput, h('button', { class: 'small', onclick: genToken }, 'Generate'))),
    row('Time zone (POSIX)', txt(d, 'tz', { placeholder: 'GMT0BST,M3.5.0/1,M10.5.0/2' })),
    h('h4', {}, 'Standalone (no Mac needed)'),
    row('Run on the deck', h('select', { onchange: (e) => { if (e.target.value === 'auto') delete d.standalone; else d.standalone = e.target.value; chg(); } },
      [['auto', 'Only when no Mac is connected'], ['always', 'Always'], ['never', 'Never']].map(([v2, l]) => h('option', { value: v2, selected: (d.standalone || 'auto') === v2 }, l)))),
    row('Bluetooth keyboard', h('input', { type: 'checkbox', checked: !!d.ble?.enabled, onchange: (e) => { sub('ble', { enabled: false }).enabled = e.target.checked; chg(); } })),
    row('BT host names', h('div', { class: 'inline' }, [0, 1, 2].map((i) => h('input', { type: 'text', maxlength: 12, placeholder: ['Mac', 'PC', 'iPad'][i], value: d.ble?.slots?.[i] ?? '',
      oninput: (e) => { const b = sub('ble', { enabled: false }); const arr = [...(b.slots || ['', '', ''])]; arr[i] = e.target.value; while (arr.length && !arr[arr.length - 1]) arr.pop(); if (arr.length) b.slots = arr.map((x, j) => x || ['Mac', 'PC', 'iPad'][j]); else delete b.slots; chg(); } })))),
    row('Bluetooth name', h('input', { type: 'text', placeholder: 'SmartDeck', value: d.ble?.name ?? '', oninput: (e) => { const b = sub('ble', { enabled: false }); if (e.target.value) b.name = e.target.value; else delete b.name; chg(); } })),
    row('Home Assistant URL', h('input', { type: 'text', placeholder: 'http://homeassistant.local:8123', value: d.ha?.url ?? '', oninput: (e) => { sub('ha', { url: '' }).url = e.target.value; chg(); } })),
    row('HA token (deck)', h('input', { type: 'password', autocomplete: 'off', value: d.ha?.token ?? '', oninput: (e) => { const x = sub('ha', { url: '' }); if (e.target.value) x.token = e.target.value; else delete x.token; chg(); } })),
    h('div', { class: 'inline' }, h('button', { onclick: async () => { try { await api('POST', '/api/provision', {}); toast('Sent to deck'); } catch (e) { toast(e.message, true); } } }, 'Push to deck (USB)')));

  const ad = () => (d.autodim ||= { enabled: false, min: 10, max: 100 });
  const gest = () => (d.gestures ||= { swipe: true, holdMs: 600 });
  const deckBox = h('div', {}, h('h3', {}, 'Gestures'),
    row('Swipe to change page', h('input', { type: 'checkbox', checked: d.gestures?.swipe !== false, onchange: (e) => { gest().swipe = e.target.checked; chg(); } })),
    row('Hold time (ms)', h('input', { type: 'number', min: 200, max: 3000, placeholder: '600', value: d.gestures?.holdMs ?? '', oninput: (e) => { if (e.target.value === '') delete gest().holdMs; else gest().holdMs = Number(e.target.value); chg(); } })),
    h('h3', {}, 'Auto-dim (light sensor)'),
    h('div', { class: 'muted' }, 'Needs a BH1750 light sensor on the deck.'),
    row('Enabled', h('input', { type: 'checkbox', checked: !!d.autodim?.enabled, onchange: (e) => { ad().enabled = e.target.checked; chg(); } })),
    row('Dimmest %', h('input', { type: 'number', min: 0, max: 100, value: d.autodim?.min ?? '', placeholder: '10', oninput: (e) => { ad().min = Number(e.target.value || 10); chg(); } })),
    row('Brightest %', h('input', { type: 'number', min: 0, max: 100, value: d.autodim?.max ?? '', placeholder: '100', oninput: (e) => { ad().max = Number(e.target.value || 100); chg(); } })));

  c.brightnessSchedule ||= [];
  const schedBox = h('div', {});
  const drawSched = () => {
    schedBox.replaceChildren(h('h3', {}, 'Brightness schedule'), h('div', { class: 'muted' }, 'Day/night dimming from the Mac. Windows may cross midnight.'));
    c.brightnessSchedule.forEach((r, i) => schedBox.append(h('div', { class: 'inline' },
      h('input', { type: 'time', value: r.from, oninput: (e) => { r.from = e.target.value; chg(); } }),
      h('input', { type: 'time', value: r.to, oninput: (e) => { r.to = e.target.value; chg(); } }),
      h('input', { type: 'number', min: 0, max: 100, value: r.brightness, title: 'brightness %', oninput: (e) => { r.brightness = Number(e.target.value); chg(); } }),
      h('button', { class: 'small danger', onclick: () => { c.brightnessSchedule.splice(i, 1); chg(); drawSched(); } }, '✕'))));
    schedBox.append(h('button', { class: 'small', onclick: () => { c.brightnessSchedule.push({ from: '22:00', to: '07:00', brightness: 15 }); chg(); drawSched(); } }, '+ Window'));
  };
  drawSched();

  const alertBox = h('div', {}, h('h3', {}, 'Alerts (LED ring)'),
    h('div', { class: 'muted' }, 'Test the ring. Also available as a button action, `smartdeck-mac alert red 30 "text"`, or POST /api/alert.'),
    h('div', { class: 'inline' }, ['red', 'yellow', 'blue', 'green', 'off'].map((k) => h('button', { class: 'small' + (k === 'red' ? ' danger' : ''),
      onclick: async () => { try { await api('POST', '/api/alert', { kind: k, seconds: k === 'off' ? 0 : 10, text: k === 'red' ? 'Red alert' : '' }); } catch (e) { toast(e.message, true); } } }, k))));

  v.append(h('div', { class: 'inline' }, h('h2', {}, 'Settings'), h('div', { class: 'spacer' }), h('button', { onclick: () => setView('editor') }, '← Back to buttons')),
    h('div', { class: 'grid2' }, h('div', {}, general, power, sleepBox, schedBox, soundsBox), h('div', {}, knobBox, connBox, deckBox, alertBox, wBox, rules, haBox)));
}
function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(Number(v)) || lo)); }

// ---------- view / status ----------
function setView(v) {
  state.view = v;
  $('editorView').hidden = v !== 'editor';
  $('settingsView').hidden = v !== 'settings';
  if (v === 'settings') drawSettings(); else refreshEditor();
}
function refreshEditor() { if (state.sel !== null && state.sel >= cells()) state.sel = null; drawTabs(); drawGrid(); redrawPanel(); markDirty(); }

async function pollStatus() {
  try {
    const s = await api('GET', '/api/status');
    state.status = s;
    $('conn').className = 'conn ' + (s.connected ? 'on' : 'off');
    const n = s.net || {};
    const extra = [s.link === 'wifi' ? 'WiFi' : s.link === 'usb' ? 'USB' : '', n.ble && n.ble !== 'off' ? 'BT ' + n.ble : '', s.lux !== undefined ? s.lux + ' lux' : ''].filter(Boolean).join(' · ');
    $('connText').textContent = s.connected ? `${s.deviceName || 'Deck'}${extra ? ' · ' + extra : ''} · page ${s.page + 1}` : 'Deck not connected';
    $('logText').textContent = (s.log || []).join('\n');
  } catch {
    $('conn').className = 'conn off';
    $('connText').textContent = 'Daemon unreachable';
  }
}

async function save() {
  try {
    const next = await api('PUT', '/api/config', trimConfig(state.cfg));
    state.cfg = next; state.savedJson = JSON.stringify(trimConfig(next));
    toast('Saved');
    state.view === 'settings' ? drawSettings() : refreshEditor();
  } catch (e) { toast(e.message, true); }
}

async function init() {
  $('saveBtn').addEventListener('click', save);
  $('syncBtn').addEventListener('click', async () => {
    if (isDirty() && !confirm('You have unsaved changes. Sync uses the saved config. Save first?')) return;
    if (isDirty()) await save();
    $('syncBtn').disabled = true; $('syncBtn').textContent = 'Syncing…';
    try { await api('POST', '/api/sync'); toast('Synced — the deck is rebooting'); } catch (e) { toast(e.message, true); }
    $('syncBtn').disabled = false; $('syncBtn').textContent = 'Sync to deck';
  });
  $('settingsBtn').addEventListener('click', () => setView(state.view === 'settings' ? 'editor' : 'settings'));
  $('logBtn').addEventListener('click', () => { $('logDrawer').hidden = !$('logDrawer').hidden; });
  try {
    state.cfg = await api('GET', '/api/config');
    await loadIcons();
  } catch (e) { toast('Could not load config: ' + e.message, true); return; }
  // Normalise optional sections so the unmodified config is not "dirty" after the editor adds defaults.
  state.savedJson = JSON.stringify(trimConfig(state.cfg));
  setView('editor');
  markDirty();
  pollStatus();
  setInterval(pollStatus, 2000);
}
init();

// LCARS flavour: a decorative "stardate" in the footer (year.day-of-year fraction).
(function () {
  const el = document.getElementById('stardate');
  if (!el) return;
  const tick = () => {
    const n = new Date();
    const day = Math.floor((n - new Date(n.getFullYear(), 0, 0)) / 864e5);
    el.textContent = 'STARDATE ' + n.getFullYear() + '.' + String(day).padStart(3, '0') + ' · ' + n.toTimeString().slice(0, 5);
  };
  tick();
  setInterval(tick, 30000);
})();
