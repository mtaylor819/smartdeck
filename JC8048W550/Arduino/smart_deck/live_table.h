// live_table.h -- RAM-only per-button display overrides ("live buttons") + HA state -> display mapping.
// OWNER: fork "fw-live". Pure C++ (no Arduino/ArduinoJson dependencies) so it can be unit-tested on a PC:
//   g++ -std=c++11 -I<this dir> test.cpp
//
// WHY A FIXED TABLE: SET_BTN_LIVE arrives continuously (CPU %, printer progress, HA state...). Storing the values in the
// ArduinoJson document would allocate new strings on every update and never free the old ones (heap leak) and would
// also be persisted to the SD card by the next saveConfigToSD(). Instead: a static array of LIVE_MAX entries with fixed
// char buffers. Nothing here ever allocates, so heap use is constant by construction no matter how many updates arrive.
//
// Included at the TOP of smart_deck.ino (before draw_single_button, which consults live_find()).
#ifndef LIVE_TABLE_H
#define LIVE_TABLE_H

#include <stdint.h>
#include <string.h>
#include <stdlib.h>

// If 1, buttons that have NO icon and no live label draw their configured "label" as text. The stock firmware never
// draws label text for normal buttons (label_text = NULL; the Windows app bakes the label into the icon JPG), which makes
// icon-less buttons from the Mac app appear blank. Set to 0 to restore the exact stock behaviour.
#ifndef LIVE_LABEL_FALLBACK
#define LIVE_LABEL_FALLBACK 1
#endif

#define LIVE_MAX 24         // table entries (>= 24 per PROTOCOL.md); oldest is evicted when full
#define LIVE_LABEL_MAX 24   // characters
#define LIVE_ICON_MAX 40    // characters

enum {
  LIVE_F_LABEL = 1,
  LIVE_F_LCOLOR = 2,
  LIVE_F_BTN = 4,
  LIVE_F_SIZE = 8,
  LIVE_F_ICON = 16
};

struct LiveOv {
  bool used;
  int16_t key;       // page * 100 + idx
  uint8_t flags;     // which fields below are set (LIVE_F_*)
  uint8_t labelSize; // 8..40 px (mapped to a font size by the sketch)
  uint16_t lcolor;   // RGB565
  uint16_t btn;      // RGB565
  uint32_t seq;      // monotonically increasing; lowest = oldest
  char label[LIVE_LABEL_MAX + 1];
  char icon[LIVE_ICON_MAX + 1];
};

// A parsed update (what one SET_BTN_LIVE / one HA poll wants to change). `clear` removes previously-set fields.
struct LiveUpdate {
  uint8_t flags;
  uint8_t clear;
  uint8_t labelSize;
  uint16_t lcolor;
  uint16_t btn;
  char label[LIVE_LABEL_MAX + 1];
  char icon[LIVE_ICON_MAX + 1];
};

static LiveOv live_tab[LIVE_MAX];
static uint32_t live_seq = 0;

static inline void live_update_init(LiveUpdate* u) { memset(u, 0, sizeof(*u)); }

// ---- validation / parsing -------------------------------------------------------------------------------------
static inline int live_hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Strict "rrggbb" (exactly 6 hex digits, no '#', no whitespace) -> RGB565. Returns false on anything else.
static inline bool live_hex6(const char* s, uint16_t* out565) {
  if (!s) return false;
  uint32_t v = 0;
  for (int i = 0; i < 6; i++) {
    int h = live_hexval(s[i]);
    if (h < 0) return false;
    v = (v << 4) | (uint32_t)h;
  }
  if (s[6] != '\0') return false;
  uint8_t r = (v >> 16) & 0xFF, g = (v >> 8) & 0xFF, b = v & 0xFF;
  *out565 = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
  return true;
}

// Copy `in` to `out` keeping printable ASCII; the UTF-8 degree sign (C2 B0) becomes 0xF8 (the degree glyph in the built-in
// GFX font); everything else non-ASCII is dropped. At most `maxChars` output chars. Returns the output length.
static inline size_t live_sanitize_label(const char* in, char* out, size_t maxChars) {
  size_t n = 0;
  if (!in) { out[0] = '\0'; return 0; }
  for (size_t i = 0; in[i] && n < maxChars; i++) {
    unsigned char c = (unsigned char)in[i];
    if (c >= 0x20 && c <= 0x7E) out[n++] = (char)c;
    else if (c == 0xC2 && (unsigned char)in[i + 1] == 0xB0) { out[n++] = (char)0xF8; i++; }
  }
  out[n] = '\0';
  return n;
}

// Icon file names: [A-Za-z0-9._-]{1,40}, no "..", must not start with '.'. (The sketch prepends "/".)
static inline bool live_icon_ok(const char* s) {
  if (!s) return false;
  size_t n = strlen(s);
  if (n < 1 || n > LIVE_ICON_MAX || s[0] == '.') return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!ok) return false;
    if (c == '.' && s[i + 1] == '.') return false;
  }
  return true;
}

// Entity ids: lowercase [a-z0-9_] domain "." object_id, <= 64 chars.
static inline bool live_entity_ok(const char* s) {
  if (!s) return false;
  size_t n = strlen(s);
  if (n < 3 || n > 64) return false;
  int dots = 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (c == '.') { if (++dots > 1 || i == 0 || i == n - 1) return false; continue; }
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
  }
  return dots == 1;
}

