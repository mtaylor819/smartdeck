// ble_keys.h -- pure (no Arduino/NimBLE dependencies) USB-HID key mapping for the BLE HID module.
// OWNER: fork "ble". Kept dependency-free so it can be unit-tested on a normal PC (see firmware/README.md).
//
//  * ble_parse_combo()   "cmd+shift+4" -> HID modifier bitmask + one HID keyboard usage (token names match
//                         companion-mac/src/keymap.ts, plus f1..f24 per PROTOCOL.md)
//  * ble_ascii_to_hid()  US-layout ASCII -> modifiers + usage (text typing)
//  * ble_media_usage()   "play_pause" etc. -> USB HID Consumer-page usage ID
#ifndef BLE_KEYS_H
#define BLE_KEYS_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define BLE_MOD_LCTRL  0x01
#define BLE_MOD_LSHIFT 0x02
#define BLE_MOD_LALT   0x04
#define BLE_MOD_LGUI   0x08  // Cmd on macOS, Windows key elsewhere

struct BleKeyName { const char* name; uint8_t usage; };

// Keyboard/Keypad page (0x07) usage IDs. Names are lowercase.
static const BleKeyName BLE_KEY_NAMES[] = {
  {"a", 0x04}, {"b", 0x05}, {"c", 0x06}, {"d", 0x07}, {"e", 0x08}, {"f", 0x09}, {"g", 0x0A}, {"h", 0x0B},
  {"i", 0x0C}, {"j", 0x0D}, {"k", 0x0E}, {"l", 0x0F}, {"m", 0x10}, {"n", 0x11}, {"o", 0x12}, {"p", 0x13},
  {"q", 0x14}, {"r", 0x15}, {"s", 0x16}, {"t", 0x17}, {"u", 0x18}, {"v", 0x19}, {"w", 0x1A}, {"x", 0x1B},
  {"y", 0x1C}, {"z", 0x1D},
  {"1", 0x1E}, {"2", 0x1F}, {"3", 0x20}, {"4", 0x21}, {"5", 0x22}, {"6", 0x23}, {"7", 0x24}, {"8", 0x25},
  {"9", 0x26}, {"0", 0x27},
  {"return", 0x28}, {"enter", 0x28}, {"escape", 0x29}, {"esc", 0x29},
  // Like keymap.ts: "delete"/"backspace" = the Backspace key (macOS calls it Delete); "del"/"forwarddelete" = forward delete.
  {"delete", 0x2A}, {"backspace", 0x2A}, {"tab", 0x2B}, {"space", 0x2C}, {"spacebar", 0x2C},
  {"-", 0x2D}, {"minus", 0x2D}, {"=", 0x2E}, {"plus", 0x2E}, {"[", 0x2F}, {"]", 0x30}, {"\\", 0x31},
  {";", 0x33}, {"'", 0x34}, {"`", 0x35}, {",", 0x36}, {".", 0x37}, {"/", 0x38},
  {"capslock", 0x39},
  {"f1", 0x3A}, {"f2", 0x3B}, {"f3", 0x3C}, {"f4", 0x3D}, {"f5", 0x3E}, {"f6", 0x3F}, {"f7", 0x40}, {"f8", 0x41},
  {"f9", 0x42}, {"f10", 0x43}, {"f11", 0x44}, {"f12", 0x45},
  {"printscreen", 0x46}, {"insert", 0x49},
  {"home", 0x4A}, {"pageup", 0x4B}, {"pgup", 0x4B}, {"forwarddelete", 0x4C}, {"del", 0x4C},
  {"end", 0x4D}, {"pagedown", 0x4E}, {"pgdn", 0x4E},
  {"right", 0x4F}, {"arrowright", 0x4F}, {"left", 0x50}, {"arrowleft", 0x50},
  {"down", 0x51}, {"arrowdown", 0x51}, {"up", 0x52}, {"arrowup", 0x52},
  {"f13", 0x68}, {"f14", 0x69}, {"f15", 0x6A}, {"f16", 0x6B}, {"f17", 0x6C}, {"f18", 0x6D}, {"f19", 0x6E},
  {"f20", 0x6F}, {"f21", 0x70}, {"f22", 0x71}, {"f23", 0x72}, {"f24", 0x73},
};

