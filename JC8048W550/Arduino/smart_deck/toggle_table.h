// toggle_table.h -- PURE fixed-size table of toggle-button states, keyed by page*100+idx (no Arduino types; unit-tested on a PC).
// Why: draw_page() rebuilds the button vectors and used to set every toggle to ON, so ANY full redraw (alert clear, BT toast removal,
// clamped swipe, wake, page change) silently flipped OFF toggles back to ON and the next press reported the wrong state.
// Only OFF states are stored (ON is the default), so the table stays tiny. The oldest entry is evicted when it is full.
#ifndef TOGGLE_TABLE_H
#define TOGGLE_TABLE_H
#include <stdint.h>

#define TOGGLE_MAX 64

struct ToggleSlot { int16_t key; bool used; uint32_t seq; };
static ToggleSlot toggle_tab[TOGGLE_MAX];
static uint32_t toggle_seq = 0;

static inline int16_t toggle_key(int page, int idx) { return (int16_t)(page * 100 + idx); }

static inline bool toggle_get(int page, int idx) {  // true = ON (default)
  int16_t k = toggle_key(page, idx);
  for (int i = 0; i < TOGGLE_MAX; i++) if (toggle_tab[i].used && toggle_tab[i].key == k) return false;
  return true;
}

static inline void toggle_clear(int page, int idx) {
  int16_t k = toggle_key(page, idx);
  for (int i = 0; i < TOGGLE_MAX; i++) if (toggle_tab[i].used && toggle_tab[i].key == k) toggle_tab[i].used = false;
}

static inline void toggle_set(int page, int idx, bool on) {
  if (page < 0 || page > 99 || idx < 0 || idx > 99) return;
  if (on) { toggle_clear(page, idx); return; }
  int16_t k = toggle_key(page, idx);
  int freeIdx = -1, oldest = -1;
  for (int i = 0; i < TOGGLE_MAX; i++) {
    if (toggle_tab[i].used) {
      if (toggle_tab[i].key == k) { toggle_tab[i].seq = ++toggle_seq; return; }
      if (oldest < 0 || toggle_tab[i].seq < toggle_tab[oldest].seq) oldest = i;
    } else if (freeIdx < 0) freeIdx = i;
  }
  int s = freeIdx >= 0 ? freeIdx : oldest;
  toggle_tab[s].used = true;
  toggle_tab[s].key = k;
  toggle_tab[s].seq = ++toggle_seq;
}

static inline void toggle_swap(int page, int a, int b) {  // SWAP_BTN moved the buttons: move their states with them
  bool sa = toggle_get(page, a), sb = toggle_get(page, b);
  toggle_set(page, a, sb);
  toggle_set(page, b, sa);
}

static inline int toggle_count() {
  int n = 0;
  for (int i = 0; i < TOGGLE_MAX; i++) n += toggle_tab[i].used ? 1 : 0;
  return n;
}
#endif