// ---- the table -------------------------------------------------------------------------------------------------
static inline const LiveOv* live_find(int page, int idx) {
  int16_t key = (int16_t)(page * 100 + idx);
  for (int i = 0; i < LIVE_MAX; i++)
    if (live_tab[i].used && live_tab[i].key == key) return &live_tab[i];
  return nullptr;
}

static inline LiveOv* live_slot_for(int page, int idx) {
  int16_t key = (int16_t)(page * 100 + idx);
  int freeIdx = -1, oldest = 0;
  for (int i = 0; i < LIVE_MAX; i++) {
    if (live_tab[i].used) {
      if (live_tab[i].key == key) return &live_tab[i];
      if (live_tab[i].seq < live_tab[oldest].seq || !live_tab[oldest].used) oldest = i;
    } else if (freeIdx < 0) {
      freeIdx = i;
    }
  }
  int s = freeIdx >= 0 ? freeIdx : oldest;  // table full: evict the oldest
  memset(&live_tab[s], 0, sizeof(live_tab[s]));
  live_tab[s].used = true;
  live_tab[s].key = key;
  return &live_tab[s];
}

// Merge an update into the table. Returns true if anything the user can SEE changed (so the caller knows to redraw).
static inline bool live_commit(int page, int idx, const LiveUpdate& u) {
  if (page < 0 || page > 99 || idx < 0 || idx > 99) return false;
  if (!u.flags && !u.clear) return false;
  const LiveOv* cur = live_find(page, idx);
  if (!cur && !u.flags) return false;  // clear-only update for a button without an entry: don't burn a slot
  LiveOv before;
  if (cur) before = *cur; else memset(&before, 0, sizeof(before));
  LiveOv* o = live_slot_for(page, idx);
  o->seq = ++live_seq;
  if (u.clear) o->flags &= (uint8_t)~u.clear;
  if (u.flags & LIVE_F_LABEL) { memcpy(o->label, u.label, sizeof(o->label)); o->label[LIVE_LABEL_MAX] = '\0'; o->flags |= LIVE_F_LABEL; }
  if (u.flags & LIVE_F_ICON) { memcpy(o->icon, u.icon, sizeof(o->icon)); o->icon[LIVE_ICON_MAX] = '\0'; o->flags |= LIVE_F_ICON; }
  if (u.flags & LIVE_F_LCOLOR) { o->lcolor = u.lcolor; o->flags |= LIVE_F_LCOLOR; }
  if (u.flags & LIVE_F_BTN) { o->btn = u.btn; o->flags |= LIVE_F_BTN; }
  if (u.flags & LIVE_F_SIZE) { o->labelSize = u.labelSize; o->flags |= LIVE_F_SIZE; }
  if (before.flags != o->flags) return true;
  if ((o->flags & LIVE_F_LABEL) && strcmp(before.label, o->label) != 0) return true;
  if ((o->flags & LIVE_F_ICON) && strcmp(before.icon, o->icon) != 0) return true;
  if ((o->flags & LIVE_F_LCOLOR) && before.lcolor != o->lcolor) return true;
  if ((o->flags & LIVE_F_BTN) && before.btn != o->btn) return true;
  if ((o->flags & LIVE_F_SIZE) && before.labelSize != o->labelSize) return true;
  return false;
}

static inline int live_count() {
  int n = 0;
  for (int i = 0; i < LIVE_MAX; i++) n += live_tab[i].used ? 1 : 0;
  return n;
}

// ---- Home Assistant state -> display ---------------------------------------------------------------------------
// Per-button "ha_state" configuration (parsed from the button JSON by the HA poller).
struct LiveHaCfg {
  uint8_t has;  // bit0 on colour, bit1 off colour, bit2 label_on, bit3 label_off
  uint16_t on565, off565;
  char label_on[LIVE_LABEL_MAX + 1];
  char label_off[LIVE_LABEL_MAX + 1];
};
#define LIVE_HA_H_ON 1
#define LIVE_HA_H_OFF 2
#define LIVE_HA_H_LABEL_ON 4
#define LIVE_HA_H_LABEL_OFF 8

#define LIVE_HA_GREY 0x3186  // dim grey (~#333333) for unavailable / unknown / error

// state: HA's state string, or "" / nullptr when the request failed. Fields not configured are CLEARED so the button's own
// colour/label comes back (e.g. after a period of "unavailable").
static inline void live_ha_map(const char* state, const LiveHaCfg& cfg, LiveUpdate* u) {
  live_update_init(u);
  bool on = state && strcmp(state, "on") == 0;
  bool off = state && strcmp(state, "off") == 0;
  if (on || off) {
    bool hasCol = (cfg.has & (on ? LIVE_HA_H_ON : LIVE_HA_H_OFF)) != 0;
    bool hasLbl = (cfg.has & (on ? LIVE_HA_H_LABEL_ON : LIVE_HA_H_LABEL_OFF)) != 0;
    if (hasCol) { u->btn = on ? cfg.on565 : cfg.off565; u->flags |= LIVE_F_BTN; } else u->clear |= LIVE_F_BTN;
    if (hasLbl) { strncpy(u->label, on ? cfg.label_on : cfg.label_off, LIVE_LABEL_MAX); u->label[LIVE_LABEL_MAX] = '\0'; u->flags |= LIVE_F_LABEL; }
    else u->clear |= LIVE_F_LABEL;
  } else {  // unavailable / unknown / anything else / request failed
    u->btn = LIVE_HA_GREY; u->flags |= LIVE_F_BTN;
    strcpy(u->label, "?"); u->flags |= LIVE_F_LABEL;
  }
}

#endif
