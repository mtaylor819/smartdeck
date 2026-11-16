// gestures.h -- touch gestures: swipe to change page, long-press hold events
// OWNER: fork "ui". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
#ifndef GESTURES_H
#define GESTURES_H

void gestures_setup() {}
void gestures_loop() {}
bool gestures_command(const String& c) { return false; }
#endif
