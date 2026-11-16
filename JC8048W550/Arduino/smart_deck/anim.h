// anim.h -- animated sleep screens
// OWNER: fork "ui". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
//
// SET_SLEEP_SCREEN:clock|diag|diag-anim|warp  (handled HERE; features_command() runs before the legacy chain)
//   diag-anim : the existing diagnostics screen + animated LCARS details (scan bar, blinking rail lights, sensor readout).
//               Falls back to the classic clock screen when DIAG data is stale (same rule as `diag`).
//   warp      : warp-streak starfield radiating from the centre with a large HH:MM clock. Needs no host data.
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
// WARP
// ---------------------------------------------------------------------------------------------------------------------
#define WARP_N 56
#define WARP_CX 400
#define WARP_CY 240
#define WARP_CLK_SIZE 14                         // 6*14 = 84 px per glyph, 5 glyphs = 420 px wide, 112 px tall
#define WARP_CLK_W (5 * 6 * WARP_CLK_SIZE)
#define WARP_CLK_H (8 * WARP_CLK_SIZE)
#define WARP_CLK_X ((800 - WARP_CLK_W) / 2)
#define WARP_CLK_Y ((480 - WARP_CLK_H) / 2 - 10)
#define WARP_CAP_Y (WARP_CLK_Y + WARP_CLK_H + 22)  // caption line below the clock

struct WarpStar {
  float cs, sn;     // direction (cos/sin of angle), precomputed at spawn
  float r;          // distance from centre of the HEAD of the streak
  float spd;        // base speed px/s
  int16_t x0, y0, x1, y1;  // segment currently on screen
  bool drawn;
};
static WarpStar warp_stars[WARP_N];
static int wr_h = -1, wr_m = -1;  // clock currently painted

// Rectangles streaks must never touch (so erasing a streak can't punch holes in the clock/caption): x0,y0,x1,y1
static const int16_t WARP_PROT[2][4] = {
  { WARP_CLK_X - 14, WARP_CLK_Y - 12, WARP_CLK_X + WARP_CLK_W + 14, WARP_CLK_Y + WARP_CLK_H + 12 },
  { 236, WARP_CAP_Y - 8, 564, WARP_CAP_Y + 32 },
};

static inline bool warp_hits_protected(int ax, int ay, int bx, int by) {
  int minx = ax < bx ? ax : bx, maxx = ax < bx ? bx : ax;
  int miny = ay < by ? ay : by, maxy = ay < by ? by : ay;
  for (int i = 0; i < 2; i++) {
    if (maxx >= WARP_PROT[i][0] && minx <= WARP_PROT[i][2] && maxy >= WARP_PROT[i][1] && miny <= WARP_PROT[i][3]) return true;
  }
  return false;
}

static void warp_spawn(WarpStar& s, bool anywhere) {
  float a = (float)random(0, 62832) / 10000.0f;  // 0..2*pi
  s.cs = cosf(a);
  s.sn = sinf(a);
  s.r = anywhere ? (float)random(6, 380) : (float)random(6, 30);
  s.spd = (float)random(120, 420);
  s.drawn = false;
}

static void warp_draw_clock() {
  char buf[8];
  snprintf(buf, sizeof(buf), "%02d:%02d", current_hour, current_minute);
  gfx->fillRect(WARP_CLK_X - 8, WARP_CLK_Y - 6, WARP_CLK_W + 16, WARP_CLK_H + 12, BLACK);
  gfx->setTextSize(WARP_CLK_SIZE);
  gfx->setTextColor(LC_ORANGE);
  gfx->setCursor(WARP_CLK_X, WARP_CLK_Y);
  gfx->print(buf);
  gfx->setTextSize(2);
  wr_h = current_hour;
  wr_m = current_minute;
}

static void warp_draw_caption() {
  gfx->setTextSize(3);
  gfx->setTextColor(LC_BLUE);
  gfx->setCursor(250, WARP_CAP_Y);
  gfx->print("WARP FACTOR 9.9");
  gfx->setTextSize(2);
}

// Entry point used by draw_sleep_clock() for mode `warp`. Full init the first time after the screen was cleared
// (diag_frame_drawn == false); afterwards just keeps the clock current.
void anim_warp_draw() {
  if (!diag_frame_drawn) {
    gfx->fillScreen(BLACK);
    for (int i = 0; i < WARP_N; i++) warp_spawn(warp_stars[i], true);
    warp_draw_clock();
    warp_draw_caption();
    diag_frame_drawn = true;
    anim_last_ms = millis();
    return;
  }
  if (current_hour != wr_h || current_minute != wr_m) warp_draw_clock();
}

static void warp_frame(uint32_t now, float dt) {
  for (int i = 0; i < WARP_N; i++) {
    WarpStar& s = warp_stars[i];
    if (s.drawn) {  // erase last frame's streak
      gfx->drawLine(s.x0, s.y0, s.x1, s.y1, BLACK);
      s.drawn = false;
    }
    s.r += s.spd * (0.6f + s.r / 200.0f) * dt;  // accelerate away from the centre
    float tail = s.r - (3.0f + s.r * 0.18f);    // streaks lengthen with distance
    if (tail < 0) tail = 0;
    int hx = WARP_CX + (int)(s.cs * s.r), hy = WARP_CY + (int)(s.sn * s.r);
    if (hx < 0 || hx >= 800 || hy < 0 || hy >= 480) {
      warp_spawn(s, false);
      continue;
    }
    int tx = WARP_CX + (int)(s.cs * tail), ty = WARP_CY + (int)(s.sn * tail);
    if (warp_hits_protected(tx, ty, hx, hy)) continue;  // behind the clock: skip (nothing drawn => nothing to erase)
    int v = 50 + (int)(s.r * 0.5f);
    if (v > 255) v = 255;
    gfx->drawLine(tx, ty, hx, hy, C565(v * 8 / 10, v * 9 / 10, v));
    s.x0 = tx; s.y0 = ty; s.x1 = hx; s.y1 = hy;
    s.drawn = true;
  }
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
  uint32_t t = (now * 220UL / 1000UL) % (2UL * DA_BAR_RANGE);
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
  anim_interval_ms = cost > 25 ? ((cost * 3 > ANIM_FRAME_MS_MAX) ? ANIM_FRAME_MS_MAX : cost * 3) : ANIM_FRAME_MS_MIN;
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
