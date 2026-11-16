// ble_hid.h -- BLE HID keyboard/consumer-control so the deck works standalone on any machine
// OWNER: fork "ble". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
#ifndef BLE_HID_H
#define BLE_HID_H

// Cross-module API used by net_wifi.h (CONTRACT, keep these signatures):
const char* ble_state_str() { return "off"; }
String ble_peer_str() { return ""; }

void ble_setup() {}
void ble_loop() {}
bool ble_command(const String& c) { return false; }
// Standalone button execution via BLE HID (key/text/media). Return true if executed.
bool ble_button(JsonObject cfg, int page, int idx, bool hasState, bool state) { return false; }
#endif
