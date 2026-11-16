// anim.h -- animated sleep screens
// OWNER: fork "ui". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
#ifndef ANIM_H
#define ANIM_H

void anim_setup() {}
void anim_loop() {}
bool anim_command(const String& c) { return false; }
#endif
