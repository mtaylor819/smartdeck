// Host-side unit test for the v4 pure logic: pairing window / link approval (ble_pairing.h), the HID report map range (ble_report_map.h +
// ble_keys.h) and the toggle-state table (toggle_table.h). Build/run (note -iquote, not -I: the sketch folder has a features.h that shadows glibc's):
//   g++ -std=c++17 -Wall -Wextra -iquote JC8048W550/Arduino/smart_deck firmware/tests/ble_security_test.cpp -o /tmp/ble_security_test && /tmp/ble_security_test
#include <cstdio>
#include <cstring>
#include "ble_pairing.h"
#include "ble_report_map.h"
#include "ble_keys.h"
#include "toggle_table.h"

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); fails++; } } while (0)

// Minimal HID short-item walker: find the Logical Maximum / Usage Maximum that precede the 6-key Input(array) item (0x81, 0x00) in the keyboard
// collection, decoding the item size like a real host would (1/2/4 data bytes, Logical Maximum 0x25/0x26 as signed-if-1-byte is what hosts do).
struct KeyArray { long logMax; long usageMax; bool found; };
static KeyArray find_key_array(const uint8_t* m, size_t n) {
  KeyArray k = { 0, 0, false };
  long logMax = 0, usageMax = 0;
  size_t i = 0;
  while (i < n) {
    uint8_t b = m[i];
    int sz = (b & 3) == 3 ? 4 : (b & 3);
    uint8_t tag = b & 0xFC;
    long v = 0;
    for (int j = 0; j < sz; j++) v |= (long)m[i + 1 + j] << (8 * j);
    if (sz == 1 && tag == 0x24) { if (v & 0x80) v -= 256; }       // Logical Maximum, 1 byte: signed (the trap behind the 0x25,0xE7 bug)
    if (sz == 2 && tag == 0x24) { if (v & 0x8000) v -= 65536; }
    if (tag == 0x24) logMax = v;                                   // Logical Maximum
    if (tag == 0x28) usageMax = v;                                 // Usage Maximum
    if (tag == 0x80 && sz == 1 && m[i + 1] == 0x00) {              // Input (Data,Array,Abs): the key array
      k.logMax = logMax; k.usageMax = usageMax; k.found = true;
      return k;
    }
    i += 1 + sz;
  }
  return k;
}

