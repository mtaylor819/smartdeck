// ambient.h -- ambient-light sensor auto-dim (optional BH1750 on the shared I2C bus)
// OWNER: fork "led". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
//
//   SET_AUTODIM:<en 0|1>:<minPct>:<maxPct>[:<luxLow>:<luxHigh>]  -> AUTODIM:ok | AUTODIM:no_sensor | AUTODIM:err:args
//   LUX:<n>   deck -> host, at most every 10 s, only on a >20% change (only while a host is present)
//
// I2C BUS ANALYSIS (inferred from the code; NOT verified on hardware):
//   The sketch never calls Wire.begin(). TAMC_GT911::begin() does Wire.begin(TOUCH_SDA=19, TOUCH_SCL=20) on the default `Wire`, and the
//   AS5600 knob is constructed on that same `Wire` (AS5600 as5600(&Wire)); KNOB_SDA/KNOB_SCL (17/19) are never used. So there is ONE
//   shared bus (Wire on GPIO19/20) carrying GT911 (0x5D or 0x14), AS5600 (0x36) and, if fitted, the BH1750 (0x23, or 0x5C with ADDR high).
//   The BH1750 addresses collide with neither. We therefore use `Wire` only (never a second bus, never touching GT911 registers), do only
//   tiny transactions (one 2-byte read per 500 ms, from the main loop so they never interleave with GT911/AS5600 transfers), and the
//   module is inert when no sensor ACKs at boot.
#ifndef AMBIENT_H
#define AMBIENT_H

#include <math.h>

#define AMB_HOLD_AFTER_EXPLICIT_MS 60000UL
#define AMB_READ_INTERVAL_MS 500UL
#define AMB_STEP_INTERVAL_MS 100UL

static Preferences amb_prefs;
static bool amb_present = false;
static uint8_t amb_addr = 0;
static uint8_t amb_fail = 0;
static bool amb_enabled = false;
static int amb_min = 10, amb_max = 100;
static int amb_lux_lo = 5, amb_lux_hi = 400;
static float amb_lf = 0.0f;  // low-pass filtered log10(lux + 1)
static bool amb_lf_init = false;
static float amb_lux_now = 0.0f;
static unsigned long amb_last_read = 0, amb_last_step = 0, amb_last_lux_sent = 0;
static float amb_last_lux_val = 0.0f;
static bool amb_lux_sent_once = false;
static unsigned long amb_last_explicit_ms = 0;
static bool amb_explicit_seen = false;
static unsigned long amb_probe_ms = 0;  // millis() when continuous mode was started (M6)
#define AMB_FIRST_READ_DELAY_MS 250UL   // discard reads before the first measurement can have completed
#define AMB_ZERO_GRACE_MS 1000UL        // a literal 0 lux right after start is more likely "no data yet" than "pitch dark"

