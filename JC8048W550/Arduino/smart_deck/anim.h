// anim.h -- animated sleep screens
// OWNER: fork "ui". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
//
// SET_SLEEP_SCREEN:clock|diag|diag-anim|warp  (handled HERE; features_command() runs before the legacy chain)
//   diag-anim : the existing diagnostics screen + animated LCARS details (scan bar, blinking rail lights, sensor readout).
//               Falls back to the classic clock screen when DIAG data is stale (same rule as `diag`).
//   warp      : animated LCARS engineering console (plasma streaks, nodes, waveform, scopes, changing text) + HH:MM clock.
//
// Animation rules: partial redraw only (erase+redraw moving elements, never fillScreen per frame), fixed-size state, no heap
// allocation in the frame path, paced with millis() (~12 fps) and self-throttling if a frame ever gets slow, so LED / serial /
// touch handling in loop() are never starved. Animations only run while is_sleeping (dim sleep); waking redraws the page via
// the existing update_activity() path and the next sleep entry re-initialises the screen (diag_frame_drawn = false).
#ifndef ANIM_H
#define ANIM_H

#define ANIM_FRAME_MS_MIN 80UL     // ~12.5 fps
#define ANIM_FRAME_MS_MAX 400UL    // self-throttle ceiling

static uint32_t anim_last_ms = 0;
static uint32_t anim_interval_ms = ANIM_FRAME_MS_MIN;

// ---------------------------------------------------------------------------------------------------------------------
// WARP = animated LCARS console (sleep screen mode `warp`). Sequence: INTRO (frame, LOADING bar, SYSTEM READY) -> RUN
// (one of several interfaces, ~70 s each) -> OUTRO (wipe) -> next interface. Needs no host data except the clock.
//   interface 0: ENGINEERING  - ANALYSIS panel (plasma streaks, pulsing nodes, status lines, spectrum), number grid, scopes, buttons
//   interface 1: STELLAR MAP  - rotating galaxy with rings, roving zoom reticle, legend odometers, bar graph
// Changing numbers are "odometer fields": a template like "47###.##" whose # digits roll and settle on random values.
// Every element repaints only its own pixels at its own rate; AA text/lines are blended onto black or a known panel colour.
// ---------------------------------------------------------------------------------------------------------------------
#define OPS_DEBUG 0
#define OPS_FRAME_MS 40UL
#define OPS_IFACE_MS 70000UL
#define OP_NIFACE 2

// Content area (right of the rail, between the bars)
#define OP_CX 52
#define OP_CY 32
#define OP_CW 740
#define OP_CH 416
// ENGINEERING interface geometry
#define OP_PX 56
#define OP_PY 124
#define OP_PW 464
#define OP_PH 316
#define OP_FX0 222
#define OP_FY0 134
#define OP_FX1 514
#define OP_FY1 434
#define OP_FOC_X 506
#define OP_FOC_Y 424
#define OP_NP 22
#define OP_NN 5
#define OP_WV_N 32
#define OP_WV_X 68
#define OP_WV_CY 402
#define OP_RX 532
#define OP_RW 256
#define OP_GRID_Y 124
#define OP_GRID_H 90
#define OP_SC_Y 222
#define OP_SC_H 96
#define OP_BTN_Y 328
// STELLAR MAP geometry
#define OM_CX 300
#define OM_CY 284
#define OM_R 150
#define OM_NS 170

static inline uint16_t op_scale(uint16_t c, int s) {  // s: 0..256
  if (s >= 256) return c;
  if (s <= 0) return 0;
  uint32_t r = (((c >> 11) & 31) * (uint32_t)s) >> 8, g = (((c >> 5) & 63) * (uint32_t)s) >> 8, b = ((c & 31) * (uint32_t)s) >> 8;
  return (uint16_t)((r << 11) | (g << 5) | b);
}

// ---- odometer fields ----
struct OpField {
  int16_t x, y, w;
  const LcFont* f;
  char tpl[26], tgt[26], cur[26];
  uint8_t roll[26], n;
  uint16_t fg, bg;
  bool right;
};
static char opf_rand(char t) { return t == '#' ? (char)('0' + random(0, 10)) : (char)('A' + random(0, 26)); }
static void opf_draw(OpField& o) {
  int x0 = o.right ? o.x - o.w : o.x;
  gfx->fillRect(x0 - 1, o.y - o.f->cap - 2, o.w + 2, o.f->cap + 5, o.bg);
  lcDraw(*o.f, o.right ? o.x - lcW(*o.f, o.cur) : o.x, o.y, o.cur, o.fg, o.bg);
}
// New random target; changed characters roll for a few frames before settling.
static void opf_retarget(OpField& o, bool animate) {
  for (int i = 0; i < o.n; i++) {
    char t = o.tpl[i];
    if (t == '#' || t == '@') {
      o.tgt[i] = opf_rand(t);
      o.roll[i] = animate ? (uint8_t)random(3, 14) : 0;
      if (!animate) o.cur[i] = o.tgt[i];
    } else {
      o.tgt[i] = o.cur[i] = t;
      o.roll[i] = 0;
    }
  }
}
static void opf_init(OpField& o, int x, int y, const LcFont& f, const char* tpl, uint16_t fg, uint16_t bg, bool right = false) {
  memset(&o, 0, sizeof(o));
  strncpy(o.tpl, tpl, 24);
  o.n = (uint8_t)strlen(o.tpl);
  o.x = x; o.y = y; o.f = &f; o.fg = fg; o.bg = bg; o.right = right;
  char m[26];
  for (int i = 0; i < o.n; i++) m[i] = o.tpl[i] == '#' ? '8' : (o.tpl[i] == '@' ? 'W' : o.tpl[i]);
  m[o.n] = 0;
  o.w = lcW(f, m) + 4;
  opf_retarget(o, false);
  o.cur[o.n] = o.tgt[o.n] = 0;
  opf_draw(o);
}
static bool opf_step(OpField& o) {
  bool ch = false;
  for (int i = 0; i < o.n; i++) {
    if (o.roll[i] > 0) {
      o.roll[i]--;
      char nc = o.roll[i] ? opf_rand(o.tpl[i]) : o.tgt[i];
      if (nc != o.cur[i]) { o.cur[i] = nc; ch = true; }
    }
  }
  if (ch) opf_draw(o);
  return ch;
}
static void opf_poke(OpField& o) { opf_retarget(o, true); }