int main() {
  // ---- pairing window state machine ---------------------------------------------------------------------------------------------
  BlePairWindow w;
  CHECK(!w.isOpen(1000));                                            // closed by default
  w.start(1000, 120);
  CHECK(w.isOpen(1000));
  CHECK(w.isOpen(1000 + 119999));
  CHECK(w.remainingSec(1000) == 120);
  CHECK(w.remainingSec(1000 + 60001) == 60);                         // rounds up
  CHECK(!w.isOpen(1000 + 120000));                                   // exactly at the deadline: closed
  CHECK(!w.isOpen(1000 + 120001));                                   // and stays closed (lazy expiry latched)
  w.start(5000, 10); w.close();
  CHECK(!w.isOpen(5001));                                            // explicit close
  w.start(0xFFFFFF00u, 2);                                           // millis() rollover mid-window must not break it
  CHECK(w.isOpen(0xFFFFFF00u + 100));
  CHECK(w.isOpen(0xFFFFFF00u + 1999));                               // still inside: wraps past 2^32
  CHECK(!w.isOpen(0xFFFFFF00u + 2000));
  w.start(10, 5); w.start(10, 300);                                  // re-opening extends it
  CHECK(w.remainingSec(10) == 300);

  // ---- BLE_PAIR argument parsing -------------------------------------------------------------------------------------------------
  int s = 0;
  CHECK(ble_pair_parse_seconds("1", &s) && s == 1);
  CHECK(ble_pair_parse_seconds("120", &s) && s == 120);
  CHECK(ble_pair_parse_seconds("300", &s) && s == 300);
  CHECK(!ble_pair_parse_seconds("0", &s));
  CHECK(!ble_pair_parse_seconds("301", &s));
  CHECK(!ble_pair_parse_seconds("-5", &s));
  CHECK(!ble_pair_parse_seconds("", &s));
  CHECK(!ble_pair_parse_seconds(nullptr, &s));
  CHECK(!ble_pair_parse_seconds("12abc", &s));
  CHECK(!ble_pair_parse_seconds("1 2", &s));
  CHECK(!ble_pair_parse_seconds("00005", &s));                       // >4 chars: rejected, not parsed as 5
  CHECK(!ble_pair_parse_seconds("99999999999999999999", &s));        // no overflow

  // ---- link approval -------------------------------------------------------------------------------------------------------------
  CHECK(ble_auth_verdict(true, true, false) == BLE_V_ACCEPT);        // encrypted + bonded outside the window: an existing bond reconnecting
  CHECK(ble_auth_verdict(true, true, true) == BLE_V_ACCEPT);         // ... or a new bond made inside the window
  CHECK(ble_auth_verdict(true, false, false) == BLE_V_KICK);         // stranger outside the window: Just-Works encryption WITHOUT a bond (bonding is off)
  CHECK(ble_auth_verdict(true, false, true) == BLE_V_ACCEPT);        // inside the window the bonded flag may lag the encryption event: don't kick a first pairing
  CHECK(ble_auth_verdict(false, true, false) == BLE_V_KICK);         // never accept an unencrypted link
  CHECK(ble_auth_verdict(false, true, true) == BLE_V_KICK);
  CHECK(ble_auth_verdict(false, false, true) == BLE_V_KICK);         // failed pairing, even inside the window
  CHECK(ble_auth_verdict(false, false, false) == BLE_V_KICK);
  CHECK(!ble_link_expired(false, 1000, 1000 + BLE_UNAUTH_KICK_MS - 1));
  CHECK(ble_link_expired(false, 1000, 1000 + BLE_UNAUTH_KICK_MS));   // idle stranger is dropped after 15 s
  CHECK(!ble_link_expired(true, 1000, 1000 + 10 * BLE_UNAUTH_KICK_MS));   // approved links are never expired
  CHECK(ble_link_expired(false, 0xFFFFFF00u, (uint32_t)(0xFFFFFF00u + BLE_UNAUTH_KICK_MS)));  // rollover safe
  CHECK(ble_auto_window_wanted(0, false));                           // first time, no bonds: open
  CHECK(!ble_auto_window_wanted(0, true));                           // already used once
  CHECK(!ble_auto_window_wanted(1, false));                          // a bond exists: no automatic window
  CHECK(ble_send_allowed(1, 0));
  CHECK(!ble_send_allowed(0, 0));                                    // nobody approved
  CHECK(!ble_send_allowed(1, 1));                                    // a stranger is on an encrypted link: hold ALL reports until it is kicked
  CHECK(!ble_send_allowed(0, 1));
  CHECK(ble_send_allowed(2, 0));

  // ---- HID report map: keyboard usages up to 0xE7, read the way a host reads them ------------------------------------------------
  KeyArray ka = find_key_array(BLE_REPORT_MAP, sizeof(BLE_REPORT_MAP));
  CHECK(ka.found);
  CHECK(ka.logMax == 0xE7);                                          // NOT -25: the 2-byte Logical Maximum form is required
  CHECK(ka.usageMax == 0xE7);
  int maxUsage = 0;
  for (size_t i = 0; i < sizeof(BLE_KEY_NAMES) / sizeof(BLE_KEY_NAMES[0]); i++) if (BLE_KEY_NAMES[i].usage > maxUsage) maxUsage = BLE_KEY_NAMES[i].usage;
  CHECK(maxUsage == 0x73);                                           // f24
  CHECK(maxUsage <= ka.logMax && maxUsage <= ka.usageMax);           // every key we can send is inside the declared range (the M4 bug)
  CHECK(ble_find_key("f13") == 0x68 && ble_find_key("f19") == 0x6E && ble_find_key("f24") == 0x73);
  // structure sanity: the map still ends both collections and contains both report IDs
  int ends = 0, ids = 0;
  for (size_t i = 0; i < sizeof(BLE_REPORT_MAP); i++) if (BLE_REPORT_MAP[i] == 0xC0) ends++;
  for (size_t i = 0; i + 1 < sizeof(BLE_REPORT_MAP); i++) if (BLE_REPORT_MAP[i] == 0x85) ids++;
  CHECK(ends == 2 && ids == 2);

  // ---- toggle table (M3) ---------------------------------------------------------------------------------------------------------
  CHECK(toggle_get(0, 3));                                           // default ON
  toggle_set(0, 3, false);
  CHECK(!toggle_get(0, 3));                                          // OFF survives (this is what a full redraw used to reset)
  CHECK(toggle_get(0, 4) && toggle_get(1, 3));                       // other buttons / other pages unaffected
  toggle_set(1, 3, false);
  CHECK(!toggle_get(0, 3) && !toggle_get(1, 3));                     // per page
  toggle_set(0, 3, true);
  CHECK(toggle_get(0, 3) && !toggle_get(1, 3));
  CHECK(toggle_count() == 1);                                        // only OFF states are stored
  toggle_set(0, 3, false); toggle_set(0, 3, false);
  CHECK(toggle_count() == 2);                                        // setting twice does not burn a second slot
  toggle_clear(0, 3); toggle_clear(1, 3);
  CHECK(toggle_count() == 0);
  toggle_set(2, 1, false);
  toggle_swap(2, 1, 5);                                              // SWAP_BTN moves the state with the button
  CHECK(toggle_get(2, 1) && !toggle_get(2, 5));
  toggle_clear(2, 5);
  // eviction: more OFF toggles than slots: oldest is dropped, the table never overflows or corrupts
  for (int i = 0; i < TOGGLE_MAX + 10; i++) toggle_set(i / 50, i % 50, false);
  CHECK(toggle_count() == TOGGLE_MAX);
  CHECK(toggle_get(0, 0));                                           // the oldest entries were evicted (back to the default ON)
  CHECK(!toggle_get((TOGGLE_MAX + 9) / 50, (TOGGLE_MAX + 9) % 50));  // the newest survives
  toggle_set(-1, 0, false); toggle_set(0, 100, false); toggle_set(100, 0, false);   // out-of-range keys are ignored
  CHECK(toggle_count() == TOGGLE_MAX);

  printf(fails ? "SOME TESTS FAILED (%d)\n" : "all ok\n", fails);
  return fails ? 1 : 0;
}
