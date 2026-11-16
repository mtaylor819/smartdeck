// ble_hid.h -- BLE HID keyboard + media keys so the deck works standalone on any machine (Mac/Windows/iPad/phone)
// OWNER: fork "ble". Only this file (+ ble_keys.h and the vendored NimBLE-Arduino library) implements this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// Wire contract: companion-mac/PROTOCOL.md  (SET_BLE, BLE fields of NET_STATUS, device button JSON key/text/media).
//
// Behaviour summary
//  * Disabled until configured: stock behaviour is unchanged until `SET_BLE:{"enabled":true}` arrives (persisted in
//    Preferences namespace "ble": en / name).
//  * Just-Works pairing with bonding (bonds persisted by NimBLE in NVS), advertises as a keyboard (appearance 0x03C1).
//  * ble_button(): runs type key / text / media buttons over BLE, only while a host is connected. Typing is queued and
//    pumped from ble_loop() (never blocks).
//  * Radio note: WiFi and BLE share the one 2.4 GHz radio; the ESP32 coexistence layer time-slices them. Expect slightly
//    higher HID latency while WiFi is busy (e.g. during an OTA upload). Both are fully supported together by the core.
#ifndef BLE_HID_H
#define BLE_HID_H

#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>
#include "ble_keys.h"

// ---- Cross-module API used by net_wifi.h (CONTRACT, keep these signatures) -------------------------------------
enum BleState : uint8_t { BLE_ST_OFF = 0, BLE_ST_ADV = 1, BLE_ST_CONN = 2 };

static volatile BleState ble_st = BLE_ST_OFF;
static char ble_peer[20] = "";

const char* ble_state_str() {
  switch (ble_st) {
    case BLE_ST_ADV: return "advertising";
    case BLE_ST_CONN: return "connected";
    default: return "off";
  }
}
String ble_peer_str() { return String(ble_peer); }

// ---- State -------------------------------------------------------------------------------------------------------
static bool ble_enabled = false;                 // persisted ("ble"/"en"); default off until SET_BLE
static char ble_name[25] = "SmartDeck";          // persisted ("ble"/"name"), 1..24 printable ASCII
static bool ble_running = false;                 // NimBLE stack initialised
static volatile bool ble_status_dirty = false;   // set from NimBLE callbacks; main loop emits net_status_changed()
static bool ble_clear_bonds_pending = false;     // SET_BLE clear_bonds while stack was down
static unsigned long ble_last_adv_check = 0;

static NimBLEServer* ble_server = nullptr;
static NimBLEHIDDevice* ble_hid = nullptr;
static NimBLECharacteristic* ble_kb_in = nullptr;      // report ID 1: keyboard
static NimBLECharacteristic* ble_media_in = nullptr;   // report ID 2: consumer control

// HID report map: keyboard (ID 1: 1 modifier byte, 1 reserved, 6 key slots, LED output) + consumer control (ID 2: one 16-bit usage).
static const uint8_t BLE_REPORT_MAP[] = {
  0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,          // Usage Page (Generic Desktop), Usage (Keyboard), Collection, Report ID 1
  0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02,                      // 8 modifier bits (Input)
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01,                      // reserved byte
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02,  // 5 LED bits (Output)
  0x95, 0x01, 0x75, 0x03, 0x91, 0x01,                      // LED padding
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65,
  0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,          // 6 key slots (Input, array)
  0xC0,
  0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x02,          // Usage Page (Consumer), Usage (Consumer Control), Report ID 2
  0x15, 0x00, 0x26, 0xFF, 0x03, 0x19, 0x00, 0x2A, 0xFF, 0x03,
  0x75, 0x10, 0x95, 0x01, 0x81, 0x00,                      // one 16-bit usage (Input, array)
  0xC0
};

// ---- Outgoing event queue (combos / media) + text job -----------------------------------------------------------
struct BleEv { uint8_t kind; uint8_t mods; uint8_t key; uint16_t usage; uint16_t gap_ms; };  // kind 0 = keyboard, 1 = media
#define BLE_QSIZE 48
static BleEv ble_q[BLE_QSIZE];
static uint8_t ble_q_head = 0, ble_q_count = 0;
static String ble_text;                          // pending text to type (US layout)
static size_t ble_text_pos = 0;
static bool ble_text_release_next = false;       // text phase: false = press next char, true = release it
static unsigned long ble_next_due = 0;
static uint8_t ble_send_fail = 0;

