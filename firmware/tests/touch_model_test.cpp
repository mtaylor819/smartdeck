// Host model of the touch block of smart_deck.ino (loop(), "3. TOUCH SCREEN") + the alert hook + gestures_touch(), driven with concrete touch
// sequences. It uses the REAL gesture_logic.h. Each scenario runs twice: OLD (the behaviour before the v4 review fixes) and NEW (after), so the
// findings M1/M2 can be seen reproduced and fixed. Build/run:
//   g++ -std=c++17 -Wall -Wextra -iquote JC8048W550/Arduino/smart_deck firmware/tests/touch_model_test.cpp -o /tmp/touch_model_test && /tmp/touch_model_test
// This is a MODEL of the .ino logic (kept line-for-line close to it), not the firmware itself: update it together with the touch block.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "gesture_logic.h"

static bool FIXED = true;  // false = pre-fix behaviour

static unsigned long ms = 1000;
static bool alert_on = false, alert_swallow = false, alert_armed = false;
static bool was_touched = false, long_press_triggered = false;
static int last_btn = -1;
static unsigned long last_valid = 0, t_start = 0;
static std::vector<std::string> out;
static int current_page = 0;
static GestureCfg gcfg;
static GestureTracker gtr;
static bool hold_consumed = false;

static bool holdlookup(int b) { return b == 2; }  // button 2 has hold:true
static const char* action_of(int b) { return b == 5 ? "counter" : "key"; }

// led_alert.h alert_touch_ack()
static bool alert_touch_ack(bool touched) {
  if (alert_on) {
    if (FIXED) {
      if (!touched) { alert_armed = true; return false; }
      if (!alert_armed) return true;                       // M1: touch began before the alert: swallow, no ack
    } else if (!touched) {
      return false;
    }
    out.push_back("ALERT_ACK");
    alert_on = false;
    alert_swallow = true;
    return true;
  }
  if (alert_swallow) {
    if (touched) return true;
    alert_swallow = false;
  }
  return false;
}

static void gestures_reset() { gtr = GestureTracker(); hold_consumed = false; }

// gestures.h gestures_touch()
static bool gestures_touch(bool touching, bool cv, int tx, int ty, int btn) {
  GestureOut o = gtr.update(touching, cv, tx, ty, btn, ms, gcfg, holdlookup);
  if (o.holdFire && !long_press_triggered) {
    out.push_back("BTN_HOLD:" + std::to_string(o.holdBtn));
    long_press_triggered = true;
    if (FIXED) hold_consumed = true;
  }
  if (FIXED && hold_consumed) {                            // M2
    if (touching) return true;
    hold_consumed = false;
  }
  if (o.swipe) {
    current_page += o.swipe;
    out.push_back("PAGE_CHANGED:" + std::to_string(current_page));
    last_btn = -1;
    long_press_triggered = false;
    return true;
  }
  return false;
}

// one poll: rawTouch, x,y (-1 = no coords), btn under finger
static void poll(bool raw, int x, int y, int btn) {
  ms += 10;
  if (raw) last_valid = ms;
  bool now = (ms - last_valid < 50);
  if (alert_touch_ack(now)) {
    now = false;
    last_valid = 0;
    if (FIXED) {                                           // M1: cancel the press in flight + forget gesture state
      last_btn = -1;
      was_touched = false;
      long_press_triggered = false;
      gestures_reset();
    }
  }
  int cur = -1;
  if (x > 0 && y > 0) cur = btn;
  else if (now && last_btn != -1) cur = last_btn;
  if (gestures_touch(now, x > 0 && y > 0, x, y, cur)) {
  } else if (now && cur != -1 && last_btn != cur) {        // A. press
    t_start = ms;
    long_press_triggered = false;
    last_btn = cur;
  } else if (now && cur != -1 && cur == last_btn) {        // B. hold
    if (!long_press_triggered && ms - t_start > 800 && std::string(action_of(cur)) == "counter") {
      out.push_back("COUNTER_RESET");
      long_press_triggered = true;
    }
  } else if (!now && was_touched) {                        // C. release
    if (last_btn != -1) {
      if (!long_press_triggered) out.push_back(std::string("BTN:") + std::to_string(last_btn));
      last_btn = -1;
    }
  }
  was_touched = now;
}