#define OP_NH 4
#define OP_NG 12
static OpField op_hf[OP_NH], op_gf[OP_NG], op_nf[OP_NN];
static OpField op_lg[6], op_xy;       // stellar map legend values, reticle coordinates
static OpField op_pct;                // loading percentage

// ---- state ----
struct OpP { float a, k, r, spd, len; int lum; int16_t px[7], py[7]; bool drawn; };
static OpP op_p[OP_NP];
struct OpNode { int16_t x, y; int8_t pr; };
static OpNode op_n[OP_NN] = { { 300, 196, 0 }, { 392, 250, 0 }, { 468, 190, 0 }, { 290, 330, 0 }, { 430, 350, 0 } };
static int16_t op_wv_last[OP_WV_N];
static float op_wv_h[OP_WV_N];
static int op_wv_t[OP_WV_N];
static int op_sc_x = 0, op_sc_ya = 0, op_sc_yb = 0;
static float op_sc_t = 0;
static uint8_t op_btn_hot = 0, op_lbl_i = 0, op_ftr_i = 0;
static uint32_t op_t_hdr, op_t_grid, op_t_stat, op_t_node, op_t_code, op_t_lbl, op_t_btn, op_t_ftr, op_t_lg, op_t_ring;
static char op_code[8] = "71832B";
static int op_stat_state[4] = { 0, 0, 0, 0 };
// stellar map
struct OmStar { float rho, phi, w; int16_t x, y; uint16_t col; bool drawn; };
static OmStar om_s[OM_NS];
static float om_t = 0;
static int16_t om_rx = 0, om_ry = 0, om_rs = 0;   // reticle centre and half-size drawn last frame
static int16_t om_bar_last[14];
static float om_bar_h[14];
static int om_bar_t[14];
// sequence
enum { OPH_INTRO = 0, OPH_RUN = 1, OPH_OUTRO = 2 };
static uint8_t op_phase = OPH_INTRO, op_iface = 0;
static uint32_t op_phase_t = 0, op_iface_t = 0;
static bool op_first = true;
static uint8_t op_intro_step = 0;
static int wr_h = -1, wr_m = -1;  // clock currently painted
#if OPS_DEBUG
static uint32_t op_dbg_sum = 0, op_dbg_n = 0, op_dbg_t = 0;
#endif

static const char* const OP_BTN_TXT[4] = { "ADDITIONAL INFO", "LOCAL SCAN", "ADJUST COURSE", "STANDARD ORBIT" };
static const char* const OP_TOP_LBL[4] = { "WARP PROPULSION", "ENGINEERING", "POWER GRID", "SUBSPACE FIELD" };
static const char* const OP_FTR_TXT[5] = { "WARP CORE NOMINAL", "FIELD STABLE", "POWER 98.4%", "COIL SYNC LOCKED", "ALL SYSTEMS GREEN" };
static const char* const OM_LEG_LBL[6] = { "SECTOR", "QUADRANT", "DENSITY", "MAGNITUDE", "RANGE LY", "DRIFT" };
static const char* const OM_LEG_TPL[6] = { "###.##", "@ ##", "####.#", "#.###", "####.##", "+##.#" };

// ---- small drawing helpers ----
static inline void op_fpix(int x, int y, uint16_t c) {  // clipped to the flow field
  if (x >= OP_FX0 && x < OP_FX1 && y >= OP_FY0 && y < OP_FY1) gfx->drawPixel(x, y, c);
}
// Anti-aliased gradient segment (brightness b0..b1 of `col`, 0..256). Erase mode re-walks the same pixels in black.
static void op_seg(int x0, int y0, int x1, int y1, int b0, int b1, uint16_t col, bool erase) {
  int dx = x1 - x0, dy = y1 - y0;
  int adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
  int n = adx > ady ? adx : ady;
  if (n == 0) {
    if (b0 >= 6) op_fpix(x0, y0, erase ? 0 : op_scale(col, b0));
    return;
  }
  bool xm = adx >= ady;
  for (int i = 0; i <= n; i++) {
    int b = b0 + (b1 - b0) * i / n;
    if (b < 6) continue;
    if (xm) {
      int x = x0 + (dx > 0 ? i : -i);
      float y = y0 + (float)dy * i / n;
      int yi = (int)floorf(y), fr = (int)((y - yi) * 256.0f);
      int w0 = b * (256 - fr) >> 8, w1 = b * fr >> 8;
      if (w0 >= 6) op_fpix(x, yi, erase ? 0 : op_scale(col, w0));
      if (w1 >= 6) op_fpix(x, yi + 1, erase ? 0 : op_scale(col, w1));
    } else {
      int y = y0 + (dy > 0 ? i : -i);
      float x = x0 + (float)dx * i / n;
      int xi = (int)floorf(x), fr = (int)((x - xi) * 256.0f);
      int w0 = b * (256 - fr) >> 8, w1 = b * fr >> 8;
      if (w0 >= 6) op_fpix(xi, y, erase ? 0 : op_scale(col, w0));
      if (w1 >= 6) op_fpix(xi + 1, y, erase ? 0 : op_scale(col, w1));
    }
  }
}
static void op_pill(int x, int y, int w, int h, uint16_t c, uint16_t bg = 0) { lcPill(x, y, w, h, c, bg); }
static void op_text_c(const LcFont& f, int cx, int cy, const char* t, uint16_t fg, uint16_t bg) {  // centred
  lcDraw(f, cx - lcW(f, t) / 2, cy + f.cap / 2, t, fg, bg);
}
static void op_randcode(char* d, int n) {  // letter + digits, e.g. "M051"
  d[0] = (char)('A' + random(0, 26));
  for (int i = 1; i < n; i++) d[i] = (char)('0' + random(0, 10));
  d[n] = 0;
}

