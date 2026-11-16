// net_wifi.h -- WiFi STA, mDNS, TCP host link, OTA, NTP, standalone HA/HTTP actions
// OWNER: fork "net". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
#ifndef NET_WIFI_H
#define NET_WIFI_H

void net_setup() {}
void net_loop() {}
bool net_command(const String& c) { return false; }   // return true if handled
// Standalone button execution (no host connected). cfg = this button's JSON from esp_config.json. Return true if executed.
bool net_button(JsonObject cfg, int page, int idx, bool hasState, bool state) { return false; }
#endif