static void hold_finger(int n, int x, int y, int b) { for (int i = 0; i < n; i++) poll(true, x, y, b); }
static void lift(int n = 8) { for (int i = 0; i < n; i++) poll(false, -1, -1, -1); }

static std::string run(void (*f)()) {
  out.clear();
  was_touched = false; long_press_triggered = false; last_btn = -1; last_valid = 0;
  alert_on = false; alert_swallow = false; alert_armed = false; hold_consumed = false; current_page = 0;
  gtr = GestureTracker();
  ms += 2000;
  f();
  std::string s;
  for (auto& x : out) s += (s.empty() ? "" : " ") + x;
  return s.empty() ? "(nothing)" : s;
}

static int fails = 0;
static void scenario(const char* name, void (*f)(), const char* expectOld, const char* expectNew) {
  FIXED = false; std::string o = run(f);
  FIXED = true;  std::string n = run(f);
  bool okOld = o == expectOld, okNew = n == expectNew;
  printf("%-58s OLD: %-34s NEW: %s%s\n", name, o.c_str(), n.c_str(), (okOld && okNew) ? "" : "   <-- UNEXPECTED");
  if (!okOld) { printf("   expected OLD: %s\n", expectOld); fails++; }
  if (!okNew) { printf("   expected NEW: %s\n", expectNew); fails++; }
}

int main() {
  scenario("tap button 1", [] { hold_finger(5, 100, 100, 1); lift(); }, "BTN:1", "BTN:1");
  scenario("swipe left across buttons (300 ms) = next page", [] { for (int i = 0; i < 30; i++) poll(true, 500 - i * 10, 100, (i < 12) ? 1 : -1); lift(); },
           "PAGE_CHANGED:1", "PAGE_CHANGED:1");
  scenario("hold btn 2 for 700 ms then release", [] { hold_finger(70, 100, 100, 2); lift(); }, "BTN_HOLD:2", "BTN_HOLD:2");
  scenario("tap btn 2 briefly (hold:true) -> normal BTN", [] { hold_finger(10, 100, 100, 2); lift(); }, "BTN:2", "BTN:2");
  scenario("M2: hold btn 2, then slide onto btn 3 and release", [] { hold_finger(65, 100, 100, 2); for (int i = 0; i < 10; i++) poll(true, 120, 100, 3); lift(); },
           "BTN_HOLD:2 BTN:3", "BTN_HOLD:2");
  scenario("counter btn 5 held 1 s -> reset only", [] { hold_finger(100, 100, 100, 5); lift(); }, "COUNTER_RESET", "COUNTER_RESET");
  scenario("M1: alert arrives while finger is mid-press on btn 1", [] { hold_finger(5, 100, 100, 1); alert_on = true; hold_finger(2, 100, 100, 1); lift(); },
           "ALERT_ACK BTN:1", "(nothing)");
  scenario("M1: ...and the NEXT deliberate tap then acknowledges it", [] { hold_finger(5, 100, 100, 1); alert_on = true; hold_finger(2, 100, 100, 1); lift(); hold_finger(5, 100, 100, 1); lift(); },
           "ALERT_ACK BTN:1 BTN:1", "ALERT_ACK");
  scenario("alert up, no finger, then a new tap on btn 1 (ack only)", [] { alert_on = true; lift(); hold_finger(5, 100, 100, 1); lift(); },
           "ALERT_ACK", "ALERT_ACK");
  scenario("alert up, ack, finger STAYS down 2 s then lifts", [] { alert_on = true; lift(); hold_finger(200, 100, 100, 1); lift(); },
           "ALERT_ACK", "ALERT_ACK");
  scenario("M1: alert arrives mid-swipe: no page change, no ack", [] {
             for (int i = 0; i < 10; i++) poll(true, 500 - i * 10, 100, -1);
             alert_on = true;
             for (int i = 10; i < 30; i++) poll(true, 500 - i * 10, 100, -1);
             lift(); },
           "ALERT_ACK", "(nothing)");
  scenario("swipe too slow (900 ms): falls back to stock release", [] { for (int i = 0; i < 90; i++) poll(true, 400 - i * 3, 100, 1); lift(); },
           "BTN:1", "BTN:1");

  printf(fails ? "SOME SCENARIOS UNEXPECTED (%d)\n" : "all ok\n", fails);
  return fails ? 1 : 0;
}