// ---- shared frame (bars + rail) and header ----
static void op_frame() {
  op_pill(12, 6, 540, 20, LC_ORANGE);
  op_pill(558, 6, 48, 20, LC_PEACH);
  op_pill(612, 6, 176, 20, LC_ORANGE);
  op_pill(12, 454, 548, 20, LC_ORANGE);
  op_pill(566, 454, 54, 20, LC_PEACH);
  op_pill(626, 454, 162, 20, LC_VIOLET);
  lcRRect(12, 36, 34, 74, 9, LC_PEACH, BLACK);
  lcRRect(12, 116, 34, 114, 4, LC_VIOLET, BLACK);
  lcRRect(12, 236, 34, 84, 4, LC_BLUE, BLACK);
  lcRRect(12, 326, 34, 114, 9, LC_ORANGE, BLACK);
}
static void op_title() {
  gfx->fillRect(196, 38, 400, 78, BLACK);
  lcDraw(lcFontPx(40), 206, 72, op_iface == 0 ? "ENGINEERING" : "STELLAR MAP", LC_TAN, BLACK);
  char b[24];
  snprintf(b, sizeof(b), "LCARS | %s", op_code);
  lcDraw(lcFontPx(32), 206, 106, b, 0xFFFF, BLACK);
}
static void op_clock() {
  char b[8];
  snprintf(b, sizeof(b), "%02d:%02d", current_hour, current_minute);
  gfx->fillRect(598, 36, 192, 78, BLACK);
  lcDraw(LC_CLOCK, 788 - lcW(LC_CLOCK, b), 100, b, LC_ORANGE, BLACK);
  wr_h = current_hour;
  wr_m = current_minute;
}
static void op_top_label() {
  op_pill(612, 6, 176, 20, LC_ORANGE);
  op_text_c(lcFontPx(14), 700, 16, OP_TOP_LBL[op_lbl_i & 3], BLACK, LC_ORANGE);
}
static void op_footer_label() {
  op_pill(626, 454, 162, 20, LC_VIOLET);
  op_text_c(lcFontPx(14), 707, 464, OP_FTR_TXT[op_ftr_i % 5], BLACK, LC_VIOLET);
}
static void op_header() {
  static const uint8_t bw[4] = { 48, 70, 38, 30 };
  static const char* const tpl[4] = { "0#", "##", "0#", "0#" };
  lcRRect(56, 40, 48, 15, 7, LC_BLUE, BLACK);
  lcRRect(56, 59, 70, 15, 7, LC_ORANGE, BLACK);
  lcRRect(56, 78, 38, 15, 7, LC_BLUE, BLACK);
  lcRRect(56, 97, 30, 15, 7, LC_PEACH, BLACK);
  const LcFont& f = lcFontPx(14);
  for (int i = 0; i < OP_NH; i++) opf_init(op_hf[i], 56 + bw[i] + 8, 40 + i * 19 + 8 + f.cap / 2, f, tpl[i], i == 1 ? LC_ORANGE : LC_BLUE, BLACK);
  op_title();
  op_top_label();
  op_footer_label();
  op_clock();
}