struct BleModName { const char* name; uint8_t bit; };
static const BleModName BLE_MOD_NAMES[] = {
  {"ctrl", BLE_MOD_LCTRL}, {"control", BLE_MOD_LCTRL},
  {"shift", BLE_MOD_LSHIFT},
  {"alt", BLE_MOD_LALT}, {"option", BLE_MOD_LALT}, {"opt", BLE_MOD_LALT},
  {"cmd", BLE_MOD_LGUI}, {"command", BLE_MOD_LGUI}, {"meta", BLE_MOD_LGUI}, {"win", BLE_MOD_LGUI}, {"super", BLE_MOD_LGUI},
};

static inline char ble_lower(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }

static inline int ble_find_key(const char* tok) {
  for (size_t i = 0; i < sizeof(BLE_KEY_NAMES) / sizeof(BLE_KEY_NAMES[0]); i++)
    if (strcmp(tok, BLE_KEY_NAMES[i].name) == 0) return BLE_KEY_NAMES[i].usage;
  return -1;
}
static inline int ble_find_mod(const char* tok) {
  for (size_t i = 0; i < sizeof(BLE_MOD_NAMES) / sizeof(BLE_MOD_NAMES[0]); i++)
    if (strcmp(tok, BLE_MOD_NAMES[i].name) == 0) return BLE_MOD_NAMES[i].bit;
  return -1;
}

// Parse a combo like "cmd+shift+4", "CTRL+ALT+DELETE", "f5", "cmd++". Exactly one non-modifier key is required
// (same rules as keymap.ts parseCombo). Returns false (outputs untouched) on any unknown token / bad shape.
static inline bool ble_parse_combo(const char* combo, uint8_t* mods_out, uint8_t* key_out) {
  if (!combo) return false;
  char tokens[8][16];
  int ntok = 0;
  char cur[16];
  size_t cl = 0;
  bool overflow = false;
  size_t len = strlen(combo);
  size_t end = len;
  while (end > 0 && (combo[end - 1] == ' ' || combo[end - 1] == '\t')) end--;
  bool trailingPlus = end > 0 && combo[end - 1] == '+';

  for (size_t i = 0; i <= len; i++) {
    char c = (i < len) ? combo[i] : '+';       // flush the last token with a virtual '+'
    if (c == '+') {
      cur[cl] = 0;
      if (cl > 0) {                             // empty tokens are dropped (like keymap.ts)
        if (ntok >= 8) return false;
        strcpy(tokens[ntok++], cur);
      }
      cl = 0;
      overflow = false;
    } else if (c != ' ' && c != '\t') {
      if (cl < sizeof(cur) - 1) cur[cl++] = ble_lower(c); else overflow = true;
      if (overflow) return false;
    }
  }
  // "cmd++" style: trailing '+' means the plus/equals key unless "plus" was already given.
  if (trailingPlus) {
    bool hasPlus = false;
    for (int i = 0; i < ntok; i++) if (strcmp(tokens[i], "plus") == 0) hasPlus = true;
    if (!hasPlus) {
      if (ntok >= 8) return false;
      strcpy(tokens[ntok++], "=");
    }
  }

  uint8_t mods = 0;
  int key = -1;
  for (int i = 0; i < ntok; i++) {
    int m = ble_find_mod(tokens[i]);
    if (m >= 0) { mods |= (uint8_t)m; continue; }
    int k = ble_find_key(tokens[i]);
    if (k < 0) return false;          // unknown key
    if (key >= 0) return false;       // more than one non-modifier key
    key = k;
  }
  if (key < 0) return false;          // modifiers only
  *mods_out = mods;
  *key_out = (uint8_t)key;
  return true;
}

