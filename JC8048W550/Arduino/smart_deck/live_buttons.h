// live_buttons.h -- SET_BTN_LIVE command + single-button redraw glue.
// OWNER: fork "fw-live". The data structure lives in live_table.h (pure logic, included at the top of smart_deck.ino).
// Included from features.h before net_wifi.h. See companion-mac/PROTOCOL.md "Live button updates (RAM only)".
//
// SET_BTN_LIVE:<page>:<idx>:<json>   json keys: label, labelColor, btnColor, labelSize, icon   (all optional, others ignored)
//   * RAM only: never touches the SD card, never calls update_activity() (never wakes the deck), no reply.
//   * features_command() calls live_command() first and returns true, so the legacy catch-all wake path
//     (`else if (!command.startsWith("SET_TIME:") && ...) update_activity()`) never sees this command.
#ifndef LIVE_BUTTONS_H
#define LIVE_BUTTONS_H

// Redraw ONE button if it is visible right now (current page, awake). Otherwise the override is simply applied the next
// time draw_page()/draw_single_button() runs (they consult live_find()).
static void live_redraw(int page, int idx) {
  if (page != current_page || is_sleeping || is_deep_sleeping) return;
  if (idx < 0 || idx >= (int)current_buttons.size() || !current_buttons[idx].defined) return;
  draw_single_button(idx);
}

// Strict small-integer parse of c[from..to) ("12" ok; "", "-1", "1x" rejected). Returns -1 on failure.
static int live_parse_uint(const String& c, int from, int to) {
  if (to <= from || to - from > 3) return -1;
  int v = 0;
  for (int i = from; i < to; i++) {
    char ch = c[i];
    if (ch < '0' || ch > '9') return -1;
    v = v * 10 + (ch - '0');
  }
  return v;
}

bool live_command(const String& c) {
  if (!c.startsWith("SET_BTN_LIVE:")) return false;
  // From here on the command is ALWAYS consumed (return true): malformed input is silently ignored, and the legacy
  // chain (which would wake the deck) must not see it.
  if (c.length() > 700) return true;
  int p1 = c.indexOf(':');
  int p2 = c.indexOf(':', p1 + 1);
  int p3 = c.indexOf(':', p2 + 1);
  if (p1 < 0 || p2 < 0 || p3 < 0) return true;
  int page = live_parse_uint(c, p1 + 1, p2);
  int idx = live_parse_uint(c, p2 + 1, p3);
  if (page < 0 || page > 99 || idx < 0 || idx > 99) return true;

  JsonDocument d;  // transient (freed at end of scope): bounded by the 700-byte command cap
  if (deserializeJson(d, c.c_str() + p3 + 1)) return true;
  if (!d.is<JsonObject>()) return true;

  LiveUpdate u;
  live_update_init(&u);
  if (d["label"].is<const char*>()) {
    live_sanitize_label(d["label"].as<const char*>(), u.label, LIVE_LABEL_MAX);
    u.flags |= LIVE_F_LABEL;  // an empty (after sanitising) label is valid: it blanks the text
  }
  if (d["labelColor"].is<const char*>() && live_hex6(d["labelColor"].as<const char*>(), &u.lcolor)) u.flags |= LIVE_F_LCOLOR;
  if (d["btnColor"].is<const char*>() && live_hex6(d["btnColor"].as<const char*>(), &u.btn)) u.flags |= LIVE_F_BTN;
  if (d["labelSize"].is<int>()) {
    int s = d["labelSize"].as<int>();
    if (s >= 8 && s <= 40) {
      u.labelSize = (uint8_t)s;
      u.flags |= LIVE_F_SIZE;
    }
  }
  if (d["icon"].is<const char*>() && live_icon_ok(d["icon"].as<const char*>())) {
    strncpy(u.icon, d["icon"].as<const char*>(), LIVE_ICON_MAX);
    u.icon[LIVE_ICON_MAX] = '\0';
    u.flags |= LIVE_F_ICON;
  }
  if (live_commit(page, idx, u)) live_redraw(page, idx);
  return true;
}

#endif