// ---- ENGINEERING interface ----
static void op_stat_line(int i) {
  static const char* const lbl[4] = { "INJECTORS ", "NACELLE ALIGN ", "DILITHIUM ", "WARP FIELD " };
  static const char* const st0[3] = { "NOMINAL", "OPTIMAL", "SYNCING" };
  static const char* const st2[3] = { "STABLE", "NOMINAL", "BALANCED" };
  const LcFont& f = lcFontPx(14);
  char v[12];
  if (i == 0) snprintf(v, sizeof(v), "%s", st0[op_stat_state[0] % 3]);
  else if (i == 1) snprintf(v, sizeof(v), "%d.%d%%", 97 + op_stat_state[1] / 10 % 3, op_stat_state[1] % 10);
  else if (i == 2) snprintf(v, sizeof(v), "%s", st2[op_stat_state[2] % 3]);
  else snprintf(v, sizeof(v), "%d.%d", 9, op_stat_state[3] % 10);
  int y = 218 + i * 18;
  gfx->fillRect(72, y - 14, 146, 18, BLACK);
  lcDraw(f, 72, y, lbl[i], LC_TAN, BLACK);
  lcDraw(f, 72 + lcW(f, lbl[i]), y, v, LC_BLUE, BLACK);
}
static void op_part_spawn(OpP& p, bool anywhere) {
  p.a = (float)random(850, 1560) / 1000.0f * PI;
  p.k = (float)random(-36, 36) / 10000.0f;
  p.r = anywhere ? (float)random(10, 340) : (float)random(0, 24);
  p.spd = (float)random(70, 230);
  p.len = (float)random(30, 85);
  p.lum = random(110, 257);
  p.drawn = false;
}
static void op_part_pts(OpP& p) {
  for (int j = 0; j < 7; j++) {
    float rj = p.r - p.len * (6 - j) / 6.0f;
    if (rj < 0) rj = 0;
    float th = p.a + p.k * rj;
    p.px[j] = (int16_t)(OP_FOC_X + rj * cosf(th));
    p.py[j] = (int16_t)(OP_FOC_Y + rj * sinf(th));
  }
}
static void op_part_draw(OpP& p, bool erase) {
  for (int j = 0; j < 6; j++) op_seg(p.px[j], p.py[j], p.px[j + 1], p.py[j + 1], p.lum * j * j / 36, p.lum * (j + 1) * (j + 1) / 36, LC_BLUE, erase);
}
static void op_flow(float dt) {
  for (int i = 0; i < OP_NP; i++) {
    OpP& p = op_p[i];
    if (p.drawn) { op_part_draw(p, true); p.drawn = false; }
    p.r += p.spd * (0.7f + p.r / 260.0f) * dt;
    op_part_pts(p);
    if (p.px[6] < OP_FX0 - 20 || p.py[6] < OP_FY0 - 20 || p.px[6] > OP_FX1 + 20 || p.py[6] > OP_FY1 + 20) { op_part_spawn(p, false); continue; }
    op_part_draw(p, false);
    p.drawn = true;
  }
}
static void op_nodes(uint32_t now) {
  for (int i = 0; i < OP_NN; i++) {
    OpNode& n = op_n[i];
    if (n.pr) gfx->drawCircle(n.x, n.y, n.pr, BLACK);
    int ph = (int)((now / 55 + i * 9) % 26);
    n.pr = (int8_t)(9 + ph / 2);
    gfx->drawCircle(n.x, n.y, n.pr, op_scale(LC_BLUE, 256 - ph * 9));
    gfx->drawCircle(n.x, n.y, 7, 0xFFFF);
    gfx->drawCircle(n.x, n.y, 6, 0xFFFF);
    opf_draw(op_nf[i]);
  }
}
static void op_wave() {
  for (int i = 0; i < OP_WV_N; i++) {
    if (random(0, 100) < 14) op_wv_t[i] = random(3, 29);
    op_wv_h[i] += ((float)op_wv_t[i] - op_wv_h[i]) * 0.35f;
    int h = (int)(op_wv_h[i] + 0.5f);
    if (h == op_wv_last[i]) continue;
    op_wv_last[i] = h;
    int x = OP_WV_X + i * 4;
    gfx->fillRect(x, OP_WV_CY - 30, 3, 61, BLACK);
    gfx->fillRect(x, OP_WV_CY - h, 3, h * 2 + 1, op_scale(LC_ORANGE, 150 + h * 4));
    gfx->fillRect(x, OP_WV_CY - h, 3, 2, LC_GOLD);
    gfx->fillRect(x, OP_WV_CY + h - 1, 3, 2, LC_GOLD);
  }
}
static void op_scope() {
  for (int s = 0; s < 4; s++) {
    int w = OP_RW - 8;
    int x = OP_RX + 4 + op_sc_x;
    int ahead = OP_RX + 4 + (op_sc_x + 10) % w;
    gfx->drawFastVLine(ahead, OP_SC_Y + 4, OP_SC_H - 8, BLACK);
    op_sc_t += 0.16f;
    float a = sinf(op_sc_t * 1.3f) * 0.55f + sinf(op_sc_t * 3.1f + 1.0f) * 0.25f + ((float)random(-100, 100) / 700.0f);
    float ph = fmodf(op_sc_t, 4.2f);
    float b = (ph < 0.35f ? 1.0f - fabsf(ph - 0.17f) * 5.0f : 0.0f) * 0.9f - (ph > 0.35f && ph < 0.6f ? 0.25f : 0.0f) + ((float)random(-100, 100) / 900.0f);
    int ya = OP_SC_Y + 28 - (int)(a * 18.0f), yb = OP_SC_Y + 70 - (int)(b * 18.0f);
    if (op_sc_x == 0) { op_sc_ya = ya; op_sc_yb = yb; }
    gfx->drawFastVLine(x, OP_SC_Y + 4, OP_SC_H - 8, BLACK);
    if (x % 8 < 1) { gfx->drawPixel(x, OP_SC_Y + 28, LC_VIOLET); gfx->drawPixel(x, OP_SC_Y + 70, LC_VIOLET); }
    gfx->drawLine(x - 1, op_sc_ya, x, ya, LC_BLUE);
    gfx->drawLine(x - 1, op_sc_yb, x, yb, LC_SALMON);
    op_sc_ya = ya;
    op_sc_yb = yb;
    op_sc_x = (op_sc_x + 1) % w;
  }
}
static void op_button(int i, bool hot) {
  uint16_t col[4] = { LC_ORANGE, LC_PEACH, LC_BLUE, LC_VIOLET };
  int y = OP_BTN_Y + i * 31;
  op_pill(OP_RX, y, OP_RW, 24, hot ? LC_TAN : col[i]);
  op_text_c(lcFontPx(14), OP_RX + OP_RW / 2, y + 12, OP_BTN_TXT[i], BLACK, hot ? LC_TAN : col[i]);
}
static void op_eng_static() {
  lcRRect(OP_PX, OP_PY, OP_PW, OP_PH, 22, LC_BLUE, BLACK);
  lcRRect(OP_PX + 3, OP_PY + 3, OP_PW - 6, OP_PH - 6, 19, BLACK, LC_BLUE);
  lcRRect(OP_RX, OP_GRID_Y, OP_RW, OP_GRID_H, 10, LC_VIOLET, BLACK);
  lcRRect(OP_RX + 2, OP_GRID_Y + 2, OP_RW - 4, OP_GRID_H - 4, 8, LC_CHIP, LC_VIOLET);
  lcRRect(OP_RX, OP_SC_Y, OP_RW, OP_SC_H, 10, LC_VIOLET, BLACK);
  lcRRect(OP_RX + 2, OP_SC_Y + 2, OP_RW - 4, OP_SC_H - 4, 8, BLACK, LC_VIOLET);
  for (int x = OP_RX + 10; x < OP_RX + OP_RW - 10; x += 8) {
    gfx->drawPixel(x, OP_SC_Y + 28, LC_VIOLET);
    gfx->drawPixel(x, OP_SC_Y + 70, LC_VIOLET);
  }
  lcDraw(lcFontPx(32), 74, 168, "ANALYSIS", 0xFFFF, BLACK);
  lcDraw(lcFontPx(14), 74, 192, "WARP FIELD HARMONICS", LC_TAN, BLACK);
  for (int i = 0; i < 4; i++) { op_stat_state[i] = random(0, 30); op_stat_line(i); }
  lcDraw(lcFontPx(14), 70, 352, "LIVE SENSOR STREAM / DATA FLOW MONITOR", LC_BLUE, BLACK);
  for (int x = 70; x < 200; x += 6) gfx->drawPixel(x, 360, LC_VIOLET);
  for (int x = 70; x < 200; x += 18) gfx->drawFastVLine(x, 358, 5, LC_VIOLET);
  for (int i = 0; i < OP_NP; i++) op_part_spawn(op_p[i], true);
  for (int i = 0; i < OP_WV_N; i++) { op_wv_h[i] = 6; op_wv_t[i] = random(3, 29); op_wv_last[i] = -1; }
  for (int i = 0; i < OP_NG; i++) opf_init(op_gf[i], OP_RX + 12 + (i % 3) * 82, OP_GRID_Y + 22 + (i / 3) * 20, lcFontPx(14), "#####", LC_BLUE, LC_CHIP);
  for (int i = 0; i < OP_NN; i++) { op_n[i].pr = 0; opf_init(op_nf[i], op_n[i].x + 13, op_n[i].y - 4, lcFontPx(14), "@###", 0xFFFF, BLACK); }
  for (int i = 0; i < 4; i++) op_button(i, i == 0);
  op_sc_x = 0; op_sc_t = 0; op_btn_hot = 0;
}
static void op_eng_frame(uint32_t now, float dt) {
  op_flow(dt);
  op_nodes(now);
  op_wave();
  op_scope();
  for (int i = 0; i < OP_NG; i++) opf_step(op_gf[i]);
  if (now - op_t_grid > 140) { op_t_grid = now; for (int j = 0; j < 3; j++) opf_poke(op_gf[random(0, OP_NG)]); }
  if (now - op_t_stat > 2300) { op_t_stat = now; int i = random(0, 4); op_stat_state[i] = random(0, 30); op_stat_line(i); }
  if (now - op_t_node > 5200) { op_t_node = now; int i = random(0, OP_NN); gfx->fillRect(op_n[i].x + 12, op_n[i].y - 20, 44, 18, BLACK); opf_poke(op_nf[i]); }
  if (now - op_t_btn > 1600) { op_t_btn = now; op_button(op_btn_hot, false); op_btn_hot = (op_btn_hot + 1) & 3; op_button(op_btn_hot, true); }
}

