'use strict';
// Virtual deck screen. Layout math mirrors draw_page() in smart_deck.ino; sleep screens are approximations.

const W = 800, H = 480, CELL = 110, RADIUS = 20, SHADOW = 5;
const O = '#ff9900', P = '#ff9966', T = '#ffcc99', L = '#cc99cc', V = '#9999cc', B = '#99ccff', S = '#cc6666', G = '#ffcc66', R = '#ff4040';
const $ = (id) => document.getElementById(id);
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const screen = $('screen'), ctx = screen.getContext('2d');
const knobCv = $('knob'), kctx = knobCv.getContext('2d');

let snap = null;
let online = false;
let pressed = -1;
let lastRebooting = false;

// ---------------------------------------------------------------- network
function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SmartDeck-Token': csrf }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => null);
}
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    snap = await r.json();
    online = true;
    if (lastRebooting && !snap.rebooting) imgs.clear();
    lastRebooting = snap.rebooting;
    updatePanel();
  } catch { online = false; }
}

// ---------------------------------------------------------------- drawing helpers
const hex = (c, fb) => (/^[0-9a-f]{6}$/i.test(c || '') ? '#' + c : fb);
function rr(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function fillRR(c, x, y, w, h, r, color) { rr(c, x, y, w, h, r); c.fillStyle = color; c.fill(); }
function rect(c, x, y, w, h, color) { c.fillStyle = color; c.fillRect(x, y, w, h); }
/** Text in the firmware's built-in font: cell is 6x8 px times `size`, top-left anchored. */
function txt(c, x, y, s, size, color) {
  c.font = `${10 * size}px "Menlo","DejaVu Sans Mono",monospace`;
  c.textBaseline = 'top'; c.textAlign = 'left'; c.fillStyle = color;
  c.fillText(s, x, y - size);
}
const txtW = (s, size) => s.length * 6 * size;
const pad2 = (n) => String(n).padStart(2, '0');

const imgs = new Map();
function icon(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.jpe?g$/i.test(name.replace(/^\//, ''))) return null;
  name = name.replace(/^\//, '');
  let im = imgs.get(name);
  if (!im) { im = new Image(); im.src = '/icons/' + encodeURIComponent(name); imgs.set(name, im); }
  return im.complete && im.naturalWidth ? im : null;
}

// ---------------------------------------------------------------- main page (draw_page)
function layout(cfg) {
  const cols = (cfg.grid && cfg.grid.cols) || 3, rows = (cfg.grid && cfg.grid.rows) || 3;
  const rem = (H - 90) - rows * CELL;
  const numGaps = rows - 1;
  let gapY = 0, padTop = 0;
  if (rem < 0) { gapY = -2; padTop = 0; }
  else if (numGaps > 0) { padTop = 2; gapY = Math.trunc((rem - 4) / numGaps); }
  else { gapY = 0; padTop = Math.trunc(rem / 2); }
  padTop += 50;
  const gapX = cols > 1 ? Math.trunc((W - cols * CELL) / (cols + 1)) : Math.trunc((W - CELL) / 2);
  const padLeft = Math.max(0, Math.trunc((W - cols * CELL - (cols - 1) * gapX - SHADOW) / 2));
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    cells.push({ i: r * cols + c, x: padLeft + c * CELL + c * gapX, y: padTop + r * CELL + r * gapY, w: CELL, h: CELL });
  return cells;
}

function fmtTimer(sec) { return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`; }

function drawButton(c, s, cell, b0, isPressed) {
  const th = s.config.theme || {};
  // SET_BTN_LIVE / on-deck Home Assistant state: RAM-only overrides of how the button is drawn
  const live = s.live && s.live[`${s.page}:${cell.i}`];
  const b = live ? { ...b0, ...live } : b0;
  const btnCol = hex(b.btnColor, hex(th.btn_color, '#333333'));
  const stroke = isPressed ? '#ffffff' : hex(th.stroke_color, '#555555');
  const key = `${s.page}:${cell.i}`;
  const toggleOn = b.type === 'toggle' && (s.toggles[key] ?? true);
  const fill = toggleOn ? hex(b.toggleData && b.toggleData.onColor, '#00ff00') : btnCol;

  fillRR(c, cell.x + SHADOW, cell.y + SHADOW, cell.w, cell.h, RADIUS, hex(th.shadow_color, '#000000'));
  fillRR(c, cell.x, cell.y, cell.w, cell.h, RADIUS, fill);

  let iconName = b.icon;
  if (b.type === 'toggle' && b.toggleData) iconName = (toggleOn ? b.toggleData.iconOn : b.toggleData.iconOff) || iconName;
  const im = icon(iconName);
  if (im) {
    c.save(); rr(c, cell.x, cell.y, cell.w, cell.h, RADIUS); c.clip();
    c.drawImage(im, cell.x, cell.y, cell.w, cell.h); c.restore();
  }
  c.lineWidth = 2; c.strokeStyle = stroke;
  rr(c, cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2, RADIUS); c.stroke();

  // label / counter / timer text
  let label = b.label || '';
  let big = false;
  if (b.type === 'counter') { label = String(s.counters[key] ?? b.counterStartValue ?? 0); big = true; }
  if (b.type === 'timer') {
    const t = s.timers[key];
    const left = t ? Math.max(0, t.duration - Math.floor((s.now - t.startedAt) / 1000)) : Number(b.duration || 0);
    label = fmtTimer(left); big = true;
  }
  // Faithful to the real firmware: normal buttons draw NO label text when they have an icon (the Windows app bakes labels
  // into the icon). Text appears for timers/counters, live labels, icon-less buttons, and buttons that set showLabel.
  const isTC = b.type === 'counter' || b.type === 'timer';
  const hasLiveLabel = !!(live && live.label !== undefined);
  if (!isTC && im && !hasLiveLabel && !b0.showLabel) label = '';
  if (label) {
    const px = big ? 30 : Math.max(8, Math.min(40, Number(b.labelSize) || 18));
    c.font = `bold ${px}px "Helvetica Neue",Arial,sans-serif`;
    c.textAlign = 'center'; c.textBaseline = im ? 'alphabetic' : 'middle';
    c.fillStyle = hex(b.labelColor, hex(th.text_color, '#ffffff'));
    const cy = im ? cell.y + cell.h - 10 : cell.y + cell.h / 2;  // icon: label along the bottom; no icon: centred
    c.save(); rr(c, cell.x, cell.y, cell.w, cell.h, RADIUS); c.clip();
    c.fillText(label, cell.x + cell.w / 2, cy, cell.w - 10); c.restore();
  }
}

function drawMain(c, s) {
  const th = s.config.theme || {};
  rect(c, 0, 0, W, H, hex(th.bg_color, '#000000'));
  const text = hex(th.text_color, '#ffffff');
  txt(c, (W - txtW(s.config.title || 'Stream Deck', 2)) / 2, 10, s.config.title || 'Stream Deck', 2, text);
  const page = s.config.pages[s.page];
  const cells = layout(s.config);
  if (page) cells.forEach((cell) => { const b = page.buttons[cell.i]; if (b) drawButton(c, s, cell, b, pressed === cell.i); });
  const name = (page && page.name) || 'Page';
  txt(c, (W - txtW(name, 2)) / 2, H - 30, name, 2, text);
  if (s.configError && !(page && page.buttons.some(Boolean))) {
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '20px sans-serif'; c.fillStyle = '#888';
    c.fillText(s.configError, W / 2, H / 2);
  }
}

// ---------------------------------------------------------------- sleep screens
function weatherGlyph(c, x, y, code, isDay) {
  c.save(); c.translate(x, y);
  const cloud = (col) => { c.fillStyle = col; c.beginPath(); c.arc(16, 28, 10, 0, 7); c.arc(28, 24, 12, 0, 7); c.arc(38, 30, 8, 0, 7); c.fill(); c.fillRect(14, 28, 26, 10); };
  if (code <= 1) {
    c.fillStyle = isDay ? '#ffd23f' : '#cfd8ff'; c.beginPath(); c.arc(24, 24, 11, 0, 7); c.fill();
    if (isDay) { c.strokeStyle = '#ffd23f'; c.lineWidth = 3; for (let a = 0; a < 8; a++) { c.beginPath(); c.moveTo(24 + Math.cos(a * .785) * 16, 24 + Math.sin(a * .785) * 16); c.lineTo(24 + Math.cos(a * .785) * 22, 24 + Math.sin(a * .785) * 22); c.stroke(); } }
  } else {
    cloud('#c9cdd6');
    if (code >= 51 && code < 80 || code >= 80) { c.strokeStyle = '#6aa9ff'; c.lineWidth = 3; for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(16 + i * 10, 42); c.lineTo(13 + i * 10, 50); c.stroke(); } }
  }
  c.restore();
}

function drawClock(c, s) {
  rect(c, 0, 0, W, H, '#000');
  const k = s.clockNow, set = s.clock.set;
  const t = set ? `${pad2(k.h)}:${pad2(k.m)}` : '--:--';
  const w = s.weather;
  // firmware: clock is size 20 (6x8 cell * 20 = 120x160 per glyph), top at (480-160)/2-15 = 145; city 20 px above it
  if (w && w.city) txt(c, (W - txtW(w.city, 3)) / 2, 145 - 24 - 20, w.city, 3, '#fff');
  c.font = 'bold 200px "Menlo","DejaVu Sans Mono",monospace'; c.textBaseline = 'alphabetic'; c.textAlign = 'center'; c.fillStyle = '#fff';
  c.fillText(t, W / 2, 145 + 142, 600);
  if (w) {
    const tmp = String(w.temp), tw = txtW(tmp, 6);
    const total = 48 + 10 + tw + 5 + 30, x0 = (W - total) / 2, y = 330;
    weatherGlyph(c, x0, y - 4, w.code, w.isDay);
    txt(c, x0 + 58, y, tmp, 6, '#fff');
    txt(c, x0 + 58 + tw + 5, y + 4, w.celsius ? '°C' : '°F', 3, '#fff');
    const d = w.desc || 'Weather';
    txt(c, (W - txtW(d, 2)) / 2, y + 62, d, 2, '#b0b0b0');
  }
}

const gaugeCol = (p) => (p >= 85 ? R : p >= 60 ? G : O);
const netPct = (kb) => Math.min(100, Math.round((100 * Math.log10(1 + kb)) / 5));

function drawDiag(c, s, t, animated) {
  const d = s.diag, k = s.clockNow;
  rect(c, 0, 0, W, H, '#000');
  const pulse = animated ? 0.75 + 0.25 * Math.sin(t / 400) : 1;
  c.globalAlpha = 1;
  fillRR(c, 0, 0, 180, 110, 55, O); rect(c, 0, 55, 110, 55, O); rect(c, 110, 0, 70, 44, O); rect(c, 110, 44, 70, 66, '#000');
  fillRR(c, 184, 0, 616, 44, 22, O);
  txt(c, 210, 10, 'SMARTDECK  SYSTEM DIAGNOSTICS', 3, '#000');
  [[114, 56, S], [174, 110, V], [288, 56, B], [348, 48, T]].forEach(([y, h, col], i) => {
    c.globalAlpha = animated ? 0.55 + 0.45 * Math.max(0, Math.sin(t / 700 + i * 1.3)) : 1; rect(c, 0, y, 110, h, col);
  });
  c.globalAlpha = 1;
  fillRR(c, 0, 400, 110, 80, 20, L); rect(c, 0, 400, 110, 30, L);
  txt(c, 200, 54, d.host.toUpperCase(), 2, T);
  const rows = [['CORE LOAD', d.cpu, `${d.cpu}%`], ['MEMORY', d.mem, `${d.mem}%`], ['STORAGE', d.disk, `${d.disk}%`],
    ['SUBSPACE LINK', netPct(Math.max(d.rx, d.tx)), `RX ${d.rx}  TX ${d.tx} KB/S`]];
  rows.forEach(([label, p, val], i) => {
    const y0 = 92 + i * 74;
    txt(c, 130, y0, label, 2, T); txt(c, 330, y0, val, 2, '#fff');
    c.strokeStyle = V; c.lineWidth = 1; c.strokeRect(130.5, y0 + 24.5, 659, 29);
    const fw = Math.floor((656 * p) / 100);
    c.globalAlpha = pulse; rect(c, 132, y0 + 26, fw, 26, gaugeCol(p)); c.globalAlpha = 1;
    if (animated && fw > 4) { // scanning highlight sweeping along each gauge
      const sx = 132 + (((t / 2200) + i * 0.23) % 1) * 656;
      c.save(); c.beginPath(); c.rect(132, y0 + 26, fw, 26); c.clip();
      const grad = c.createLinearGradient(sx - 40, 0, sx + 40, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(.5, 'rgba(255,255,255,.45)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = grad; c.fillRect(sx - 40, y0 + 26, 80, 26); c.restore();
    }
  });
  const D = Math.floor(d.uptimeMin / 1440), Hh = Math.floor(d.uptimeMin / 60) % 24, M = d.uptimeMin % 60;
  txt(c, 130, 398, `UPTIME ${D}D ${pad2(Hh)}:${pad2(M)}`, 3, B);
  txt(c, 610, 390, `${k.h}:${pad2(k.m)}`, 6, O);
  fillRR(c, 130, 466, 660, 10, 5, V);
  if (animated) { // sweeping scan line + travelling marker on the bottom bar
    const sy = 70 + (((t / 3000) % 1) * 300);
    c.fillStyle = 'rgba(153,204,255,.18)'; c.fillRect(130, sy, 660, 2);
    fillRR(c, 130 + (((t / 2500) % 1) * 600), 466, 60, 10, 5, B);
  }
}

const STARS = Array.from({ length: 140 }, (_, i) => {
  const r = Math.sin(i * 12.9898) * 43758.5453; const f = r - Math.floor(r);
  const r2 = Math.sin(i * 78.233) * 12345.678; const f2 = r2 - Math.floor(r2);
  return { a: f * Math.PI * 2, o: f2, sp: 0.00012 + f * 0.0001 };
});
function drawWarp(c, s, t) {
  rect(c, 0, 0, W, H, '#02030a');
  const cx = W / 2, cy = H / 2;
  for (const st of STARS) {
    const p = (st.o + t * st.sp) % 1, r = p * p * 620, len = 6 + p * p * 120;
    const x1 = cx + Math.cos(st.a) * r, y1 = cy + Math.sin(st.a) * r;
    const x0 = cx + Math.cos(st.a) * Math.max(0, r - len), y0 = cy + Math.sin(st.a) * Math.max(0, r - len);
    c.strokeStyle = `rgba(${150 + Math.round(p * 105)},${190 + Math.round(p * 65)},255,${Math.min(1, p * 1.4)})`;
    c.lineWidth = 0.6 + p * 2.2; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  const k = s.clockNow, tm = s.clock.set ? `${pad2(k.h)}:${pad2(k.m)}` : '--:--';
  c.font = 'bold 150px "Menlo","DejaVu Sans Mono",monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.shadowColor = '#4da3ff'; c.shadowBlur = 24; c.fillStyle = '#fff'; c.fillText(tm, cx, cy); c.shadowBlur = 0;
}

function drawSleep(c, s, t) {
  const fresh = s.diag && s.now - s.diag.at < 120000;
  if ((s.sleepScreen === 'diag' || s.sleepScreen === 'diag-anim') && fresh) drawDiag(c, s, t, s.sleepScreen === 'diag-anim');
  else if (s.sleepScreen === 'warp') drawWarp(c, s, t);
  else drawClock(c, s);
}

// ---------------------------------------------------------------- alert overlay
const ALERT_COL = { red: '#ff2a2a', yellow: '#ffb000', blue: '#33c7ff', green: '#35e07a' };
function drawAlert(c, s, t) {
  const a = s.alert; if (!a) return;
  const col = ALERT_COL[a.kind] || R;
  const on = a.kind === 'red' ? Math.floor(t / 250) % 2 === 0 : Math.sin(t / 350) > -0.3;
  c.save();
  c.globalAlpha = on ? 1 : 0.35;
  fillRR(c, 0, 0, W, 50, 0, col);
  c.fillStyle = '#000'; c.font = 'bold 28px "Helvetica Neue",Arial,sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
  c.fillText(`${a.kind.toUpperCase()} ALERT${a.text ? '  —  ' + a.text : ''}`, 20, 26);
  c.textAlign = 'right'; c.font = '14px sans-serif'; c.fillText('TOUCH TO ACKNOWLEDGE', W - 20, 26);
  c.strokeStyle = col; c.lineWidth = 8; c.strokeRect(4, 4, W - 8, H - 8);
  c.restore();
}

// ---------------------------------------------------------------- toast (e.g. "BT: Work PC")
function drawToast(c, s) {
  const t = s.toast; if (!t || s.now >= t.until) return;
  c.save();
  c.font = 'bold 26px "Helvetica Neue",Arial,sans-serif';
  // over the (non-interactive) title strip so it never hides a button
  const w = Math.min(W - 80, c.measureText(t.text).width + 56), h = 40, x = (W - w) / 2, y = 5;
  fillRR(c, x, y, w, h, 24, 'rgba(0,0,0,0.88)');
  c.lineWidth = 3; c.strokeStyle = B; rr(c, x, y, w, h, 24); c.stroke();
  c.fillStyle = B; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(t.text, W / 2, y + h / 2 + 1, w - 30);
  c.restore();
}

// ---------------------------------------------------------------- LED ring
function hsv(h, sv = 1, v = 1) {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6), p = v * (1 - sv), q = v * (1 - f * sv), u = v * (1 - (1 - f) * sv);
  const [r, g, b] = [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][i];
  return [r * 255, g * 255, b * 255];
}
function ledColors(s, t) {
  const n = 16, out = Array.from({ length: n }, () => [0, 0, 0]);
  const { r, g, b, tail, brightness } = s.led;
  const scale = brightness / 255;
  const fill = (col, k = 1) => out.forEach((o, i) => (out[i] = col.map((x) => x * k)));
  if (s.sleep.deepSleeping) return out;
  if (s.alert) {
    const k = s.alert.kind;
    if (k === 'red') fill([255, 0, 0], Math.floor(t / 250) % 2 === 0 ? 1 : 0.05);
    else if (k === 'yellow') fill([255, 170, 0], 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t / 240)));
    else if (k === 'blue') fill([40, 200, 255], 0.1 + 0.6 * (0.5 + 0.5 * Math.sin(t / 700)));
    else out.forEach((_, i) => { const d = (((t / 90) - i) % n + n) % n; out[i] = [0, 255 * Math.max(0, 1 - d / 5), 40 * Math.max(0, 1 - d / 5)]; });
    return out.map((o) => o.map((x) => x * scale));
  }
  if (s.sleep.sleeping) {
    const anim = s.dimLed;
    if (anim === 2) out.forEach((_, i) => (out[i] = hsv(((t / 4000) + i / n) % 1)));
    else if (anim === 3) fill([r, g, b], 0.1 + 0.9 * Math.abs(Math.sin(t / 500)));
    else if (anim === 4) out.forEach((_, i) => { const d = (((t / 120) - i) % n + n) % n; out[i] = [r, g, b].map((x) => x * Math.max(0, 1 - d / 6)); });
    else if (anim === 5) out.forEach((_, i) => { const q = Math.sin(Math.floor(t / 140) * 91.7 + i * 17.3); out[i] = q > 0.82 ? [r, g, b] : [r * 0.04, g * 0.04, b * 0.04]; });
    else fill([r, g, b], Math.max(0, Math.min(1, (Math.exp(Math.sin((t / 2000) * Math.PI)) - 0.36787944) * 108 / 255)));
    return out.map((o) => o.map((x) => x * scale));
  }
  const pos = (s.knobRaw / 4096) * n;
  out.forEach((_, i) => {
    const d = (((pos - i) % n) + n) % n;
    const k = tail >= n ? 1 : d < tail ? 1 - d / tail : 0;
    out[i] = [r * k, g * k, b * k];
  });
  return out.map((o) => o.map((x) => x * scale));
}

function drawKnob(s, t) {
  const c = kctx, cx = 110, cy = 110;
  c.clearRect(0, 0, 220, 220);
  const cols = s ? ledColors(s, t) : Array.from({ length: 16 }, () => [0, 0, 0]);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 - Math.PI / 2, x = cx + Math.cos(a) * 92, y = cy + Math.sin(a) * 92;
    const [r, g, b] = cols[i].map((v) => Math.max(0, Math.min(255, Math.round(v))));
    c.beginPath(); c.arc(x, y, 8, 0, 7);
    c.fillStyle = `rgb(${r},${g},${b})`; c.shadowColor = `rgb(${r},${g},${b})`; c.shadowBlur = r + g + b > 60 ? 14 : 0; c.fill(); c.shadowBlur = 0;
    c.lineWidth = 1.5; c.strokeStyle = '#2a2638'; c.stroke();
  }
  const g = c.createRadialGradient(cx - 14, cy - 14, 6, cx, cy, 64);
  g.addColorStop(0, '#4a4560'); g.addColorStop(1, '#1b1826');
  c.beginPath(); c.arc(cx, cy, 64, 0, 7); c.fillStyle = g; c.fill(); c.strokeStyle = V; c.lineWidth = 3; c.stroke();
  const ang = ((s ? s.knobRaw : 0) / 4096) * Math.PI * 2 - Math.PI / 2;
  c.beginPath(); c.moveTo(cx + Math.cos(ang) * 22, cy + Math.sin(ang) * 22); c.lineTo(cx + Math.cos(ang) * 58, cy + Math.sin(ang) * 58);
  c.strokeStyle = O; c.lineWidth = 6; c.lineCap = 'round'; c.stroke(); c.lineCap = 'butt';
}

// ---------------------------------------------------------------- frame loop
function frame(t) {
  if (snap) {
    // the page can lag the poll by <=150 ms; extrapolate the clock used for timers
    const s = snap;
    if (s.rebooting) { rect(ctx, 0, 0, W, H, '#000'); ctx.fillStyle = '#555'; ctx.font = '22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('REBOOTING…', W / 2, H / 2); }
    else if (s.sleep.sleeping || s.sleep.deepSleeping) drawSleep(ctx, s, t);
    else drawMain(ctx, s);
    if (!s.rebooting && !s.sleep.deepSleeping) drawAlert(ctx, s, t);
    if (!s.rebooting && !s.sleep.sleeping && !s.sleep.deepSleeping) drawToast(ctx, s);
    let b = Math.max(0.06, s.effectiveBrightness / 100);
    if (s.sleep.sleeping) b *= 0.55; // the firmware dims the backlight while the sleep screen is shown
    screen.style.filter = s.sleep.deepSleeping || s.rebooting ? 'brightness(0)' : `brightness(${b.toFixed(2)})`;
    drawKnob(s, t);
  } else {
    rect(ctx, 0, 0, W, H, '#000'); drawKnob(null, t);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- input: touch panel
function toPanel(ev) {
  const r = screen.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) * W) / r.width, y: ((ev.clientY - r.top) * H) / r.height };
}
function cellAt(x, y) {
  if (!snap || !snap.config.pages[snap.page]) return -1;
  const page = snap.config.pages[snap.page];
  for (const c of layout(snap.config)) if (page.buttons[c.i] && x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c.i;
  return -1;
}
let down = null;
screen.addEventListener('pointerdown', (ev) => {
  ev.preventDefault(); screen.setPointerCapture(ev.pointerId);
  const p = toPanel(ev);
  down = { ...p, t: performance.now() };
  pressed = cellAt(p.x, p.y);
});
screen.addEventListener('pointerup', async (ev) => {
  if (!down) return;
  const p = toPanel(ev), ms = performance.now() - down.t, dx = p.x - down.x, dy = p.y - down.y;
  const idx = cellAt(down.x, down.y);
  down = null; pressed = -1;
  if (Math.abs(dx) >= 120) { // possible swipe
    const r = await post('/api/swipe', { dx: Math.round(dx), dy: Math.round(dy), ms: Math.round(ms) });
    if (r && r.recognized) return poll();
  }
  const asleepOrAlert = snap && (snap.sleep.sleeping || snap.sleep.deepSleeping || snap.alert);
  if (idx >= 0 || asleepOrAlert) await post('/api/touch', { index: Math.max(0, idx), holdMs: Math.round(ms) });
  poll();
});
screen.addEventListener('pointercancel', () => { down = null; pressed = -1; });

// ---------------------------------------------------------------- input: knob
let knobDragging = false, lastKnobPost = 0, pendingRaw = null;
function knobRawFromEvent(ev) {
  const r = knobCv.getBoundingClientRect();
  const x = ev.clientX - (r.left + r.width / 2), y = ev.clientY - (r.top + r.height / 2);
  const a = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2);
  return Math.round((a / (Math.PI * 2)) * 4096) % 4096;
}
function sendKnob(raw) {
  if (snap) snap.knobRaw = raw; // optimistic, so the dial follows the pointer immediately
  const now = performance.now();
  if (now - lastKnobPost < 40) { pendingRaw = raw; return; }
  lastKnobPost = now; pendingRaw = null; post('/api/knob', { raw });
}
setInterval(() => { if (pendingRaw !== null) sendKnob(pendingRaw); }, 60);
knobCv.addEventListener('pointerdown', (ev) => { knobDragging = true; knobCv.setPointerCapture(ev.pointerId); sendKnob(knobRawFromEvent(ev)); });
knobCv.addEventListener('pointermove', (ev) => { if (knobDragging) sendKnob(knobRawFromEvent(ev)); });
knobCv.addEventListener('pointerup', () => { knobDragging = false; });
knobCv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const cur = snap ? snap.knobRaw : 0;
  sendKnob((((cur + (ev.deltaY < 0 ? 64 : -64)) % 4096) + 4096) % 4096);
}, { passive: false });

// ---------------------------------------------------------------- side panel
function setStatus(rows) {
  const dl = $('status'); dl.replaceChildren();
  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
    dl.append(dt, dd);
  }
}
function haPollText(s) {
  const e = Object.entries(s.haState || {});
  if (!e.length) return s.net.hasHaToken && s.net.hasHaUrl ? 'idle' : 'not configured';
  return e.slice(0, 3).map(([k, v]) => `${k}: ${v.state} (${Math.max(0, Math.round((s.now - v.at) / 1000))}s ago)`).join(' · ');
}
function updatePanel() {
  const s = snap, n = s.net.status;
  const host = $('hostChip');
  host.textContent = s.hostActive ? 'HOST: CONNECTED' : 'STANDALONE';
  host.className = 'chip ' + (s.hostActive ? 'on' : 'warn');
  const link = $('linkChip');
  link.textContent = s.rebooting ? 'REBOOTING…' : n.clients ? 'LINK: WIFI TCP' : 'LINK: NONE';
  link.className = 'chip ' + (n.clients ? 'on' : 'off');
  const sleepState = s.sleep.deepSleeping ? 'deep sleep' : s.sleep.sleeping ? 'dimmed (sleeping)' : 'awake';
  const k = s.clockNow;
  setStatus([
    ['Page', `${s.page + 1} / ${s.pageCount}  ${(s.config.pages[s.page] && s.config.pages[s.page].name) || ''}`],
    ['Sleep', `${sleepState}${s.sleep.enabled ? ` · after ${s.sleep.minutes} min` : ' · off'}`],
    ['Sleep screen', s.sleepScreen],
    ['Brightness', `${s.brightness}%${s.autodim.enabled ? ` (auto: ${s.effectiveBrightness}%)` : ''}`],
    ['WiFi', n.wifi === 'connected' ? `${n.ssid} · ${n.ip} · ${n.rssi} dBm` : 'off', n.wifi === 'connected' ? 'good' : ''],
    ['Host name', `${n.host}.local`],
    ['BLE', n.ble === 'connected' ? `connected: ${n.ble_peer}` : n.ble, n.ble === 'connected' ? 'good' : ''],
    ['BLE slot', `${n.ble_slot} · ${n.ble_slots[n.ble_slot - 1]}${s.ble.bonds[n.ble_slot - 1] ? ' · bonded' : ''}`],
    ['Caps', (n.caps || []).join(', ') || 'none'],
    ['Live buttons', Object.keys(s.live || {}).length ? `${Object.keys(s.live).length} overridden (RAM only)` : 'none'],
    ['HA poll', haPollText(s)],
    ['Standalone', `${s.net.standalone}${s.net.hasHaToken ? ' · HA token set' : ''}`],
    ['Autodim', s.autodim.sensor ? `${s.autodim.enabled ? 'on' : 'off'} · ${s.autodim.min}–${s.autodim.max}% · ${s.autodim.lux} lux` : 'no sensor', s.autodim.sensor ? '' : 'bad'],
    ['Gestures', `swipe ${s.gestures.swipe ? 'on' : 'off'} · hold ${s.gestures.holdMs} ms`],
    ['Alert', s.alert ? `${s.alert.kind}${s.alert.text ? ': ' + s.alert.text : ''}` : 'none', s.alert ? 'bad' : ''],
    ['Upload', s.upload.active ? `${s.upload.file || 'waiting'} (${s.upload.remaining} B left)` : 'idle'],
    ['Clock', s.clock.set ? `${pad2(k.h)}:${pad2(k.m)}:${pad2(k.s)}` : 'not set'],
  ]);
  $('ackBtn').hidden = !s.alert;
  $('bleBtn').hidden = !s.ble.enabled;
  $('bleBtn').textContent = s.ble.peer ? 'Disconnect BLE' : 'Simulate BLE connect';
  $('slotRow').hidden = !s.ble.enabled;
  document.querySelectorAll('#slotRow button[data-slot]').forEach((btn) => {
    const n = Number(btn.dataset.slot);
    if (n) { btn.textContent = `${n}: ${s.ble.slots[n - 1]}${s.ble.bonds[n - 1] ? ' ●' : ''}`; btn.classList.toggle('active', n === s.ble.slot); }
  });
  $('luxRow').hidden = !s.autodim.sensor;
  if (document.activeElement !== $('lux')) { $('lux').value = s.autodim.lux; $('luxOut').textContent = `${s.autodim.lux} lux`; }
  $('footRight').textContent = s.clock.set ? `${pad2(k.h)}:${pad2(k.m)}` : '';
  const log = $('log'); const text = s.log.slice(-40).join('\n');
  if (log.textContent !== text) { const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8; log.textContent = text; if (atEnd) log.scrollTop = log.scrollHeight; }
}
$('wakeBtn').addEventListener('click', () => post('/api/wake').then(poll));
$('sleepBtn').addEventListener('click', () => post('/api/sleep').then(poll));
$('ackBtn').addEventListener('click', () => post('/api/ack').then(poll));
$('bleBtn').addEventListener('click', () => post('/api/ble', { peer: snap && snap.ble.peer ? '' : 'MacBook Pro' }).then(poll));
document.querySelectorAll('#slotRow button[data-slot]').forEach((btn) =>
  btn.addEventListener('click', () => post('/api/ble-slot', { slot: btn.dataset.slot === 'next' ? 'next' : Number(btn.dataset.slot) }).then(poll)));
$('lux').addEventListener('input', (e) => { $('luxOut').textContent = `${e.target.value} lux`; post('/api/lux', { lux: Number(e.target.value) }); });

poll();
setInterval(poll, 150);
requestAnimationFrame(frame);