#define BLE_TEXT_MAX 1024
#define BLE_GAP_TEXT_MS 10       // press->release and release->next-char spacing for typing
#define BLE_GAP_COMBO_MS 30      // hold time for hotkeys (some apps ignore sub-20ms taps)
#define BLE_GAP_RELEASE_MS 10

static void ble_queue_clear() {
  ble_q_head = 0; ble_q_count = 0;
  ble_text = ""; ble_text_pos = 0; ble_text_release_next = false;
  ble_send_fail = 0;
}
static bool ble_q_push(const BleEv& e) {
  if (ble_q_count >= BLE_QSIZE) return false;
  ble_q[(ble_q_head + ble_q_count) % BLE_QSIZE] = e;
  ble_q_count++;
  return true;
}

// ---- Persistence ------------------------------------------------------------------------------------------------
static bool ble_name_valid(const char* n) {
  size_t l = n ? strlen(n) : 0;
  if (l < 1 || l > 24) return false;
  for (size_t i = 0; i < l; i++) if (n[i] < 0x20 || n[i] > 0x7E) return false;
  return true;
}
static void ble_load() {
  Preferences p;
  if (!p.begin("ble", false)) return;
  ble_enabled = p.getBool("en", false);
  String n = p.getString("name", "SmartDeck");
  p.end();
  if (ble_name_valid(n.c_str())) strncpy(ble_name, n.c_str(), sizeof(ble_name) - 1);
  ble_name[sizeof(ble_name) - 1] = 0;
}
static void ble_save() {
  Preferences p;
  if (!p.begin("ble", false)) return;
  p.putBool("en", ble_enabled);
  p.putString("name", ble_name);
  p.end();
}

// ---- NimBLE callbacks (run on the NimBLE host task: only set flags / copy small data here) ----------------------
class BleServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, ble_gap_conn_desc* desc) override {
    NimBLEAddress a(desc->peer_ota_addr);
    strncpy(ble_peer, a.toString().c_str(), sizeof(ble_peer) - 1);
    ble_peer[sizeof(ble_peer) - 1] = 0;
    ble_st = BLE_ST_CONN;
    ble_status_dirty = true;
  }
  void onDisconnect(NimBLEServer* s) override {
    ble_peer[0] = 0;
    ble_st = ble_running ? BLE_ST_ADV : BLE_ST_OFF;   // NimBLEServer re-advertises on disconnect by default
    ble_status_dirty = true;
  }
};
static BleServerCb ble_server_cb;

// ---- Start / stop -----------------------------------------------------------------------------------------------
static void ble_start() {
  if (ble_running) return;
  NimBLEDevice::init(ble_name);
  NimBLEDevice::setSecurityAuth(true, false, true);          // bonding, no MITM (Just Works), LE Secure Connections
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  if (ble_clear_bonds_pending) { NimBLEDevice::deleteAllBonds(); ble_clear_bonds_pending = false; }

  ble_server = NimBLEDevice::createServer();
  ble_server->setCallbacks(&ble_server_cb);
  ble_hid = new NimBLEHIDDevice(ble_server);
  ble_kb_in = ble_hid->inputReport(1);
  ble_media_in = ble_hid->inputReport(2);
  ble_hid->outputReport(1);                                  // keyboard LED report (written by host, ignored)
  ble_hid->manufacturer()->setValue("SmartDeck");
  ble_hid->pnp(0x02, 0x303A, 0x4001, 0x0100);                // USB-IF vendor-ID source, Espressif VID
  ble_hid->hidInfo(0x00, 0x01);
  ble_hid->reportMap((uint8_t*)BLE_REPORT_MAP, sizeof(BLE_REPORT_MAP));
  ble_hid->startServices();
  ble_hid->setBatteryLevel(100);

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setAppearance(0x03C1);                                // HID keyboard
  adv->addServiceUUID(ble_hid->hidService()->getUUID());
  adv->setScanResponse(true);
  adv->start();

  ble_running = true;
  ble_st = BLE_ST_ADV;
  ble_status_dirty = true;
  Serial.printf("BLE: advertising as \"%s\" (bonds: %d, free heap %u)\n", ble_name, NimBLEDevice::getNumBonds(), (unsigned)ESP.getFreeHeap());
}