// ---- STELLAR MAP interface ----
static void om_rings() {
  uint16_t rc = op_scale(LC_VIOLET, 150), tc = op_scale(LC_BLUE, 200);
  gfx->drawCircle(OM_CX, OM_CY, OM_R, LC_BLUE);
  gfx->drawCircle(OM_CX, OM_CY, OM_R - 1, LC_BLUE);
  gfx->drawCircle(OM_CX, OM_CY, OM_R * 2 / 3, rc);
  gfx->drawCircle(OM_CX, OM_CY, OM_R / 3, rc);
  gfx->drawFastHLine(OM_CX - OM_R, OM_CY, OM_R * 2, rc);
  gfx->drawFastVLine(OM_CX, OM_CY - OM_R, OM_R * 2, rc);
  for (int a = 0; a < 360; a += 15) {
    float t = a * PI / 180.0f;
    int l = (a % 90 == 0) ? 10 : 5;
    gfx->drawLine(OM_CX + (int)((OM_R + 2) * cosf(t)), OM_CY + (int)((OM_R + 2) * sinf(t)), OM_CX + (int)((OM_R + 2 + l) * cosf(t)), OM_CY + (int)((OM_R + 2 + l) * sinf(t)), tc);
  }
}
static void om_star_place(OmStar& s) {
  float t = om_t;
  s.rho = 0.1f + (float)random(0, 1000) / 1000.0f * 0.9f;
  float arm = (random(0, 2) ? 0.0f : PI);
  s.phi = arm + s.rho * 5.2f + (float)random(-180, 180) / 1000.0f;
  s.w = 0.22f / (0.25f + s.rho);
  (void)t;
  int lum = 120 + (int)((1.0f - s.rho) * 135.0f);
  s.col = s.rho < 0.35f ? op_scale(LC_GOLD, lum) : (random(0, 5) == 0 ? op_scale(0xFFFF, lum) : op_scale(LC_BLUE, lum));
  s.drawn = false;
}
static void om_legend_static() {
  int x0 = 500;
  lcRRect(x0, 124, 288, 316, 22, LC_VIOLET, BLACK);
  lcRRect(x0 + 3, 127, 282, 310, 19, BLACK, LC_VIOLET);
  lcDraw(lcFontPx(32), x0 + 18, 166, "CARTOGRAPHY", 0xFFFF, BLACK);
  lcDraw(lcFontPx(14), x0 + 18, 188, "STELLAR DENSITY SURVEY", LC_TAN, BLACK);
  for (int i = 0; i < 6; i++) {
    int y = 220 + i * 22;
    lcRRect(x0 + 18, y - 12, 10, 14, 3, (i & 1) ? LC_BLUE : LC_ORANGE, BLACK);
    lcDraw(lcFontPx(14), x0 + 36, y, OM_LEG_LBL[i], LC_TAN, BLACK);
    opf_init(op_lg[i], x0 + 266, y, lcFontPx(14), OM_LEG_TPL[i], 0xFFFF, BLACK, true);
  }
  lcDraw(lcFontPx(14), x0 + 18, 376, "FIELD ACTIVITY", LC_BLUE, BLACK);
  for (int i = 0; i < 14; i++) { om_bar_h[i] = 8; om_bar_t[i] = random(3, 34); om_bar_last[i] = -1; }
}
static void om_static() {
  om_t = 0;
  om_rings();
  for (int i = 0; i < OM_NS; i++) om_star_place(om_s[i]);
  om_rx = om_ry = om_rs = 0;
  om_legend_static();
  opf_init(op_xy, OM_CX - OM_R, OM_CY + OM_R + 12 + 0, lcFontPx(14), "##.### / ###.###", LC_TAN, BLACK);
}
static void om_frame(uint32_t now, float dt) {
  om_t += dt;
  // reticle: erase, then stars, then redraw reticle on top
  if (om_rs) {
    int x0 = om_rx - om_rs, y0 = om_ry - om_rs, x1 = om_rx + om_rs, y1 = om_ry + om_rs;
    gfx->drawRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1, BLACK);
    gfx->drawRect(x0 - 1, y0 - 1, x1 - x0 + 3, y1 - y0 + 3, BLACK);
  }
  for (int i = 0; i < OM_NS; i++) {
    OmStar& s = om_s[i];
    if (s.drawn) gfx->drawPixel(s.x, s.y, BLACK);
    s.phi += s.w * dt;
    int x = OM_CX + (int)(s.rho * OM_R * cosf(s.phi) * 0.97f), y = OM_CY + (int)(s.rho * OM_R * sinf(s.phi) * 0.97f);
    s.x = (int16_t)x; s.y = (int16_t)y;
    gfx->drawPixel(x, y, s.col);
    if (s.rho < 0.3f) gfx->drawPixel(x + 1, y, op_scale(s.col, 150));
    s.drawn = true;
  }
  // roving zoom reticle (Lissajous path), size pulses
  int cx = OM_CX + (int)(sinf(om_t * 0.37f) * 85.0f), cy = OM_CY + (int)(sinf(om_t * 0.53f + 1.0f) * 70.0f);
  int sz = 26 + (int)((sinf(om_t * 0.9f) + 1.0f) * 12.0f);
  om_rx = (int16_t)cx; om_ry = (int16_t)cy; om_rs = (int16_t)sz;
  int c = 9;
  uint16_t rc = LC_TAN;
  gfx->drawFastHLine(cx - sz, cy - sz, c, rc); gfx->drawFastVLine(cx - sz, cy - sz, c, rc);
  gfx->drawFastHLine(cx + sz - c + 1, cy - sz, c, rc); gfx->drawFastVLine(cx + sz, cy - sz, c, rc);
  gfx->drawFastHLine(cx - sz, cy + sz, c, rc); gfx->drawFastVLine(cx - sz, cy + sz - c + 1, c, rc);
  gfx->drawFastHLine(cx + sz - c + 1, cy + sz, c, rc); gfx->drawFastVLine(cx + sz, cy + sz - c + 1, c, rc);
  gfx->drawFastHLine(cx - 3, cy, 7, rc); gfx->drawFastVLine(cx, cy - 3, 7, rc);
  // rotating marker on the outer ring
  static int mk_a = -1;
  if (mk_a >= 0) {
    float t0 = mk_a * PI / 180.0f;
    gfx->fillCircle(OM_CX + (int)((OM_R + 8) * cosf(t0)), OM_CY + (int)((OM_R + 8) * sinf(t0)), 3, BLACK);
  }
  mk_a = (int)(om_t * 40.0f) % 360;
  float t1 = mk_a * PI / 180.0f;
  gfx->fillCircle(OM_CX + (int)((OM_R + 8) * cosf(t1)), OM_CY + (int)((OM_R + 8) * sinf(t1)), 3, LC_ORANGE);
  // legend + coordinate odometers
  for (int i = 0; i < 6; i++) opf_step(op_lg[i]);
  opf_step(op_xy);
  if (now - op_t_lg > 420) { op_t_lg = now; opf_poke(op_lg[random(0, 6)]); if (random(0, 3) == 0) opf_poke(op_xy); }
  // bar graph
  for (int i = 0; i < 14; i++) {
    if (random(0, 100) < 10) om_bar_t[i] = random(3, 36);
    om_bar_h[i] += ((float)om_bar_t[i] - om_bar_h[i]) * 0.3f;
    int h = (int)(om_bar_h[i] + 0.5f);
    if (h == om_bar_last[i]) continue;
    om_bar_last[i] = h;
    int x = 520 + i * 19;
    gfx->fillRect(x, 384, 13, 46, BLACK);
    gfx->fillRect(x, 430 - h, 13, h, op_scale(i & 1 ? LC_BLUE : LC_ORANGE, 170 + h * 2));
  }
  // heal the static rings now and then (the reticle and stars erase single pixels)
  if (now - op_t_ring > 1800) { op_t_ring = now; om_rings(); }
}

