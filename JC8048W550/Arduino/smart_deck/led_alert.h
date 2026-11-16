// led_alert.h -- LED-ring alerts (red alert etc.) and the on-screen alert banner
// OWNER: fork "led". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract.
//
//   ALERT:<red|yellow|blue|green>:<seconds>[:<text>]   start (seconds 0 = until ALERT:off / acknowledged; green 0 -> 3 s)
//   ALERT:off                                          clear
//   ALERT_ACK:<kind>                                   deck -> host when a touch acknowledges the alert
//   ALERT:err:<reason>                                 deck -> host on a malformed ALERT command
//
// Smart_deck.ino hooks (both marked "[led-alert hook]"):
//   1. LED loop:   `if (alert_render_ring()) { } else if (is_sleeping) {`   (ring is painted by the alert)
//   2. touch loop: `if (alert_touch_ack(is_touched_now)) { is_touched_now = false; last_valid_touch_time = 0; }`
#ifndef LED_ALERT_H
#define LED_ALERT_H

#define ALERT_TEXT_MAX 24

static bool alert_on = false;
static bool alert_swallow_touch = false;  // after an ack, ignore the finger until it lifts (so it can't press a button)
static bool alert_armed = false;          // M1: only a touch that BEGAN after the alert appeared may acknowledge it (armed by a finger-up poll)
static char alert_kind = 'r';             // 'r' red, 'y' yellow, 'b' blue, 'g' green
static bool alert_flash = true;           // banner phase (red alternates bright/dark)
static unsigned long alert_start_ms = 0;
static unsigned long alert_end_ms = 0;  // 0 = no timeout
static unsigned long alert_last_banner_ms = 0;
static char alert_text[ALERT_TEXT_MAX + 1] = "";

static const char* alert_kind_name(char k) {
  switch (k) {
    case 'r': return "red";
    case 'y': return "yellow";
    case 'b': return "blue";
    default: return "green";
  }
}

static const char* alert_title(char k) {
  switch (k) {
    case 'r': return "RED ALERT";
    case 'y': return "YELLOW ALERT";
    case 'b': return "NOTICE";
    default: return "ALL CLEAR";
  }
}

// LCARS-style pill across the header area (y 5..45). Cheap: one rounded rect + a few chars. Repainted periodically so it also
// self-heals if something (e.g. a SET_BTN_DATA page redraw) paints over it.
static void alert_draw_banner() {
  uint16_t fill, txt = 0x0000;
  switch (alert_kind) {
    case 'r':
      fill = alert_flash ? gfx->color565(255, 30, 30) : gfx->color565(110, 0, 0);
      txt = alert_flash ? 0x0000 : 0xFFFF;
      break;
    case 'y': fill = gfx->color565(255, 170, 0); break;
    case 'b': fill = gfx->color565(80, 190, 255); break;
    default: fill = gfx->color565(60, 220, 90); break;
  }
  const int x = 8, y = 5, h = 40, w = screenWidth - 16;
  gfx->fillRoundRect(x, y, w, h, h / 2, fill);
  gfx->setTextSize(3);
  gfx->setTextColor(txt);
  gfx->setCursor(x + 28, y + 8);
  gfx->print(alert_title(alert_kind));
  if (alert_text[0]) {
    gfx->print("  ");
    gfx->print(alert_text);
  }
  gfx->setTextSize(2);
}

static void alert_clear(bool redraw) {
  if (!alert_on) return;
  alert_on = false;
  // Repaint the page to remove the banner. While dimmed/deep-sleeping the wake path redraws it anyway.
  if (redraw && !is_sleeping && !is_deep_sleeping) draw_page(current_page);
}

static void alert_start(char kind, long seconds, const char* text) {
  alert_on = true;
  alert_armed = false;  // a finger that is already down must not acknowledge (or press anything): wait for a lift first
  alert_kind = kind;
  alert_flash = true;
  alert_start_ms = millis();
  alert_end_ms = seconds > 0 ? alert_start_ms + (unsigned long)seconds * 1000UL : 0;
  strncpy(alert_text, text, ALERT_TEXT_MAX);
  alert_text[ALERT_TEXT_MAX] = '\0';
  update_activity();  // wake screen + LEDs (also leaves deep sleep and redraws the page), THEN paint the banner on top
  alert_draw_banner();
  alert_last_banner_ms = millis();
}

void alert_setup() {}

void alert_loop() {
  if (!alert_on) return;
  unsigned long now = millis();
  if (alert_end_ms != 0 && (long)(now - alert_end_ms) >= 0) {
    alert_clear(true);
    return;
  }
  last_activity_time = now;  // keep the deck awake (no dim/deep sleep) while an alert is showing
  unsigned long period = (alert_kind == 'r') ? 167UL : 1000UL;  // red flashes ~3 Hz; others just refresh
  if (now - alert_last_banner_ms >= period) {
    alert_flash = !alert_flash;
    alert_draw_banner();
    alert_last_banner_ms = now;
  }
}

