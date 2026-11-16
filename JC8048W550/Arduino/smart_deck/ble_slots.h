// ble_slots.h -- pure (no Arduino/NimBLE dependencies) helpers for the BLE host-slot feature, unit-testable on a PC.
// OWNER: fork "fw-blehost". Used by ble_hid.h.
//
//  * ble_slot_name_valid()  slot names: 1..12 printable ASCII
//  * ble_slot_parse_arg()   "1" | "2" | "3" | "next" -> slot number (1..3), 0 if invalid
//  * ble_slot_addr()        deterministic static-random BLE identity address for slot 2/3 from the chip MAC
//  * ble_slots_to_json()    ["Mac","Work PC","iPad"] with JSON escaping
#ifndef BLE_SLOTS_H
#define BLE_SLOTS_H

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#define BLE_SLOT_COUNT 3
#define BLE_SLOT_NAME_MAX 12

static inline bool ble_slot_name_valid(const char* n) {
  size_t l = n ? strlen(n) : 0;
  if (l < 1 || l > BLE_SLOT_NAME_MAX) return false;
  for (size_t i = 0; i < l; i++) if ((unsigned char)n[i] < 0x20 || (unsigned char)n[i] > 0x7E) return false;
  return true;
}

// Parse the argument of BLE_HOST:<arg> / a button's "slot". `cur` is the current slot (1..3), used for "next" (wraps 3 -> 1).
// Accepts surrounding spaces and any case for "next". Returns 0 for anything else.
static inline int ble_slot_parse_arg(const char* arg, int cur) {
  if (!arg) return 0;
  while (*arg == ' ') arg++;
  char b[8];
  size_t n = 0;
  while (arg[n] && arg[n] != ' ' && n < sizeof(b) - 1) { char c = arg[n]; b[n] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; n++; }
  b[n] = 0;
  const char* rest = arg + n;
  while (*rest == ' ') rest++;
  if (*rest) return 0;                                   // trailing junk (or an over-long token)
  if (n == 1 && b[0] >= '1' && b[0] <= '0' + BLE_SLOT_COUNT) return b[0] - '0';
  if (strcmp(b, "next") == 0) return (cur >= 1 && cur <= BLE_SLOT_COUNT) ? (cur % BLE_SLOT_COUNT) + 1 : 1;
  return 0;
}

// Static random address (little-endian like NimBLE's ble_addr_t.val: out[5] is the most significant byte).
// Stable for a given (mac, slot) so a host that bonded to it can find the deck again after any reboot. The two top bits of
// out[5] are 0b11 (static random) and the random part is never all-zeros or all-ones, as the BLE spec requires.
static inline void ble_slot_addr(const uint8_t mac[6], int slot, uint8_t out[6]) {
  uint32_t h[2];
  for (int k = 0; k < 2; k++) {
    uint32_t x = 2166136261u ^ (uint32_t)(0x11 * (k + 1));       // FNV-1a over mac + slot, two different seeds
    for (int i = 0; i < 6; i++) { x ^= mac[i]; x *= 16777619u; }
    x ^= (uint32_t)slot; x *= 16777619u;
    x ^= (uint32_t)(0xA5 + k); x *= 16777619u;
    h[k] = x;
  }
  out[0] = (uint8_t)h[0]; out[1] = (uint8_t)(h[0] >> 8); out[2] = (uint8_t)(h[0] >> 16); out[3] = (uint8_t)(h[0] >> 24);
  out[4] = (uint8_t)h[1]; out[5] = (uint8_t)(h[1] >> 8);
  out[5] = (uint8_t)((out[5] & 0x3F) | 0xC0);
  if ((out[0] | out[1] | out[2] | out[3] | out[4]) == 0 && (out[5] & 0x3F) == 0) out[0] = 1;                       // all zeros
  if ((out[0] & out[1] & out[2] & out[3] & out[4]) == 0xFF && (out[5] & 0x3F) == 0x3F) out[0] = 0xFE;             // all ones
}

// Write names as a JSON array of strings into out. Returns the length (excluding NUL), or 0 if it did not fit.
static inline size_t ble_slots_to_json(const char names[BLE_SLOT_COUNT][BLE_SLOT_NAME_MAX + 1], char* out, size_t cap) {
  size_t p = 0;
  auto put = [&](char c) { if (p + 1 < cap) out[p] = c; p++; };
  put('[');
  for (int i = 0; i < BLE_SLOT_COUNT; i++) {
    if (i) put(',');
    put('"');
    for (const char* s = names[i]; *s; s++) {
      if (*s == '"' || *s == '\\') put('\\');
      put(*s);
    }
    put('"');
  }
  put(']');
  if (cap == 0 || p + 1 > cap) { if (cap) out[0] = 0; return 0; }
  out[p] = 0;
  return p;
}

#endif