// ---- sequence ----
static void op_wipe_content() { gfx->fillRect(OP_CX, OP_CY, OP_CW, OP_CH, BLACK); }
static void op_iface_begin() {  // draw header + static parts of the current interface, enter RUN
  op_wipe_content();
  op_header();
  if (op_iface == 0) op_eng_static(); else om_static();
  uint32_t now = millis();
  op_t_hdr = op_t_grid = op_t_stat = op_t_node = op_t_code = op_t_lbl = op_t_btn = op_t_ftr = op_t_lg = op_t_ring = now;
  op_phase = OPH_RUN;
  op_phase_t = now;
  op_iface_t = now;
}

// Entry point used by draw_sleep_clock() for mode `warp`. Full init the first time after the screen was cleared
// (diag_frame_drawn == false); afterwards just keeps the clock current.
void anim_warp_draw() {
  if (!diag_frame_drawn) {
    gfx->fillScreen(BLACK);
    op_frame();
    uint32_t now = millis();
    op_phase = OPH_INTRO;
    op_phase_t = now;
    op_intro_step = 0;
    op_first = true;
    diag_frame_drawn = true;
    anim_last_ms = now;
    return;
  }
  if (op_phase == OPH_RUN && (current_hour != wr_h || current_minute != wr_m)) op_clock();
}

static void warp_frame(uint32_t now, float dt) {
  uint32_t el = now - op_phase_t;
  if (op_phase == OPH_INTRO) {
    // LOADING bar (full intro only), then SYSTEM READY, then the interface
    uint8_t& step = op_intro_step;
    uint32_t load_ms = op_first ? 1400 : 0, ready_ms = op_first ? 800 : 500;
    if (el == 0 || step == 0) {
      op_wipe_content();
      step = 1;
    }
    if (step == 1) {
      if (op_first) {
        const LcFont& f = lcFontPx(40);
        op_text_c(f, 420, 200, "LOADING", LC_ORANGE, BLACK);
        lcRRect(220, 236, 400, 20, 10, LC_VIOLET, BLACK);
        lcRRect(223, 239, 394, 14, 7, BLACK, LC_VIOLET);
        opf_init(op_pct, 620, 280, lcFontPx(14), "###%", LC_BLUE, BLACK, true);
      }
      step = 2;
    }
    if (step == 2) {
      if (op_first) {
        uint32_t p = el > load_ms ? load_ms : el;
        int w = (int)(388 * p / load_ms);
        if (w > 8) lcRRect(226, 242, w, 8, 4, LC_ORANGE, BLACK);
        char b[8];
        snprintf(b, sizeof(b), "%d%%", (int)(100 * p / load_ms));
        gfx->fillRect(560, 266, 62, 18, BLACK);
        lcDraw(lcFontPx(14), 620 - lcW(lcFontPx(14), b), 280, b, LC_BLUE, BLACK);
      }
      if (el >= load_ms) {
        op_wipe_content();
        op_text_c(lcFontPx(40), 420, 240, "SYSTEM READY", LC_ORANGE, BLACK);
        step = 3;
      }
    } else if (step == 3 && el >= load_ms + ready_ms) {
      step = 0;
      op_first = false;
      op_iface_begin();
    }
    return;
  }
  if (op_phase == OPH_OUTRO) {
    // vertical bars wipe across the content area
    int cols = 10, per = 36, i = (int)(el / 45);
    if (i < cols) gfx->fillRect(OP_CX + i * (OP_CW / cols), OP_CY, OP_CW / cols, OP_CH, BLACK);
    (void)per;
    if (i >= cols + 2) {
      op_iface = (op_iface + 1) % OP_NIFACE;
      op_phase = OPH_INTRO;
      op_phase_t = now;
    }
    return;
  }
  // RUN
  if (op_iface == 0) op_eng_frame(now, dt); else om_frame(now, dt);
  for (int i = 0; i < OP_NH; i++) opf_step(op_hf[i]);
  if (now - op_t_hdr > 650) { op_t_hdr = now; opf_poke(op_hf[random(0, OP_NH)]); }
  if (now - op_t_code > 24000) { op_t_code = now; op_randcode(op_code, 5); op_code[5] = (char)('A' + random(0, 26)); op_code[6] = 0; op_title(); }
  if (now - op_t_lbl > 14000) { op_t_lbl = now; op_lbl_i++; op_top_label(); }
  if (now - op_t_ftr > 7000) { op_t_ftr = now; op_ftr_i++; op_footer_label(); }
  if (now - op_iface_t > OPS_IFACE_MS) { op_phase = OPH_OUTRO; op_phase_t = now; }
}

