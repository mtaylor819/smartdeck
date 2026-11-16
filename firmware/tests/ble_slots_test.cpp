// Host-side unit test for ble_slots.h. Build/run (note -iquote, not -I: the sketch folder has a features.h that shadows glibc's):
//   g++ -std=c++17 -Wall -iquote JC8048W550/Arduino/smart_deck firmware/tests/ble_slots_test.cpp -o /tmp/ble_slots_test && /tmp/ble_slots_test
#include <cstdio>
#include <cstring>
#include "ble_slots.h"
static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); fails++; } } while (0)

int main() {
  // names
  CHECK(ble_slot_name_valid("Mac"));
  CHECK(ble_slot_name_valid("Work PC"));
  CHECK(ble_slot_name_valid("123456789012"));            // 12 = max
  CHECK(!ble_slot_name_valid("1234567890123"));          // 13
  CHECK(!ble_slot_name_valid(""));
  CHECK(!ble_slot_name_valid(nullptr));
  CHECK(!ble_slot_name_valid("tab\there"));
  CHECK(!ble_slot_name_valid("caf\xC3\xA9"));            // non-ASCII
  CHECK(ble_slot_name_valid("a\"b\\c"));                 // printable, escaped later in JSON

  // arg parsing + wrap
  CHECK(ble_slot_parse_arg("1", 3) == 1);
  CHECK(ble_slot_parse_arg("2", 1) == 2);
  CHECK(ble_slot_parse_arg("3", 1) == 3);
  CHECK(ble_slot_parse_arg("0", 1) == 0);
  CHECK(ble_slot_parse_arg("4", 1) == 0);
  CHECK(ble_slot_parse_arg("12", 1) == 0);
  CHECK(ble_slot_parse_arg("next", 1) == 2);
  CHECK(ble_slot_parse_arg("next", 2) == 3);
  CHECK(ble_slot_parse_arg("next", 3) == 1);             // wraps
  CHECK(ble_slot_parse_arg("NEXT", 3) == 1);
  CHECK(ble_slot_parse_arg("  next  ", 1) == 2);
  CHECK(ble_slot_parse_arg("next", 0) == 1);             // bogus current slot is tolerated
  CHECK(ble_slot_parse_arg("nextt", 1) == 0);
  CHECK(ble_slot_parse_arg("1 2", 1) == 0);
  CHECK(ble_slot_parse_arg("", 1) == 0);
  CHECK(ble_slot_parse_arg(nullptr, 1) == 0);
  CHECK(ble_slot_parse_arg("nextxxxxxxxxxxxx", 1) == 0); // longer than the token buffer

  // addresses: deterministic, distinct per slot and per chip, valid static-random
  const uint8_t macA[6] = {0x24, 0x6F, 0x28, 0xAA, 0xBB, 0xCC};
  const uint8_t macB[6] = {0x24, 0x6F, 0x28, 0xAA, 0xBB, 0xCD};
  uint8_t a2[6], a2b[6], a3[6], b2[6];
  ble_slot_addr(macA, 2, a2); ble_slot_addr(macA, 2, a2b); ble_slot_addr(macA, 3, a3); ble_slot_addr(macB, 2, b2);
  CHECK(memcmp(a2, a2b, 6) == 0);                        // stable across calls (=> across reboots)
  CHECK(memcmp(a2, a3, 6) != 0);                         // slots differ
  CHECK(memcmp(a2, b2, 6) != 0);                         // chips differ
  for (int s = 1; s <= 3; s++) {
    for (int m = 0; m < 2000; m++) {
      uint8_t mac[6] = {(uint8_t)m, (uint8_t)(m >> 8), (uint8_t)(m * 7), 0x11, (uint8_t)(m * 13), (uint8_t)(m * 31)};
      uint8_t a[6];
      ble_slot_addr(mac, s, a);
      CHECK((a[5] & 0xC0) == 0xC0);                      // static random
      int ones = 0;
      for (int i = 0; i < 5; i++) ones += __builtin_popcount(a[i]);
      ones += __builtin_popcount(a[5] & 0x3F);
      CHECK(ones != 0 && ones != 46);                    // BLE spec: random part not all 0 / all 1
    }
  }

  // JSON
  char names[BLE_SLOT_COUNT][BLE_SLOT_NAME_MAX + 1] = {"Mac", "Work PC", "iPad"};
  char out[96];
  size_t n = ble_slots_to_json(names, out, sizeof(out));
  CHECK(n == strlen(out));
  CHECK(strcmp(out, "[\"Mac\",\"Work PC\",\"iPad\"]") == 0);
  strcpy(names[0], "a\"b\\c");
  n = ble_slots_to_json(names, out, sizeof(out));
  CHECK(strcmp(out, "[\"a\\\"b\\\\c\",\"Work PC\",\"iPad\"]") == 0);
  char tiny[10];
  CHECK(ble_slots_to_json(names, tiny, sizeof(tiny)) == 0);   // does not fit -> 0, buffer still NUL-terminated
  CHECK(tiny[0] == 0);
  CHECK(ble_slots_to_json(names, out, 0) == 0);

  if (fails) { printf("%d FAILED\n", fails); return 1; }
  printf("all ok\n");
  return 0;
}
