#include <cstdio>
#include <cstdlib>
#include <string>
#include "ble_keys.h"
static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); fails++; } } while (0)
static bool P(const char* s, int m, int k) { uint8_t mm = 0xEE, kk = 0xEE; bool ok = ble_parse_combo(s, &mm, &kk); return ok && mm == m && kk == k; }
static bool Bad(const char* s) { uint8_t mm = 0xEE, kk = 0xEE; bool ok = !ble_parse_combo(s, &mm, &kk); return ok && mm == 0xEE && kk == 0xEE; }
int main(int argc, char** argv) {
  if (argc > 1) { // cross-check mode: each arg must parse (as a lone key, or "mod+a" with --mod)
    int bad = 0;
    for (int i = 1; i < argc; i++) {
      uint8_t m, k;
      std::string s = argv[i];
      if (s.rfind("mod:", 0) == 0) s = s.substr(4) + "+a";
      if (!ble_parse_combo(s.c_str(), &m, &k)) { printf("not supported: %s\n", argv[i]); bad++; }
    }
    printf("cross-check: %d unsupported of %d\n", bad, argc - 1);
    return bad ? 1 : 0;
  }
  CHECK(P("cmd+shift+4", BLE_MOD_LGUI | BLE_MOD_LSHIFT, 0x21));
  CHECK(P("CTRL+ALT+DELETE", BLE_MOD_LCTRL | BLE_MOD_LALT, 0x2A)); // delete = Backspace, as in keymap.ts
  CHECK(P("ctrl+alt+del", BLE_MOD_LCTRL | BLE_MOD_LALT, 0x4C));
  CHECK(P("f5", 0, 0x3E));
  CHECK(P("F24", 0, 0x73));
  CHECK(P("cmd++", BLE_MOD_LGUI, 0x2E));
  CHECK(P("cmd+plus", BLE_MOD_LGUI, 0x2E));
  CHECK(P(" cmd + c ", BLE_MOD_LGUI, 0x06));
  CHECK(P("win+e", BLE_MOD_LGUI, 0x08));
  CHECK(P("ctrl+up", BLE_MOD_LCTRL, 0x52));
  CHECK(P("ctrl+cmd+q", BLE_MOD_LCTRL | BLE_MOD_LGUI, 0x14));
  CHECK(P("shift+shift+a", BLE_MOD_LSHIFT, 0x04));
  CHECK(P("cmd+/", BLE_MOD_LGUI, 0x38));
  CHECK(P("space", 0, 0x2C));
  CHECK(Bad("cmd+banana"));
  CHECK(Bad("cmd+shift"));
  CHECK(Bad("a+b"));
  CHECK(Bad(""));
  CHECK(P("+", 0, 0x2E));   // same as keymap.ts: trailing '+' => '=' key
  CHECK(Bad("averyveryverylongtokenname+a"));
  CHECK(!ble_parse_combo(nullptr, nullptr, nullptr));
  uint8_t m, k;
  CHECK(ble_ascii_to_hid('a', &m, &k) && m == 0 && k == 0x04);
  CHECK(ble_ascii_to_hid('Z', &m, &k) && m == BLE_MOD_LSHIFT && k == 0x1D);
  CHECK(ble_ascii_to_hid('0', &m, &k) && k == 0x27 && m == 0);
  CHECK(ble_ascii_to_hid('!', &m, &k) && m == BLE_MOD_LSHIFT && k == 0x1E);
  CHECK(ble_ascii_to_hid('\n', &m, &k) && k == 0x28);
  CHECK(!ble_ascii_to_hid((char)0xE9, &m, &k));
  for (int c = 0x20; c < 0x7F; c++) CHECK(ble_ascii_to_hid((char)c, &m, &k)); // every printable ASCII char maps
  CHECK(ble_media_usage("play_pause") == 0xCD && ble_media_usage("mute") == 0xE2 && ble_media_usage("volume_up") == 0xE9);
  CHECK(ble_media_usage("nope") == 0 && ble_media_usage(nullptr) == 0);
  printf(fails ? "FAILED %d\n" : "all ok\n", fails);
  return fails ? 1 : 0;
}