// ---------------------------------------------------------------------------------------------------------------------
// DASHBOARD (key page) live LCARS elements: rolling numbers in the rail and foot bar, blinking status lights, cycling status text and a
// clock. Everything lives in the rail (x<110) and foot bar (y>=446) so alert banners / BT toasts in the header strip and the keys are
// never touched. dash_init() is called by lcarsFrame() each time the page is drawn; dash_tick() runs from anim_loop().
// ---------------------------------------------------------------------------------------------------------------------
static bool dh_on = false;
static OpField dh_rail[3];     // violet (top, bottom) and blue segment readouts
static OpField dh_odo;         // foot bar readout
static uint8_t dh_light[4];
static uint8_t dh_stat_i = 0;
static int dh_clk_h = -1, dh_clk_m = -1;
static bool dh_clk_ok = false;
static uint32_t dh_t_roll, dh_t_stat;
static const char* const DH_STAT[6] = { "ALL SYSTEMS GREEN", "COMMS ONLINE", "POWER NOMINAL", "SENSORS ACTIVE", "SHIELDS UP", "NAV LOCKED" };
static const int16_t DH_LIGHT_Y[4] = { 300, 340, 380, 414 };
static const uint16_t DH_PERIOD[4] = { 700, 1100, 1700, 2600 };
#define DH_FOOT_Y 446

static void dh_clock() {
  const LcFont& f = lcFontPx(19);
  char b[8];
  if (clock_initialized) snprintf(b, sizeof(b), "%02d:%02d", current_hour, current_minute);
  else snprintf(b, sizeof(b), "--:--");
  int edge = (int)screenWidth - 6;
  gfx->fillRect(edge - 20 - 64, DH_FOOT_Y + 4, 66, 26, LC_VIOLET);
  lcPrintC(f, edge - 20, DH_FOOT_Y + 17, b, BLACK, LC_VIOLET, true);
  dh_clk_h = current_hour; dh_clk_m = current_minute; dh_clk_ok = clock_initialized;
}
static void dh_status() {
  const LcFont& f = lcFontPx(19);
  gfx->fillRect(396, DH_FOOT_Y + 4, 190, 26, LC_VIOLET);
  lcPrintC(f, 400, DH_FOOT_Y + 17, DH_STAT[dh_stat_i % 6], BLACK, LC_VIOLET);
}

void dash_init(const char* page_name, int page_index, int page_count) {
  (void)page_index; (void)page_count;
  const LcFont& f = lcFontPx(19);
  int edge = (int)screenWidth - 6;
  // foot bar: "SMARTDECK  <PAGE NAME>" at the left
  char fl[48];
  snprintf(fl, sizeof(fl), "SMARTDECK  ");
  lcUpper(fl + strlen(fl), sizeof(fl) - strlen(fl), page_name, 20);
  lcPrintC(f, 140, DH_FOOT_Y + 17, fl, BLACK, LC_VIOLET);
  dh_stat_i = (uint8_t)random(0, 6);
  dh_status();
  opf_init(dh_odo, edge - 96, DH_FOOT_Y + 17 + f.cap / 2, f, "47###.##", BLACK, LC_VIOLET, true);
  dh_clock();
  // rail readouts (black on the segment colours)
  opf_init(dh_rail[0], 98, 140 + 22 + f.cap / 2, f, "###", BLACK, LC_VIOLET, true);
  opf_init(dh_rail[1], 98, 140 + 90 - 6, f, "####", BLACK, LC_VIOLET, true);
  opf_init(dh_rail[2], 98, 236 + 44 - 6, f, "##.#", BLACK, LC_BLUE, true);
  // status lights in the lilac segment
  for (int i = 0; i < 4; i++) { dh_light[i] = 2; }
  uint32_t now = millis();
  dh_t_roll = dh_t_stat = now;
  dh_on = true;
}

void dash_tick(uint32_t now) {
  if (!dh_on) return;
  if (is_sleeping || is_deep_sleeping) { dh_on = false; return; }  // the wake path redraws the page (and dash_init runs again)
  static uint32_t last = 0;
  if (now - last < 60) return;
  last = now;
  opf_step(dh_rail[0]); opf_step(dh_rail[1]); opf_step(dh_rail[2]); opf_step(dh_odo);
  if (now - dh_t_roll > 800) {
    dh_t_roll = now;
    int r = random(0, 4);
    if (r < 3) opf_poke(dh_rail[r]); else opf_poke(dh_odo);
  }
  for (int i = 0; i < 4; i++) {
    uint8_t on = (uint8_t)((now / DH_PERIOD[i]) & 1U);
    if (on != dh_light[i]) {
      dh_light[i] = on;
      gfx->fillRect(80, DH_LIGHT_Y[i], 16, 16, on ? LC_GOLD : LC_LILAC);
    }
  }
  if (now - dh_t_stat > 9000) { dh_t_stat = now; dh_stat_i++; dh_status(); }
  if (current_hour != dh_clk_h || current_minute != dh_clk_m || dh_clk_ok != clock_initialized) dh_clock();
}

// ---------------------------------------------------------------------------------------------------------------------
// DIAG-ANIM (overlays on top of the static diagnostics frame; the dynamic gauges are still drawn by diag_draw_dynamic)
// ---------------------------------------------------------------------------------------------------------------------
#define DA_BAR_X0 (DIAG_X + 8)
#define DA_SEG_W 64
#define DA_BAR_RANGE (DIAG_W - 16 - DA_SEG_W)   // travel distance of the scan segment
#define DA_BAR_Y 466
#define DA_BAR_H 10

static unsigned long da_gen = 0;      // diag_frame_gen the overlay state belongs to
static int da_scan_x = -1;            // current scan segment x (-1 = not drawn)
static uint8_t da_light_state[4];     // 0/1 = last painted, 2 = unknown
static uint32_t da_readout_slot = 0xFFFFFFFFUL;

struct DaLight { int16_t y; uint16_t color; uint16_t period; };
static const DaLight DA_LIGHTS[4] = {   // 16x16 indicator squares inside the rail segments (x = 80)
  { 122, LC_SALMON, 600 }, { 182, LC_VIOLET, 900 }, { 296, LC_BLUE, 1300 }, { 356, LC_TAN, 2100 },
};

static uint32_t da_xorshift(uint32_t x) {
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return x;
}

