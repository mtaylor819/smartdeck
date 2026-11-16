// ambient.h -- ambient-light sensor auto-dim
// OWNER: fork "led". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
#ifndef AMBIENT_H
#define AMBIENT_H

void ambient_setup() {}
void ambient_loop() {}
bool ambient_command(const String& c) { return false; }
#endif