static bool amb_probe_addr(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// Find a BH1750 and start continuous high-resolution mode (1 lx, ~120 ms per sample).
static bool amb_probe() {
  uint8_t found = 0;
  if (amb_probe_addr(0x23)) found = 0x23;
  else if (amb_probe_addr(0x5C)) found = 0x5C;
  if (!found) return false;
  Wire.beginTransmission(found);
  Wire.write(0x01);  // power on
  Wire.endTransmission();
  Wire.beginTransmission(found);
  Wire.write(0x10);  // continuous H-resolution mode
  if (Wire.endTransmission() != 0) return false;
  amb_addr = found;
  amb_fail = 0;
  amb_lf_init = false;
  amb_probe_ms = millis();  // M6: the first conversion takes ~120-180 ms; until then the data register reads 0
  return true;
}

static void amb_save() {
  amb_prefs.putBool("en", amb_enabled);
  amb_prefs.putInt("mn", amb_min);
  amb_prefs.putInt("mx", amb_max);
  amb_prefs.putInt("ll", amb_lux_lo);
  amb_prefs.putInt("lh", amb_lux_hi);
}

void ambient_setup() {
  amb_prefs.begin("ambient", false);
  amb_enabled = amb_prefs.getBool("en", false);
  amb_min = amb_prefs.getInt("mn", 10);
  amb_max = amb_prefs.getInt("mx", 100);
  amb_lux_lo = amb_prefs.getInt("ll", 5);
  amb_lux_hi = amb_prefs.getInt("lh", 400);
  amb_present = amb_probe();  // after tp.begin(), so Wire is already initialised
  Serial.printf("Ambient sensor: %s\n", amb_present ? "BH1750 found" : "none");
}

static bool amb_read_lux(float& lux) {
  if (Wire.requestFrom(amb_addr, (uint8_t)2) != 2) return false;
  uint16_t raw = ((uint16_t)Wire.read() << 8) | Wire.read();
  lux = raw / 1.2f;
  return true;
}

static int amb_target_pct() {
  float lo = log10f((float)amb_lux_lo + 1.0f), hi = log10f((float)amb_lux_hi + 1.0f);
  float t = (amb_lf - lo) / (hi - lo);
  if (t < 0.0f) t = 0.0f;
  if (t > 1.0f) t = 1.0f;
  int pct = amb_min + (int)(t * (float)(amb_max - amb_min) + 0.5f);
  if (pct < 1) pct = 1;  // L3: the Mac allows min 0; never auto-dim the backlight fully OFF (set_brightness(0) = black screen)
  return pct;
}

void ambient_loop() {
  if (!amb_present) return;
  unsigned long now = millis();

  if (now - amb_last_read >= AMB_READ_INTERVAL_MS && now - amb_probe_ms >= AMB_FIRST_READ_DELAY_MS) {
    amb_last_read = now;
    float lux;
    if (amb_read_lux(lux)) {
      amb_fail = 0;
      float l = log10f(lux + 1.0f);
      if (!amb_lf_init) {
        // M6: initialise the filter from the first VALID sample. Starting from a bogus 0 made brightness sink toward `min` at 1% per
        // 100 ms for several seconds at every boot, then climb back.
        if (lux <= 0.0f && now - amb_probe_ms < AMB_ZERO_GRACE_MS) return;
        amb_lf = l;
        amb_lf_init = true;
      } else {
        amb_lf += 0.25f * (l - amb_lf);  // low-pass in the log domain: smooth, no flicker from passing shadows
      }
      amb_lux_now = powf(10.0f, amb_lf) - 1.0f;

      // LUX event: only while a host is listening, <= 1 per 10 s, only on a >20% change.
      if (host_link_active() && now - amb_last_lux_sent >= 10000UL) {
        float ref = amb_last_lux_val < 1.0f ? 1.0f : amb_last_lux_val;
        if (!amb_lux_sent_once || fabsf(amb_lux_now - amb_last_lux_val) > 0.2f * ref) {
          Serial.printf("LUX:%d\n", (int)(amb_lux_now + 0.5f));
          amb_last_lux_val = amb_lux_now;
          amb_last_lux_sent = now;
          amb_lux_sent_once = true;
        }
      }
    } else if (++amb_fail >= 10) {
      amb_present = false;  // sensor vanished: go inert until the next SET_AUTODIM re-probes
      return;
    }
  }

  // Fade towards the target 1% per 100 ms. Only while awake (don't fight dim/deep-sleep), and not within 60 s of an explicit
  // SET_BRIGHTNESS from the host/UI.
  if (amb_enabled && amb_lf_init && now - amb_last_step >= AMB_STEP_INTERVAL_MS) {
    amb_last_step = now;
    if (is_sleeping || is_deep_sleeping) return;
    if (amb_explicit_seen && now - amb_last_explicit_ms < AMB_HOLD_AFTER_EXPLICIT_MS) return;
    int target = amb_target_pct();
    if (current_brightness < target) set_brightness(current_brightness + 1);
    else if (current_brightness > target) set_brightness(current_brightness - 1);
  }
}

bool ambient_command(const String& c) {
  if (c.startsWith("SET_BRIGHTNESS:")) {
    // Observe only (the legacy handler still applies it): an explicit level pauses auto-dim for 60 s.
    amb_last_explicit_ms = millis();
    amb_explicit_seen = true;
    return false;
  }
  if (!c.startsWith("SET_AUTODIM:")) return false;

  int en = 0, mn = 0, mx = 0, lo = amb_lux_lo, hi = amb_lux_hi;
  int n = sscanf(c.c_str() + 12, "%d:%d:%d:%d:%d", &en, &mn, &mx, &lo, &hi);
  bool ok = n >= 3 && (en == 0 || en == 1) && mn >= 0 && mn <= 100 && mx >= mn && mx <= 100;  // L3: min 0 allowed (floored to 1% when dimming)
  if (n >= 5) ok = ok && lo >= 1 && hi > lo && hi <= 65535;
  if (!ok) {
    Serial.println("AUTODIM:err:args");
    return true;
  }
  amb_enabled = en == 1;
  amb_min = mn;
  amb_max = mx;
  if (n >= 5) {
    amb_lux_lo = lo;
    amb_lux_hi = hi;
  }
  amb_save();  // persisted even without a sensor, so it works if one is fitted later
  if (!amb_present) amb_present = amb_probe();  // allow hot-plugging a sensor
  if (!amb_present) {
    Serial.println("AUTODIM:no_sensor");
    return true;
  }
  amb_explicit_seen = false;  // enabling auto-dim takes effect immediately
  Serial.println("AUTODIM:ok");
  return true;
}
#endif