// US-layout ASCII -> (modifiers, usage). Handles \n (Enter) and \t (Tab). Returns false for unsupported chars.
// NOTE: the HOST decides which character a usage produces; on a non-US keyboard layout symbols will differ.
static inline bool ble_ascii_to_hid(char c, uint8_t* mods, uint8_t* key) {
  *mods = 0;
  if (c >= 'a' && c <= 'z') { *key = (uint8_t)(0x04 + (c - 'a')); return true; }
  if (c >= 'A' && c <= 'Z') { *mods = BLE_MOD_LSHIFT; *key = (uint8_t)(0x04 + (c - 'A')); return true; }
  if (c >= '1' && c <= '9') { *key = (uint8_t)(0x1E + (c - '1')); return true; }
  if (c == '0') { *key = 0x27; return true; }
  switch (c) {
    case '\n': case '\r': *key = 0x28; return true;
    case '\t': *key = 0x2B; return true;
    case ' ': *key = 0x2C; return true;
    case '-': *key = 0x2D; return true;
    case '=': *key = 0x2E; return true;
    case '[': *key = 0x2F; return true;
    case ']': *key = 0x30; return true;
    case '\\': *key = 0x31; return true;
    case ';': *key = 0x33; return true;
    case '\'': *key = 0x34; return true;
    case '`': *key = 0x35; return true;
    case ',': *key = 0x36; return true;
    case '.': *key = 0x37; return true;
    case '/': *key = 0x38; return true;
    // shifted symbols
    case '!': *mods = BLE_MOD_LSHIFT; *key = 0x1E; return true;
    case '@': *mods = BLE_MOD_LSHIFT; *key = 0x1F; return true;
    case '#': *mods = BLE_MOD_LSHIFT; *key = 0x20; return true;
    case '$': *mods = BLE_MOD_LSHIFT; *key = 0x21; return true;
    case '%': *mods = BLE_MOD_LSHIFT; *key = 0x22; return true;
    case '^': *mods = BLE_MOD_LSHIFT; *key = 0x23; return true;
    case '&': *mods = BLE_MOD_LSHIFT; *key = 0x24; return true;
    case '*': *mods = BLE_MOD_LSHIFT; *key = 0x25; return true;
    case '(': *mods = BLE_MOD_LSHIFT; *key = 0x26; return true;
    case ')': *mods = BLE_MOD_LSHIFT; *key = 0x27; return true;
    case '_': *mods = BLE_MOD_LSHIFT; *key = 0x2D; return true;
    case '+': *mods = BLE_MOD_LSHIFT; *key = 0x2E; return true;
    case '{': *mods = BLE_MOD_LSHIFT; *key = 0x2F; return true;
    case '}': *mods = BLE_MOD_LSHIFT; *key = 0x30; return true;
    case '|': *mods = BLE_MOD_LSHIFT; *key = 0x31; return true;
    case ':': *mods = BLE_MOD_LSHIFT; *key = 0x33; return true;
    case '"': *mods = BLE_MOD_LSHIFT; *key = 0x34; return true;
    case '~': *mods = BLE_MOD_LSHIFT; *key = 0x35; return true;
    case '<': *mods = BLE_MOD_LSHIFT; *key = 0x36; return true;
    case '>': *mods = BLE_MOD_LSHIFT; *key = 0x37; return true;
    case '?': *mods = BLE_MOD_LSHIFT; *key = 0x38; return true;
  }
  return false;
}

// Consumer Control page (0x0C) usage IDs. Returns 0 for unknown names.
static inline uint16_t ble_media_usage(const char* name) {
  if (!name) return 0;
  if (strcmp(name, "play_pause") == 0) return 0x00CD;
  if (strcmp(name, "next") == 0) return 0x00B5;
  if (strcmp(name, "previous") == 0) return 0x00B6;
  if (strcmp(name, "volume_up") == 0) return 0x00E9;
  if (strcmp(name, "volume_down") == 0) return 0x00EA;
  if (strcmp(name, "mute") == 0) return 0x00E2;
  return 0;
}

#endif
