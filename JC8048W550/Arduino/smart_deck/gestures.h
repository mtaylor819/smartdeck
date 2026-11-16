// gestures.h -- touch gestures: swipe to change page, long-press hold events
// OWNER: fork "ui". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
//
//  * Swipe left/right (>=120 px, <=700 ms, |dx| > 2|dy|) changes page (clamped, no wrap), emits PAGE_CHANGED:n and the
//    touch is CONSUMED: the release never reaches the button logic, so a swipe can't press anything.
//  * Buttons whose JSON has "hold":true emit BTN_HOLD:page:idx once when held >= holdMs; we then set the existing
//    long_press_triggered flag so the normal BTN is suppressed on release. Buttons without "hold" are untouched
//    (including the existing 800 ms counter/timer reset long-press).
//  * SET_GESTURES:<swipe 0|1>:<holdMs>  (default 1:600), persisted in Preferences key "gest".
#ifndef GESTURES_H
#define GESTURES_H

#include "gesture_logic.h"

static GestureCfg g_gest_cfg;
static GestureTracker g_gest_tracker;

// Does button `idx` on the current page have "hold":true? (called once per button the finger enters)
static bool gesture_btn_has_hold(int idx) {
  JsonObject cfg = doc["pages"][current_page]["buttons"][idx];
  if (cfg.isNull()) return false;
  return cfg["hold"] | false;
}

void gestures_setup() {
  uint32_t packed = preferences.getUInt("gest", 0);
  if (packed != 0) {
    g_gest_cfg.swipe = (packed & 0x10000UL) != 0;
    unsigned long ms = packed & 0xFFFFUL;
    if (ms >= 200 && ms <= 5000) g_gest_cfg.holdMs = ms;
  }
}

void gestures_loop() {}  // all work happens in gestures_touch(), driven by the touch poll

// SET_GESTURES:<swipe 0|1>:<holdMs>
bool gestures_command(const String& c) {
  if (!c.startsWith("SET_GESTURES:")) return false;
  int p1 = c.indexOf(':');
  int p2 = c.indexOf(':', p1 + 1);
  if (p2 < 0) {
    Serial.println("ERR_GESTURES");
    return true;
  }
  int sw = c.substring(p1 + 1, p2).toInt();
  long ms = c.substring(p2 + 1).toInt();
  if (ms < 200) ms = 200;
  if (ms > 5000) ms = 5000;
  g_gest_cfg.swipe = (sw != 0);
  g_gest_cfg.holdMs = (unsigned long)ms;
  preferences.putUInt("gest", (g_gest_cfg.swipe ? 0x10000UL : 0UL) | (uint32_t)ms);
  Serial.printf("GESTURES_SET:%d:%ld\n", g_gest_cfg.swipe ? 1 : 0, ms);
  return true;
}

// Called from the touch block of loop() once per touch poll, after the button under the finger is known and BEFORE the
// press/hold/release state machine. Returns true when this poll's touch has been CONSUMED by a swipe (caller must skip
// the press/hold/release chain for this poll).
bool gestures_touch(bool touching, bool coordValid, int tx, int ty, int btn, unsigned long now) {
  GestureOut o = g_gest_tracker.update(touching, coordValid, tx, ty, btn, now, g_gest_cfg, gesture_btn_has_hold);

  if (o.holdFire) {
    // Only act if the existing long-press logic hasn't already claimed this press (counter/timer reset at 800 ms).
    if (!long_press_triggered) {
      Serial.printf("BTN_HOLD:%d:%d\n", current_page, o.holdBtn);
      long_press_triggered = true;  // suppress the normal BTN on release (existing mechanism)
    }
  }

  if (o.swipe != 0) {
    int pages = (int)doc["pages"].size();
    if (pages < 1) pages = 1;  // defensive: never clamp to a negative page
    int next = current_page + o.swipe;
    if (next < 0) next = 0;
    if (next > pages - 1) next = pages - 1;
    if (next != current_page) {
      current_page = next;
      draw_page(current_page);
      Serial.printf("PAGE_CHANGED:%d\n", current_page);
    } else if (last_touched_button_index != -1) {
      draw_page(current_page);  // clamped at first/last page: wipe the press highlight the swipe left behind
    }
    last_touched_button_index = -1;
    long_press_triggered = false;
    return true;
  }
  return false;
}
#endif