static void ble_stop() {
  if (!ble_running) return;
  NimBLEDevice::stopAdvertising();
  ble_queue_clear();
  delete ble_hid;                    // our wrapper; the services themselves are owned by the server
  ble_hid = nullptr; ble_kb_in = nullptr; ble_media_in = nullptr; ble_server = nullptr;
  NimBLEDevice::deinit(true);        // frees the host stack + server objects; stored bonds stay in NVS
  ble_running = false;
  ble_st = BLE_ST_OFF;
  ble_peer[0] = 0;
  ble_status_dirty = true;
  Serial.println("BLE: stopped");
}

// ---- Module API -------------------------------------------------------------------------------------------------
void ble_setup() {
  ble_load();
  if (ble_enabled) ble_start();
}

static bool ble_notify_kb(uint8_t mods, uint8_t key) {
  if (!ble_kb_in) return false;
  uint8_t r[8] = { mods, 0, key, 0, 0, 0, 0, 0 };
  if (ble_kb_in->getSubscribedCount() == 0) return false;   // host hasn't enabled notifications yet (pairing in progress)
  ble_kb_in->setValue(r, sizeof(r));
  ble_kb_in->notify();                                       // NimBLE 1.4.3: void, no delivery feedback
  return true;
}
static bool ble_notify_media(uint16_t usage) {
  if (!ble_media_in) return false;
  uint8_t r[2] = { (uint8_t)(usage & 0xFF), (uint8_t)(usage >> 8) };
  if (ble_media_in->getSubscribedCount() == 0) return false;
  ble_media_in->setValue(r, sizeof(r));
  ble_media_in->notify();
  return true;
}

void ble_loop() {
  if (ble_status_dirty) {                 // tell the net module (emits NET_STATUS, rate-limited there)
    ble_status_dirty = false;
    net_status_changed();
  }
  if (!ble_running) return;
  unsigned long now = millis();

  if (ble_st != BLE_ST_CONN) {            // not connected: drop anything pending, make sure we're advertising
    if (ble_q_count || ble_text.length()) ble_queue_clear();
    if (now - ble_last_adv_check > 2000) {
      ble_last_adv_check = now;
      NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
      if (!adv->isAdvertising()) { adv->start(); }
      if (ble_st != BLE_ST_ADV) { ble_st = BLE_ST_ADV; ble_status_dirty = true; }
    }
    return;
  }

  if ((int32_t)(now - ble_next_due) < 0) return;

  // Next HID event: queued combos/media first, then the text job (press, release, press, ...).
  BleEv e;
  bool have = false, from_queue = false;
  if (ble_q_count) {
    e = ble_q[ble_q_head];
    have = true; from_queue = true;
  } else if (ble_text_pos < ble_text.length()) {
    if (ble_text_release_next) {
      e = { 0, 0, 0, 0, BLE_GAP_TEXT_MS };
      have = true;
    } else {
      uint8_t m = 0, k = 0;
      char c = ble_text[ble_text_pos];
      if (ble_ascii_to_hid(c, &m, &k)) {
        e = { 0, m, k, 0, BLE_GAP_TEXT_MS };
        have = true;
      } else {
        ble_text_pos++;                   // unsupported character: skip it
        return;
      }
    }
  } else if (ble_text.length()) {
    ble_text = ""; ble_text_pos = 0;      // job finished: free the buffer
  }
  if (!have) return;

  bool ok = (e.kind == 0) ? ble_notify_kb(e.mods, e.key) : ble_notify_media(e.usage);
  if (!ok) {                              // host not subscribed to this report yet: retry shortly, give up after a while
    ble_next_due = now + 15;
    if (++ble_send_fail > 40) { ble_queue_clear(); Serial.println("BLE: dropping input (host not accepting reports)"); }
    return;
  }
  ble_send_fail = 0;
  ble_next_due = now + e.gap_ms;
  if (from_queue) { ble_q_head = (ble_q_head + 1) % BLE_QSIZE; ble_q_count--; }
  else if (ble_text_release_next) { ble_text_release_next = false; ble_text_pos++; }
  else { ble_text_release_next = true; }
}

