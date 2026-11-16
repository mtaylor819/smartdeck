// gesture_logic.h -- PURE gesture logic (no Arduino/ESP types) so it can be unit-tested on a PC with g++.
// OWNER: fork "ui". Used by gestures.h. Rules come from companion-mac/PROTOCOL.md (Gestures).
#ifndef GESTURE_LOGIC_H
#define GESTURE_LOGIC_H

#define GESTURE_SWIPE_MIN_PX 120
#define GESTURE_SWIPE_MAX_MS 700UL
#define GESTURE_HOLD_MOVE_PX 40   // finger may drift this far and still count as a hold

// Classify a finished touch as a swipe. dx/dy in px (end - start), dtMs = duration of real contact.
// Returns +1 = swipe LEFT (next page), -1 = swipe RIGHT (previous page), 0 = not a swipe.
inline int gesture_classify_swipe(int dx, int dy, unsigned long dtMs) {
  int adx = dx < 0 ? -dx : dx;
  int ady = dy < 0 ? -dy : dy;
  if (dtMs > GESTURE_SWIPE_MAX_MS) return 0;
  if (adx < GESTURE_SWIPE_MIN_PX) return 0;
  if (adx <= 2 * ady) return 0;  // need |dx| > 2|dy|: mostly horizontal
  return dx < 0 ? +1 : -1;
}

struct GestureCfg {
  bool swipe = true;
  unsigned long holdMs = 600;
};

struct GestureOut {
  int swipe = 0;         // +1 next page, -1 previous page, 0 none (set on the poll where the finger lifts)
  bool holdFire = false; // emit BTN_HOLD once
  int holdBtn = -1;      // button index for holdFire
};

typedef bool (*GestureHoldLookup)(int btn);  // does this button have "hold":true ? (called once per button entered)

// Fed once per touch poll (every ~10 ms), whether or not the finger is down.
//  touching   : debounced "finger is on the screen"
//  coordValid : tx/ty are real coordinates this poll
//  btn        : index of the button under the finger, or -1
struct GestureTracker {
  bool active = false;
  bool haveStart = false;
  int x0 = 0, y0 = 0, x = 0, y = 0;
  unsigned long t0 = 0, tLast = 0;
  // hold state (per button the finger is on)
  int holdBtn = -2;  // -2 = nothing evaluated yet this touch
  bool holdCapable = false, holdFired = false;
  unsigned long holdT0 = 0;
  int hx0 = 0, hy0 = 0;

  GestureOut update(bool touching, bool coordValid, int tx, int ty, int btn, unsigned long now,
                    const GestureCfg& cfg, GestureHoldLookup lookup) {
    GestureOut o;
    if (touching) {
      if (!active) {
        active = true;
        haveStart = false;
        t0 = now;
        tLast = now;
        holdBtn = -2;
        holdCapable = false;
        holdFired = false;
      }
      if (coordValid) {
        if (!haveStart) {
          haveStart = true;
          x0 = tx;
          y0 = ty;
        }
        x = tx;
        y = ty;
        tLast = now;
      }
      // Entered a (new) button: re-evaluate whether it supports hold and restart its hold timer.
      if (btn != holdBtn) {
        holdBtn = btn;
        holdCapable = (btn >= 0 && lookup != 0 && lookup(btn));
        holdFired = false;
        holdT0 = now;
        hx0 = x;
        hy0 = y;
      }
      if (holdCapable && !holdFired && haveStart) {
        int mx = x - hx0, my = y - hy0;
        if (mx < 0) mx = -mx;
        if (my < 0) my = -my;
        if (mx >= GESTURE_HOLD_MOVE_PX || my >= GESTURE_HOLD_MOVE_PX) {
          holdCapable = false;  // finger moved: not a hold
        } else if (now - holdT0 >= cfg.holdMs) {
          holdFired = true;
          o.holdFire = true;
          o.holdBtn = btn;
        }
      }
    } else if (active) {
      active = false;
      if (cfg.swipe && haveStart && !holdFired) o.swipe = gesture_classify_swipe(x - x0, y - y0, tLast - t0);
      haveStart = false;
    }
    return o;
  }
};

#endif