static void diaganim_frame(uint32_t now) {
  if (da_gen != diag_frame_gen) {  // static frame was (re)painted: forget what we think is on screen
    da_gen = diag_frame_gen;
    da_scan_x = -1;
    for (int i = 0; i < 4; i++) da_light_state[i] = 2;
    da_readout_slot = 0xFFFFFFFFUL;
  }

  // 1. Scan segment sweeping back and forth along the bottom bar (only the swept delta is repainted)
  // L4: now*220 overflows 32 bits every ~5.4 h (the segment jumped once per wrap): widen before multiplying.
  uint32_t t = (uint32_t)(((uint64_t)now * 220ULL / 1000ULL) % (2ULL * DA_BAR_RANGE));
  int off = (t < (uint32_t)DA_BAR_RANGE) ? (int)t : (int)(2UL * DA_BAR_RANGE - t);
  int pos = DA_BAR_X0 + off;
  if (pos != da_scan_x) {
    gfx->fillRect(pos, DA_BAR_Y, DA_SEG_W, DA_BAR_H, LC_BLUE);
    if (da_scan_x >= 0) {
      if (pos > da_scan_x) gfx->fillRect(da_scan_x, DA_BAR_Y, pos - da_scan_x, DA_BAR_H, LC_VIOLET);
      else gfx->fillRect(pos + DA_SEG_W, DA_BAR_Y, da_scan_x - pos, DA_BAR_H, LC_VIOLET);
    }
    da_scan_x = pos;
  }

  // 2. Blinking status lights on the rail (repaint only on state change)
  for (int i = 0; i < 4; i++) {
    uint8_t on = (uint8_t)((now / DA_LIGHTS[i].period) & 1U);
    if (on != da_light_state[i]) {
      gfx->fillRect(80, DA_LIGHTS[i].y, 16, 16, on ? LC_GOLD : DA_LIGHTS[i].color);
      da_light_state[i] = on;
    }
  }

  // 3. Sensor readout (2 Hz) right of the host name
  uint32_t slot = now / 500UL;
  if (slot != da_readout_slot) {
    da_readout_slot = slot;
    char buf[20];
    snprintf(buf, sizeof(buf), "SCAN 0x%04lX", (unsigned long)(da_xorshift(slot * 2654435761UL + 12345UL) & 0xFFFFUL));
    gfx->fillRect(600, 52, 190, 18, BLACK);
    gfx->setTextSize(2);
    gfx->setTextColor(LC_BLUE);
    gfx->setCursor(610, 54);
    gfx->print(buf);
  }
  gfx->setTextSize(2);
}

// ---------------------------------------------------------------------------------------------------------------------
// module hooks
// ---------------------------------------------------------------------------------------------------------------------
void anim_setup() {
  randomSeed(esp_random());
  uint8_t def = sleep_screen_diag ? SLM_DIAG : SLM_CLOCK;  // legacy bool "sleep_diag" => diag
  sleep_screen_mode = preferences.getUChar("sleep_mode", def);
  if (sleep_screen_mode > SLM_WARP) sleep_screen_mode = SLM_CLOCK;
  sleep_screen_diag = (sleep_screen_mode == SLM_DIAG || sleep_screen_mode == SLM_DIAG_ANIM);
  for (int i = 0; i < 4; i++) da_light_state[i] = 2;
}

void anim_loop() {
  dash_tick(millis());                                    // key-page rail/foot animation (no-op unless the page is showing)
  if (sleep_screen_mode < SLM_DIAG_ANIM) return;          // clock / diag: nothing animates
  if (!is_sleeping || is_deep_sleeping) return;          // only while the dimmed sleep screen is showing
  uint32_t now = millis();
  if (now - anim_last_ms < anim_interval_ms) return;

  if (sleep_screen_mode == SLM_DIAG_ANIM) {
    if (!diag_frame_drawn) return;                       // diagnostics frame not on screen
    if (!diag_active()) {                                // data went stale: fall back to the classic clock screen once
      draw_sleep_clock();
      return;
    }
    uint32_t t0 = millis();
    diaganim_frame(now);
    uint32_t cost = millis() - t0;
    anim_last_ms = now;
    anim_interval_ms = cost > 25 ? ((cost * 3 > ANIM_FRAME_MS_MAX) ? ANIM_FRAME_MS_MAX : cost * 3) : ANIM_FRAME_MS_MIN;
    return;
  }

  // warp
  if (!diag_frame_drawn) return;                         // not initialised yet (draw_sleep_clock does that)
  float dt = (float)(now - anim_last_ms) / 1000.0f;
  if (dt > 0.25f) dt = 0.25f;
  uint32_t t0 = millis();
  warp_frame(now, dt);
  uint32_t cost = millis() - t0;
  anim_last_ms = now;
#if OPS_DEBUG
  op_dbg_sum += cost; op_dbg_n++;
  if (now - op_dbg_t > 5000) { Serial.printf("WARP_FRAME_MS avg=%lu n=%lu\n", (unsigned long)(op_dbg_sum / op_dbg_n), (unsigned long)op_dbg_n); op_dbg_sum = 0; op_dbg_n = 0; op_dbg_t = now; }
#endif
  anim_interval_ms = cost > 30 ? ((cost * 2 > ANIM_FRAME_MS_MAX) ? ANIM_FRAME_MS_MAX : cost * 2) : OPS_FRAME_MS;
}

// SET_SLEEP_SCREEN:clock|diag|diag-anim|warp
bool anim_command(const String& c) {
  if (!c.startsWith("SET_SLEEP_SCREEN:")) return false;
  String mode = c.substring(17);
  mode.trim();
  uint8_t m;
  if (mode == "clock") m = SLM_CLOCK;
  else if (mode == "diag") m = SLM_DIAG;
  else if (mode == "diag-anim") m = SLM_DIAG_ANIM;
  else if (mode == "warp") m = SLM_WARP;
  else {
    Serial.println("ERR_SLEEP_SCREEN");
    return true;
  }
  sleep_screen_mode = m;
  sleep_screen_diag = (m == SLM_DIAG || m == SLM_DIAG_ANIM);   // keeps the existing diag_active()/draw paths working
  preferences.putUChar("sleep_mode", m);
  preferences.putBool("sleep_diag", sleep_screen_diag);        // legacy key, harmless for older firmware
  Serial.printf("SLEEP_SCREEN_SET:%s\n", mode.c_str());
  if (is_sleeping && !is_deep_sleeping) {
    diag_frame_drawn = false;
    draw_sleep_clock();
  }
  return true;
}
#endif