bool ble_command(const String& c) {
  if (!c.startsWith("SET_BLE:")) return false;
  JsonDocument d;
  if (deserializeJson(d, c.substring(8)) != DeserializationError::Ok || !d.is<JsonObject>()) {
    Serial.println("BLE_SET:err:bad_json");
    return true;
  }
  bool hasEn = !d["enabled"].isNull(), hasName = !d["name"].isNull(), clear = d["clear_bonds"] | false;
  if (!hasEn && !hasName && !clear) { Serial.println("BLE_SET:err:no_fields"); return true; }
  if (hasEn && !d["enabled"].is<bool>()) { Serial.println("BLE_SET:err:bad_enabled"); return true; }
  const char* nm = nullptr;
  if (hasName) {
    if (!d["name"].is<const char*>() || !ble_name_valid(d["name"].as<const char*>())) { Serial.println("BLE_SET:err:bad_name"); return true; }
    nm = d["name"].as<const char*>();
  }

  bool newEnabled = hasEn ? d["enabled"].as<bool>() : ble_enabled;
  bool renamed = nm && strcmp(nm, ble_name) != 0;
  if (nm) { strncpy(ble_name, nm, sizeof(ble_name) - 1); ble_name[sizeof(ble_name) - 1] = 0; }
  ble_enabled = newEnabled;
  ble_save();

  if (ble_running && (!newEnabled || renamed)) ble_stop();     // rename needs a stack restart (name is set at init)
  if (clear) {
    if (ble_running) NimBLEDevice::deleteAllBonds(); else ble_clear_bonds_pending = true;   // applied at next start
  }
  if (newEnabled && !ble_running) ble_start();
  Serial.println("BLE_SET:ok");
  return true;
}

// Standalone button execution via BLE HID (key/text/media). Return true if executed (or queued).
bool ble_button(JsonObject cfg, int page, int idx, bool hasState, bool state) {
  if (!ble_running || ble_st != BLE_ST_CONN) return false;     // let the other modules / host path handle it
  const char* type = cfg["type"] | "";

  if (strcmp(type, "key") == 0) {
    const char* combo = cfg["combo"] | "";
    uint8_t m = 0, k = 0;
    if (!ble_parse_combo(combo, &m, &k)) { Serial.printf("BLE: cannot parse combo \"%s\"\n", combo); return false; }
    if (ble_q_count + 2 > BLE_QSIZE) { Serial.println("BLE: input queue full"); return true; }
    ble_q_push({ 0, m, k, 0, BLE_GAP_COMBO_MS });              // press (held)
    ble_q_push({ 0, 0, 0, 0, BLE_GAP_RELEASE_MS });            // release
    return true;
  }
  if (strcmp(type, "text") == 0) {
    const char* t = cfg["text"] | "";
    if (!*t) return false;
    if (ble_text_pos >= ble_text.length()) { ble_text = ""; ble_text_pos = 0; ble_text_release_next = false; }
    size_t room = BLE_TEXT_MAX > ble_text.length() ? BLE_TEXT_MAX - ble_text.length() : 0;
    if (strlen(t) > room) Serial.println("BLE: text truncated");
    for (size_t i = 0; i < room && t[i]; i++) ble_text += t[i];
    return true;
  }
  if (strcmp(type, "media") == 0) {
    uint16_t usage = ble_media_usage(cfg["media"] | "");
    if (!usage) return false;
    if (ble_q_count + 2 > BLE_QSIZE) { Serial.println("BLE: input queue full"); return true; }
    ble_q_push({ 1, 0, 0, usage, 40 });                        // press
    ble_q_push({ 1, 0, 0, 0, BLE_GAP_RELEASE_MS });            // release
    return true;
  }
  return false;
}
#endif