bool alert_command(const String& c) {
  if (!c.startsWith("ALERT:")) return false;
  String s = c.substring(6);
  if (s == "off") {
    alert_clear(true);
    return true;
  }
  int i1 = s.indexOf(':');
  String kindStr = i1 < 0 ? s : s.substring(0, i1);
  String rest = i1 < 0 ? "" : s.substring(i1 + 1);
  char kind = 0;
  if (kindStr == "red") kind = 'r';
  else if (kindStr == "yellow") kind = 'y';
  else if (kindStr == "blue") kind = 'b';
  else if (kindStr == "green") kind = 'g';
  if (!kind) {
    Serial.println("ALERT:err:kind");
    return true;
  }
  int i2 = rest.indexOf(':');
  String secStr = i2 < 0 ? rest : rest.substring(0, i2);
  String txtStr = i2 < 0 ? "" : rest.substring(i2 + 1);
  secStr.trim();
  // L2: digits only. toInt() turns garbage ("abc", "12x") into 0 = "until acknowledged", i.e. a never-expiring alert from a typo.
  bool secDigits = secStr.length() <= 4;
  for (unsigned int k = 0; secDigits && k < secStr.length(); k++) if (secStr[k] < '0' || secStr[k] > '9') secDigits = false;
  long seconds = secStr.length() ? secStr.toInt() : 0;
  if (!secDigits || seconds < 0 || seconds > 3600) {
    Serial.println("ALERT:err:seconds");
    return true;
  }
  if (kind == 'g' && seconds == 0) seconds = 3;  // green is a brief "all clear" sweep
  char text[ALERT_TEXT_MAX + 1];
  int n = 0;
  for (unsigned int k = 0; k < txtStr.length() && n < ALERT_TEXT_MAX; k++) {
    char ch = txtStr[k];
    if (ch < 0x20 || ch > 0x7E) ch = '?';
    else if (ch == ':') ch = ' ';
    text[n++] = ch;
  }
  text[n] = '\0';
  alert_start(kind, seconds, text);
  return true;
}

// Paint the 16-LED ring for the active alert. Returns false when no alert is active (caller paints normally).
// Called by the ring update every LED_INTERVAL (50 ms); the caller has already done strip.clear() and calls strip.show().
bool alert_render_ring() {
  if (!alert_on) return false;
  unsigned long t = millis() - alert_start_ms;
  switch (alert_kind) {
    case 'r': {  // fast flashing red, ~3 Hz, 60% duty
      uint8_t v = (t % 333UL) < 200UL ? 255 : 10;
      for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, strip.Color(v, 0, 0));
      break;
    }
    case 'y': {  // slower amber pulse, 1.6 s
      float s = 0.5f + 0.5f * sinf((float)(t % 1600UL) * (2.0f * PI / 1600.0f) - (PI / 2.0f));
      int v = 40 + (int)(215.0f * s);
      for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, strip.Color(v, (v * 6) / 10, 0));
      break;
    }
    case 'b': {  // gentle cyan breathe, 4 s
      float s = 0.5f + 0.5f * sinf((float)(t % 4000UL) * (2.0f * PI / 4000.0f) - (PI / 2.0f));
      int v = 20 + (int)(200.0f * s);
      for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, strip.Color(0, (v * 7) / 10, v));
      break;
    }
    default: {  // green sweep: 4-LED comet once around the ring per second
      float pos = (float)(t % 1000UL) / 1000.0f * (float)LED_COUNT;
      for (int i = 0; i < LED_COUNT; i++) {
        float d = pos - (float)i;
        while (d < 0.0f) d += (float)LED_COUNT;
        while (d >= (float)LED_COUNT) d -= (float)LED_COUNT;
        if (d < 4.0f) {
          float f = 1.0f - d / 4.0f;
          int v = (int)(255.0f * f * f);
          strip.setPixelColor(i, strip.Color(0, v, v / 4));
        }
      }
      break;
    }
  }
  return true;
}

// Touch hook (called every touch poll with the debounced "finger is down" state).
// Returns true while the touch must be swallowed: the touch that acknowledges an alert, and the rest of that same press.
bool alert_is_active() { return alert_on; }  // used by ble_hid.h's pairing indicator (declared there; this header is included later)

bool alert_touch_ack(bool touched) {
  if (alert_on) {
    if (!touched) {
      alert_armed = true;  // finger is up: the NEXT touch is a deliberate one and may acknowledge
      return false;
    }
    if (!alert_armed) return true;  // M1: the touch began before the alert: swallow it, do not acknowledge, do not press the button under it
    Serial.printf("ALERT_ACK:%s\n", alert_kind_name(alert_kind));
    alert_clear(true);
    alert_swallow_touch = true;
    return true;
  }
  if (alert_swallow_touch) {
    if (touched) return true;
    alert_swallow_touch = false;  // finger lifted
  }
  return false;
}
#endif
