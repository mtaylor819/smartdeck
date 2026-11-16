// led_alert.h -- LED-ring alerts (red alert etc.) and any on-screen alert banner
// OWNER: fork "led". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
#ifndef LED_ALERT_H
#define LED_ALERT_H

void alert_setup() {}
void alert_loop() {}
bool alert_command(const String& c) { return false; }
// Called by the ring-update code each frame BEFORE the normal knob/sleep animation. Return true if the alert
// painted the ring this frame (caller then skips its own painting but still calls strip.show()).
bool alert_render_ring() { return false; }
#endif
