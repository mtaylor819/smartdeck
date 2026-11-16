// features.h -- optional feature modules (WiFi/BLE/alerts/auto-dim/gestures/animations).
// Each module lives in its own header so features can be developed independently. This file only wires them in.
#ifndef FEATURES_H
#define FEATURES_H

// ---- host presence ----------------------------------------------------------------------------------------
// A host app (USB or WiFi) sends "HB" every ~5 s and other commands; if we've heard from one recently the deck
// reports button presses to it. Otherwise buttons run STANDALONE (BLE keyboard / WiFi Home Assistant).
unsigned long last_host_seen_ms = 0;
inline void host_seen() { last_host_seen_ms = millis(); }
inline bool host_link_active() { return last_host_seen_ms != 0 && (millis() - last_host_seen_ms) < 15000UL; }

#include "live_buttons.h"   // [live] SET_BTN_LIVE (RAM-only button overrides); data lives in live_table.h
#include "net_wifi.h"
#include "ble_hid.h"
#include "led_alert.h"
#include "ambient.h"
#include "gestures.h"
#include "anim.h"

void features_setup() {
  net_setup(); ble_setup(); alert_setup(); ambient_setup(); gestures_setup(); anim_setup();
}

void features_loop() {
  net_loop(); ble_loop(); alert_loop(); ambient_loop(); gestures_loop(); anim_loop();
}

// Called for every host command line BEFORE the legacy handler chain. Return true if fully handled.
bool features_command(const String& c) {
  if (c.length() == 0) return false;
  host_seen();                       // any host traffic proves a host is there
  if (c == "HB") return true;        // heartbeat: silent, must NOT wake the deck or reply
  return live_command(c) || net_command(c) || ble_command(c) || alert_command(c) || ambient_command(c) || gestures_command(c) || anim_command(c);
}

// Run a button on the deck itself (called when no host is connected). Returns true if something executed.
bool standalone_button(int page, int idx, bool hasState, bool state) {
  if (net_standalone_mode() == 2) return false;   // standalone: "never" disables ALL on-deck execution (BLE and WiFi)
  JsonObject cfg = doc["pages"][page]["buttons"][idx];
  if (cfg.isNull()) return false;
  return ble_button(cfg, page, idx, hasState, state) || net_button(cfg, page, idx, hasState, state);
}

#endif
