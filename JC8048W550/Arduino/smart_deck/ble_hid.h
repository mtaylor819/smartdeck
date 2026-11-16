// ble_hid.h -- BLE HID keyboard + media keys so the deck works standalone on any machine (Mac/Windows/iPad/phone)
// OWNER: fork "ble". Only this file (+ ble_keys.h and the vendored NimBLE-Arduino library) implements this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// Wire contract: companion-mac/PROTOCOL.md  (SET_BLE, BLE fields of NET_STATUS, device button JSON key/text/media).
//
// Behaviour summary
//  * Disabled until configured: stock behaviour is unchanged until `SET_BLE:{"enabled":true}` arrives (persisted in
//    Preferences namespace "ble": en / name).
//  * Just-Works pairing with bonding (bonds persisted by NimBLE in NVS), advertises as a keyboard (appearance 0x03C1).
//  * v4 PAIRING SAFETY (companion-mac/PROTOCOL.md "BLE pairing safety"): Just Works has no MITM protection, so pairing is only
//    allowed inside a short PAIRING WINDOW (auto 120 s the first time BLE runs with no bonds; BLE_PAIR:<seconds>; a "blepair" button).
//    Outside it bonding is switched off, so a stranger cannot create a bond. A link is APPROVED only when encrypted+bonded
//    (ble_pairing.h); unapproved links are disconnected (encrypted at once, others after 15 s), and HID reports are never sent while
//    ANY encrypted-but-unapproved link exists (NimBLE notifies every encrypted subscriber). So a stranger can neither read keystrokes
//    nor hold the connection. Not done: numeric-comparison confirmation on screen (the window + indicator is the mitigation).
//  * ble_button(): runs type key / text / media buttons over BLE, only while an APPROVED host is connected AND subscribed.
//    Typing is queued and pumped from ble_loop() (never blocks).
//  * Host slots (v3, fork "fw-blehost"): 3 slots, each its own BLE identity so every machine bonds separately; BLE_HOST:<n|next>
//    switches (drops the current host, advertises as the new slot); type "blehost" buttons do the same on the deck itself.
//  * Radio note: WiFi and BLE share the one 2.4 GHz radio; the ESP32 coexistence layer time-slices them. Expect slightly
//    higher HID latency while WiFi is busy (e.g. during an OTA upload). Both are fully supported together by the core.
#ifndef BLE_HID_H
#define BLE_HID_H

#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>
#include <esp_system.h>      // esp_efuse_mac_get_default (stable per-chip seed for the slot identities)
#include "ble_keys.h"
#include "ble_slots.h"
#include "ble_report_map.h"
#include "ble_pairing.h"

bool alert_is_active();   // led_alert.h (included after this header): don't paint the pairing indicator over an alert banner

// ---- Cross-module API used by net_wifi.h (CONTRACT, keep these signatures) -------------------------------------
enum BleState : uint8_t { BLE_ST_OFF = 0, BLE_ST_ADV = 1, BLE_ST_CONN = 2 };

// BLE_ST_CONN means an APPROVED (encrypted + bonded) host is connected, not merely that something connected.
static volatile BleState ble_st = BLE_ST_OFF;
static char ble_peer[20] = "";   // written ONLY by the main loop (staged from the NimBLE task via ble_ok_peer), so no torn reads

// ---- Host slots (v3): one deck, up to 3 machines. Each slot has its own BLE identity so each host bonds separately. ----
// Slot 1 keeps the chip's PUBLIC address (so bonds made with the pre-slot firmware keep working); slots 2/3 use a stable
// static-random address derived from the chip MAC (ble_slot_addr). Only one host is connected at a time.
static uint8_t ble_slot = 1;                                         // current slot 1..3 (persisted "ble"/"cur")
static char ble_slot_names[BLE_SLOT_COUNT][BLE_SLOT_NAME_MAX + 1] = { "Host 1", "Host 2", "Host 3" };   // persisted s1..s3
static uint8_t ble_slot_peer[BLE_SLOT_COUNT][7];                     // last bonded peer per slot: [0]=addr type, [1..6]=addr (0 type+0 addr = none)
static volatile bool ble_bond_pending = false;                       // set by the NimBLE task when pairing finished; main loop persists
static uint8_t ble_bond_peer_tmp[7];
static uint8_t ble_clear_slot_mask = 0;                              // bit n-1: delete that slot's recorded bond once the stack is up
static unsigned long ble_toast_until = 0;                            // millis() when the on-screen "BT: <slot>" toast should be removed

const char* ble_state_str() {
  switch (ble_st) {
    case BLE_ST_ADV: return "advertising";
    case BLE_ST_CONN: return "connected";
    default: return "off";
  }
}
String ble_peer_str() { return String(ble_peer); }
// v3 slot API used by net_wifi.h (CONTRACT, keep these signatures)
int ble_slot_num() { return ble_slot; }
String ble_slots_json() {                       // always 3 entries (defaults "Host 1".."Host 3" until named via SET_BLE slots)
  char buf[96];
  if (!ble_slots_to_json(ble_slot_names, buf, sizeof(buf))) return String("[]");
  return String(buf);
}

// ---- State -------------------------------------------------------------------------------------------------------
static bool ble_enabled = false;                 // persisted ("ble"/"en"); default off until SET_BLE
static char ble_name[25] = "SmartDeck";          // persisted ("ble"/"name"), 1..24 printable ASCII
static bool ble_running = false;                 // NimBLE stack initialised
static volatile bool ble_status_dirty = false;   // set from NimBLE callbacks; main loop emits net_status_changed()
static bool ble_clear_bonds_pending = false;     // SET_BLE clear_bonds:true while stack was down (all slots)
static unsigned long ble_last_adv_check = 0;

// ---- Pairing window + link approval (v4) -----------------------------------------------------------------------
static BlePairWindow ble_pair;                   // main loop only
static bool ble_auto_used = false;               // persisted ("ble"/"pw1"): the automatic first-time window has been used
static uint8_t ble_sec_ver = 0;                  // persisted ("ble"/"sv"): firmware security version that last ran
static unsigned long ble_pair_last_draw = 0;     // millis() of the last indicator paint (1 Hz while the window is open)
static bool ble_pair_drawn = false;              // an indicator is (possibly) on screen and must be wiped when the window closes
static volatile bool ble_pair_close_req = false; // set when an approved NEW bond finished (NimBLE task): close the window early
static volatile bool ble_window_v = false;       // mirror of ble_pair.open for the NimBLE task (the main loop keeps it current)

// Links the NimBLE stack currently reports, with their approval state. Written by the NimBLE host task (callbacks) and read by the
// main loop, so every access takes ble_mux.
#define BLE_MAX_LINKS 3
struct BleLink { uint16_t h; uint32_t t0; bool ok; bool used; };
static BleLink ble_links[BLE_MAX_LINKS];
static portMUX_TYPE ble_mux = portMUX_INITIALIZER_UNLOCKED;
static uint8_t ble_ok_peer[7];                   // identity address of the newest approved peer (staged for the main loop)
static volatile bool ble_ok_peer_pending = false;

static NimBLEServer* ble_server = nullptr;
static NimBLEHIDDevice* ble_hid = nullptr;
static NimBLECharacteristic* ble_kb_in = nullptr;      // report ID 1: keyboard
static NimBLECharacteristic* ble_media_in = nullptr;   // report ID 2: consumer control

// HID report map: see ble_report_map.h (pure data: keyboard ID 1 with usages up to 0xE7 so F13-F24 work, consumer control ID 2).

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
  ble_auto_used = p.getBool("pw1", false);
  ble_sec_ver = p.getUChar("sv", 0);
  String n = p.getString("name", "SmartDeck");
  uint8_t cur = p.getUChar("cur", 1);
  ble_slot = (cur >= 1 && cur <= BLE_SLOT_COUNT) ? cur : 1;
  for (int i = 0; i < BLE_SLOT_COUNT; i++) {
    char k[4] = { 's', (char)('1' + i), 0, 0 };
    String sn = p.getString(k, "");
    if (ble_slot_name_valid(sn.c_str())) { strncpy(ble_slot_names[i], sn.c_str(), BLE_SLOT_NAME_MAX); ble_slot_names[i][BLE_SLOT_NAME_MAX] = 0; }
    k[0] = 'p';
    memset(ble_slot_peer[i], 0, 7);
    if (p.getBytesLength(k) == 7) p.getBytes(k, ble_slot_peer[i], 7);
  }
  p.end();
  if (ble_name_valid(n.c_str())) strncpy(ble_name, n.c_str(), sizeof(ble_name) - 1);
  ble_name[sizeof(ble_name) - 1] = 0;
}
static void ble_save() {
  Preferences p;
  if (!p.begin("ble", false)) return;
  p.putBool("en", ble_enabled);
  p.putString("name", ble_name);
  p.putUChar("cur", ble_slot);
  for (int i = 0; i < BLE_SLOT_COUNT; i++) {
    char k[4] = { 's', (char)('1' + i), 0, 0 };
    p.putString(k, ble_slot_names[i]);
  }
  p.end();
}
static void ble_save_security_meta() {
  Preferences p;
  if (!p.begin("ble", false)) return;
  p.putBool("pw1", ble_auto_used);
  p.putUChar("sv", ble_sec_ver);
  p.end();
}
// Remember which peer is bonded to a slot, so "clear this slot's bond" can find it later.
static void ble_save_peer(int slot) {
  Preferences p;
  if (!p.begin("ble", false)) return;
  char k[4] = { 'p', (char)('0' + slot), 0, 0 };
  p.putBytes(k, ble_slot_peer[slot - 1], 7);
  p.end();
}

// ---- NimBLE callbacks (run on the NimBLE host task: only set flags / copy small data here) ----------------------
// Link table helpers. ble_mux must be held by the caller.
static int ble_link_find_locked(uint16_t h) {
  for (int i = 0; i < BLE_MAX_LINKS; i++) if (ble_links[i].used && ble_links[i].h == h) return i;
  return -1;
}
static void ble_links_clear() {
  portENTER_CRITICAL(&ble_mux);
  for (int i = 0; i < BLE_MAX_LINKS; i++) ble_links[i].used = false;
  portEXIT_CRITICAL(&ble_mux);
}
static int ble_links_count_ok() {
  int n = 0;
  portENTER_CRITICAL(&ble_mux);
  for (int i = 0; i < BLE_MAX_LINKS; i++) if (ble_links[i].used && ble_links[i].ok) n++;
  portEXIT_CRITICAL(&ble_mux);
  return n;
}
static int ble_links_count_all() {
  int n = 0;
  portENTER_CRITICAL(&ble_mux);
  for (int i = 0; i < BLE_MAX_LINKS; i++) if (ble_links[i].used) n++;
  portEXIT_CRITICAL(&ble_mux);
  return n;
}

class BleServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, ble_gap_conn_desc* desc) override {
    // A new link is UNAPPROVED until it completes encryption with a bond (see onAuthenticationComplete). It is NOT reported as
    // "connected" and receives nothing; if it does not get approved within BLE_UNAUTH_KICK_MS the main loop drops it.
    portENTER_CRITICAL(&ble_mux);
    int i = ble_link_find_locked(desc->conn_handle);
    if (i < 0) for (int k = 0; k < BLE_MAX_LINKS; k++) if (!ble_links[k].used) { i = k; break; }
    if (i >= 0) { ble_links[i].used = true; ble_links[i].h = desc->conn_handle; ble_links[i].t0 = millis(); ble_links[i].ok = false; }
    portEXIT_CRITICAL(&ble_mux);
    ble_status_dirty = true;
  }
  void onDisconnect(NimBLEServer* s, ble_gap_conn_desc* desc) override {
    portENTER_CRITICAL(&ble_mux);
    int i = ble_link_find_locked(desc->conn_handle);
    if (i >= 0) ble_links[i].used = false;
    portEXIT_CRITICAL(&ble_mux);
    ble_status_dirty = true;                       // main loop recomputes ble_st / peer; NimBLEServer re-advertises on disconnect
  }
  void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
    // Encryption finished (new pairing OR re-encryption of an existing bond). Runs on the NimBLE task: stage data, don't draw.
    if (!desc) return;
    bool enc = desc->sec_state.encrypted, bonded = desc->sec_state.bonded;
    // The bonded flag's timing on a brand-new bond is unverified (no hardware): also consult the bond store for the peer's identity.
    if (enc && !bonded) bonded = NimBLEDevice::isBonded(NimBLEAddress(desc->peer_id_addr));
    if (ble_auth_verdict(enc, bonded, ble_window_v) == BLE_V_ACCEPT) {
      portENTER_CRITICAL(&ble_mux);
      int i = ble_link_find_locked(desc->conn_handle);
      if (i >= 0) ble_links[i].ok = true;
      ble_ok_peer[0] = desc->peer_id_addr.type;
      memcpy(ble_ok_peer + 1, desc->peer_id_addr.val, 6);
      ble_ok_peer_pending = true;
      portEXIT_CRITICAL(&ble_mux);
      // remember the peer for the current slot ("clear this slot's bond"); a NEW peer (not the slot's known host) also closes the
      // pairing window, so one window pairs one host. An existing host reconnecting must not close a window opened for a second one.
      bool isNew = memcmp(ble_slot_peer[ble_slot - 1], ble_ok_peer, 7) != 0;
      memcpy(ble_bond_peer_tmp, ble_ok_peer, 7);
      ble_bond_pending = true;
      if (isNew) ble_pair_close_req = true;
      ble_status_dirty = true;
    } else {
      // Not (encrypted AND bonded): a stranger (bonding is off outside the pairing window) or a failed attempt. Drop it NOW so it can
      // neither receive reports nor occupy the connection. (Calling terminate from the host task is the documented way.)
      ble_gap_terminate(desc->conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    }
  }
};
static BleServerCb ble_server_cb;

// ---- Identity per slot ------------------------------------------------------------------------------------------
// NimBLE-Arduino 1.4.3 has no setOwnAddr(); on the ESP32 port the host does NOT auto-pick an address at sync, so after init()
// (which blocks until the host is synced) we can set a static-random identity with the NimBLE host API ble_hs_id_set_rnd() and
// then select it for advertising with setOwnAddrType(). Must run before the first advertising start.
static void ble_apply_identity() {
  if (ble_slot == 1) { NimBLEDevice::setOwnAddrType(BLE_OWN_ADDR_PUBLIC); return; }       // slot 1 = legacy public identity
  uint8_t mac[6] = {0}, addr[6];
  esp_efuse_mac_get_default(mac);
  ble_slot_addr(mac, ble_slot, addr);
  int rc = ble_hs_id_set_rnd(addr);
  if (rc != 0) {                                                                          // should not happen; degrade, don't die
    Serial.printf("BLE: could not set slot %d identity (rc=%d); using the public address (slots will share bonds)\n", ble_slot, rc);
    NimBLEDevice::setOwnAddrType(BLE_OWN_ADDR_PUBLIC);
    return;
  }
  NimBLEDevice::setOwnAddrType(BLE_OWN_ADDR_RANDOM);
}

static bool ble_peer_recorded(int slot) {
  const uint8_t* r = ble_slot_peer[slot - 1];
  for (int i = 0; i < 7; i++) if (r[i]) return true;
  return false;
}

// Delete the bond recorded for `slot` (stack must be running). Returns true if a bond was removed.
static bool ble_delete_slot_bond(int slot) {
  if (!ble_peer_recorded(slot)) return false;
  ble_addr_t a;
  a.type = ble_slot_peer[slot - 1][0];
  memcpy(a.val, ble_slot_peer[slot - 1] + 1, 6);
  bool ok = NimBLEDevice::deleteBond(NimBLEAddress(a));
  memset(ble_slot_peer[slot - 1], 0, 7);
  ble_save_peer(slot);
  return ok;
}

// ---- Pairing window (v4) ----------------------------------------------------------------------------------------
// Bonding is only switched ON while the window is open (ble_hs_cfg.sm_bonding is read by NimBLE when a pairing starts, so it can be
// flipped at run time; verified in NimBLEDevice::setSecurityAuth). Outside the window a stranger's pairing completes WITHOUT a bond,
// which ble_auth_verdict() rejects, and re-encryption of existing bonds (stored LTK) is unaffected.
static void ble_apply_security(bool bonding) {
  NimBLEDevice::setSecurityAuth(bonding, false, true);       // bonding?, no MITM (Just Works), LE Secure Connections
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
}

// Orange LCARS pill in the header strip (same spot/style as the alert banner and the slot toast), repainted at 1 Hz while open.
static void ble_pair_draw_indicator(uint32_t secs) {
  if (is_sleeping || is_deep_sleeping || alert_is_active()) return;   // nobody looking / an alert banner owns the header
  if (ble_toast_until) return;                                        // the slot toast owns the header for 1.5 s
  const int x = 8, y = 5, h = 40, w = screenWidth - 16;
  gfx->fillRoundRect(x, y, w, h, h / 2, gfx->color565(255, 153, 0));
  gfx->setTextSize(3);
  gfx->setTextColor(0x0000);
  gfx->setCursor(x + 28, y + 8);
  gfx->print("BT PAIRING  ");
  gfx->print((int)secs);
  gfx->print("s");
  gfx->setTextSize(2);
  ble_pair_drawn = true;
}

static void ble_pair_open_window(uint32_t seconds) {
  ble_pair.start(millis(), seconds);
  ble_window_v = true;
  if (ble_running) ble_apply_security(true);
  ble_pair_last_draw = 0;                                   // paint immediately on the next loop
  ble_status_dirty = true;
  Serial.printf("BLE: pairing window open for %us\n", (unsigned)seconds);
}

static void ble_pair_close_window(bool redraw) {
  bool was = ble_pair.open;
  ble_pair.close();
  ble_window_v = false;
  if (ble_running) ble_apply_security(false);
  if (ble_pair_drawn) {
    ble_pair_drawn = false;
    if (redraw && !is_sleeping && !is_deep_sleeping) draw_page(current_page);   // wipe the indicator (toggle states survive: toggle_table.h)
  }
  if (was) Serial.println("BLE: pairing window closed");
  ble_status_dirty = true;
}

// ---- Start / stop -----------------------------------------------------------------------------------------------
static void ble_start() {
  if (ble_running) return;
  NimBLEDevice::init(ble_name);
  ble_apply_security(ble_pair.isOpen(millis()));            // bonding OFF unless a pairing window is open
  if (ble_sec_ver < BLE_SECURITY_VERSION) {                 // one-time purge: bonds made by the old always-open firmware are not trusted
    NimBLEDevice::deleteAllBonds();
    for (int i = 0; i < BLE_SLOT_COUNT; i++) { memset(ble_slot_peer[i], 0, 7); ble_save_peer(i + 1); }
    ble_auto_used = false;
    ble_sec_ver = BLE_SECURITY_VERSION;
    ble_save_security_meta();
    Serial.println("BLE: security v4: old bonds purged, hosts must pair again");
  }
  if (ble_clear_bonds_pending) {
    NimBLEDevice::deleteAllBonds(); ble_clear_bonds_pending = false; ble_clear_slot_mask = 0;
    for (int i = 0; i < BLE_SLOT_COUNT; i++) { memset(ble_slot_peer[i], 0, 7); ble_save_peer(i + 1); }
    ble_auto_used = false;                                  // bonds are gone: the automatic first-time window may open again
    ble_save_security_meta();
  }
  for (int s = 1; s <= BLE_SLOT_COUNT; s++) if (ble_clear_slot_mask & (1 << (s - 1))) ble_delete_slot_bond(s);
  ble_clear_slot_mask = 0;
  ble_apply_identity();                                       // BEFORE advertising starts

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
  if (ble_auto_window_wanted(NimBLEDevice::getNumBonds(), ble_auto_used)) {   // first time BLE runs with no bonds: let the user pair once
    ble_auto_used = true;
    ble_save_security_meta();
    ble_pair_open_window(BLE_PAIR_AUTO_SECONDS);
  }
  Serial.printf("BLE: advertising as \"%s\" slot %d (%s) (bonds: %d, free heap %u)\n", ble_name, ble_slot, ble_slot_names[ble_slot - 1], NimBLEDevice::getNumBonds(), (unsigned)ESP.getFreeHeap());
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
  ble_links_clear();
  ble_pair.close();                  // a window never survives a stack restart (slot switch / rename / disable)
  ble_window_v = false;
  ble_status_dirty = true;
  Serial.println("BLE: stopped");
}

// ---- Module API -------------------------------------------------------------------------------------------------
void ble_setup() {
  ble_load();
  if (ble_enabled) ble_start();
}

// May HID reports go out right now? Yes only if an APPROVED link exists and no encrypted-but-unapproved link exists
// (NimBLE's notify() delivers to EVERY encrypted subscriber; unencrypted subscribers are already skipped by the library because the
// input-report characteristic is READ_ENC, verified in NimBLECharacteristic::notify). No heap use: walks our 3-entry link table.
static bool ble_send_gate() {
  int approved = 0, encUnapproved = 0;
  for (int i = 0; i < BLE_MAX_LINKS; i++) {
    BleLink l;
    portENTER_CRITICAL(&ble_mux);
    l = ble_links[i];
    portEXIT_CRITICAL(&ble_mux);
    if (!l.used) continue;
    if (l.ok) { approved++; continue; }
    ble_gap_conn_desc d;
    if (ble_gap_conn_find(l.h, &d) == 0 && d.sec_state.encrypted) encUnapproved++;
  }
  return ble_send_allowed(approved, encUnapproved);
}

static bool ble_notify_kb(uint8_t mods, uint8_t key) {
  if (!ble_kb_in) return false;
  uint8_t r[8] = { mods, 0, key, 0, 0, 0, 0, 0 };
  if (!ble_send_gate()) return false;                        // never type into an unapproved/stranger link
  if (ble_kb_in->getSubscribedCount() == 0) return false;   // host hasn't enabled notifications yet (pairing in progress)
  ble_kb_in->setValue(r, sizeof(r));
  ble_kb_in->notify();                                       // NimBLE 1.4.3: void, no delivery feedback
  return true;
}
static bool ble_notify_media(uint16_t usage) {
  if (!ble_media_in) return false;
  uint8_t r[2] = { (uint8_t)(usage & 0xFF), (uint8_t)(usage >> 8) };
  if (!ble_send_gate()) return false;
  if (ble_media_in->getSubscribedCount() == 0) return false;
  ble_media_in->setValue(r, sizeof(r));
  ble_media_in->notify();
  return true;
}

// Persist a finished pairing to the slot that was active when it happened (called from the main loop only).
static void ble_flush_bond() {
  if (!ble_bond_pending) return;
  ble_bond_pending = false;
  memcpy(ble_slot_peer[ble_slot - 1], ble_bond_peer_tmp, 7);
  ble_save_peer(ble_slot);
}

// Brief "BT: <slot name>" pill over the header area (same spot/style as the alert banner), then the page is repainted.
static void ble_show_toast() {
  if (is_sleeping || is_deep_sleeping) return;     // nobody is looking; the wake path redraws the page anyway
  const int x = 8, y = 5, h = 40, w = screenWidth - 16;
  gfx->fillRoundRect(x, y, w, h, h / 2, gfx->color565(153, 153, 204));   // LCARS violet
  gfx->setTextSize(3);
  gfx->setTextColor(0x0000);
  gfx->setCursor(x + 28, y + 8);
  gfx->print("BT: ");
  gfx->print(ble_slot_names[ble_slot - 1]);
  gfx->setTextSize(2);
  ble_toast_until = millis() + 1500;
}

// Switch the active host slot: drop the current host, change identity, advertise again. Caller checked ble_enabled.
static void ble_switch_slot(int n) {
  ble_flush_bond();                                // attribute a just-finished pairing to the OLD slot
  if (n != ble_slot) {
    bool was = ble_running;
    if (was) ble_stop();                           // disconnects the current host and tears the stack down
    ble_slot = (uint8_t)n;
    ble_save();
    if (ble_enabled) ble_start();                  // re-init with the new identity; bonds for all slots stay in NVS
    (void)was;
  }
  ble_status_dirty = true;
  ble_show_toast();
}

void ble_loop() {
  unsigned long now = millis();

  // The approved peer's address was staged by the NimBLE task; only the main loop ever writes ble_peer (no torn reads).
  if (ble_ok_peer_pending) {
    uint8_t pr[7];
    portENTER_CRITICAL(&ble_mux);
    memcpy(pr, ble_ok_peer, 7);
    ble_ok_peer_pending = false;
    portEXIT_CRITICAL(&ble_mux);
    ble_addr_t ba;
    ba.type = pr[0];
    memcpy(ba.val, pr + 1, 6);
    strncpy(ble_peer, NimBLEAddress(ba).toString().c_str(), sizeof(ble_peer) - 1);
    ble_peer[sizeof(ble_peer) - 1] = 0;
    ble_status_dirty = true;
  }
  // "connected" = an APPROVED host. Recomputed from the link table, so a stranger's idle link never shows as connected.
  {
    BleState ns = !ble_running ? BLE_ST_OFF : (ble_links_count_ok() > 0 ? BLE_ST_CONN : BLE_ST_ADV);
    if (ns != ble_st) { ble_st = ns; if (ns != BLE_ST_CONN) ble_peer[0] = 0; ble_status_dirty = true; }
  }
  if (ble_status_dirty) {                 // tell the net module (emits NET_STATUS, rate-limited there)
    ble_status_dirty = false;
    net_status_changed();
  }
  ble_flush_bond();
  if (ble_toast_until && (int32_t)(millis() - ble_toast_until) >= 0) {
    ble_toast_until = 0;
    if (!is_sleeping && !is_deep_sleeping) draw_page(current_page);       // remove the toast (the alert banner self-heals if active)
  }

  // Pairing window: close early after a NEW host paired, expire on time, repaint the indicator at 1 Hz, stay awake while it is open.
  if (ble_pair_close_req) { ble_pair_close_req = false; if (ble_pair.open) ble_pair_close_window(true); }
  if (ble_pair.open) {
    if (!ble_pair.isOpen(now)) {
      ble_pair_close_window(true);
    } else {
      last_activity_time = now;           // the user is pairing: don't dim/sleep under them (same trick as the alert)
      if (now - ble_pair_last_draw >= 1000) { ble_pair_last_draw = now; ble_pair_draw_indicator(ble_pair.remainingSec(now)); }
    }
  }
  if (!ble_running) return;

  // Drop links that never got approved (a stranger sitting on the connection). Encrypted-but-unbonded ones were already terminated
  // in onAuthenticationComplete; this catches peers that connect and then do nothing.
  if (ble_server) {
    for (int i = 0; i < BLE_MAX_LINKS; i++) {
      BleLink l;
      portENTER_CRITICAL(&ble_mux);
      l = ble_links[i];
      if (l.used && ble_link_expired(l.ok, l.t0, (uint32_t)now)) ble_links[i].t0 = (uint32_t)now;   // retry in another 15 s if it lingers
      portEXIT_CRITICAL(&ble_mux);
      if (l.used && ble_link_expired(l.ok, l.t0, (uint32_t)now)) ble_server->disconnect(l.h);
    }
  }

  if (ble_st != BLE_ST_CONN) {            // no approved host: drop anything pending, make sure we're advertising
    if (ble_q_count || ble_text.length()) ble_queue_clear();
    if (now - ble_last_adv_check > 2000) {
      ble_last_adv_check = now;
      NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
      // keep advertising while only unapproved links exist, so a stranger idling on one slot cannot lock the real host out
      if (!adv->isAdvertising() && ble_links_count_all() < BLE_MAX_LINKS) { adv->start(); }
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
  if (c.startsWith("BLE_PAIR:")) {                         // BLE_PAIR:<1..300>  open the pairing window for that many seconds
    if (!ble_enabled) { Serial.println("BLE_PAIR:err:ble_off"); return true; }
    int secs = 0;
    String arg = c.substring(9);
    arg.trim();
    if (!ble_pair_parse_seconds(arg.c_str(), &secs)) { Serial.println("BLE_PAIR:err:bad_seconds"); return true; }
    if (!ble_running) ble_start();                          // enabled but stack down (shouldn't happen): bring it up first
    ble_pair_open_window((uint32_t)secs);
    Serial.printf("BLE_PAIR:%d\n", secs);
    return true;
  }
  if (c.startsWith("BLE_HOST:")) {                         // BLE_HOST:<1|2|3|next>
    if (!ble_enabled) { Serial.println("BLE_HOST:err:ble_off"); return true; }
    int n = ble_slot_parse_arg(c.substring(9).c_str(), ble_slot);
    if (!n) { Serial.println("BLE_HOST:err:bad_slot"); return true; }
    ble_switch_slot(n);                                     // no-op restart if it is already the active slot
    Serial.printf("BLE_HOST:%d\n", n);
    return true;
  }
  if (!c.startsWith("SET_BLE:")) return false;
  JsonDocument d;
  if (deserializeJson(d, c.substring(8)) != DeserializationError::Ok || !d.is<JsonObject>()) {
    Serial.println("BLE_SET:err:bad_json");
    return true;
  }
  // clear_bonds: true = all slots, 1..3 = that slot only, false/absent = nothing (stock behaviour: false was never a "field").
  bool clearAll = false;
  int clearSlot = 0;
  JsonVariant cb = d["clear_bonds"];
  if (!cb.isNull()) {
    if (cb.is<bool>()) clearAll = cb.as<bool>();
    else if (cb.is<int>() && cb.as<int>() >= 1 && cb.as<int>() <= BLE_SLOT_COUNT) clearSlot = cb.as<int>();
    else { Serial.println("BLE_SET:err:bad_clear"); return true; }
  }
  bool hasEn = !d["enabled"].isNull(), hasName = !d["name"].isNull(), hasSlots = !d["slots"].isNull();
  if (!hasEn && !hasName && !hasSlots && !clearAll && !clearSlot) { Serial.println("BLE_SET:err:no_fields"); return true; }
  if (hasEn && !d["enabled"].is<bool>()) { Serial.println("BLE_SET:err:bad_enabled"); return true; }
  const char* nm = nullptr;
  if (hasName) {
    if (!d["name"].is<const char*>() || !ble_name_valid(d["name"].as<const char*>())) { Serial.println("BLE_SET:err:bad_name"); return true; }
    nm = d["name"].as<const char*>();
  }
  // slots: 1..3 names, applied to slots 1..k (the rest keep their current names). Validate everything before changing anything.
  const char* sn[BLE_SLOT_COUNT] = { nullptr, nullptr, nullptr };
  size_t nslots = 0;
  if (hasSlots) {
    if (!d["slots"].is<JsonArray>()) { Serial.println("BLE_SET:err:bad_slots"); return true; }
    JsonArray arr = d["slots"].as<JsonArray>();
    if (arr.size() < 1 || arr.size() > BLE_SLOT_COUNT) { Serial.println("BLE_SET:err:bad_slots"); return true; }
    for (JsonVariant v : arr) {
      if (!v.is<const char*>() || !ble_slot_name_valid(v.as<const char*>())) { Serial.println("BLE_SET:err:bad_slots"); return true; }
      sn[nslots++] = v.as<const char*>();
    }
  }

  bool newEnabled = hasEn ? d["enabled"].as<bool>() : ble_enabled;
  bool renamed = nm && strcmp(nm, ble_name) != 0;
  if (nm) { strncpy(ble_name, nm, sizeof(ble_name) - 1); ble_name[sizeof(ble_name) - 1] = 0; }
  for (size_t i = 0; i < nslots; i++) { strncpy(ble_slot_names[i], sn[i], BLE_SLOT_NAME_MAX); ble_slot_names[i][BLE_SLOT_NAME_MAX] = 0; }
  ble_enabled = newEnabled;
  ble_save();
  if (nslots) ble_status_dirty = true;                          // NET_STATUS carries the slot names

  if (ble_running && (!newEnabled || renamed)) ble_stop();     // rename needs a stack restart (name is set at init)
  if (clearAll) {
    if (ble_running) {
      NimBLEDevice::deleteAllBonds();
      for (int i = 0; i < BLE_SLOT_COUNT; i++) { memset(ble_slot_peer[i], 0, 7); ble_save_peer(i + 1); }
      ble_auto_used = false;                                    // no bonds left: the automatic first-time window may open at next start
      ble_save_security_meta();
    } else ble_clear_bonds_pending = true;                      // applied at next start
  } else if (clearSlot) {
    if (ble_running) ble_delete_slot_bond(clearSlot); else ble_clear_slot_mask |= (uint8_t)(1 << (clearSlot - 1));
  }
  if (newEnabled && !ble_running) ble_start();
  Serial.println("BLE_SET:ok");
  return true;
}

// Device-local button: "blehost" switches the BLE host slot ON THE DECK, even when a host app is connected
// (like "goto"; hooked at the top of send_pc_command in smart_deck.ino). Returns true if it consumed the press.
bool ble_local_button(JsonObject cfg) {
  const char* type = cfg["type"] | "";
  if (strcmp(type, "blepair") == 0) {                      // {"type":"blepair"}: open the pairing window (120 s) from the deck itself
    if (!ble_enabled) { Serial.println("BLE: blepair pressed but Bluetooth is disabled (SET_BLE enabled)"); return true; }
    if (!ble_running) ble_start();
    ble_pair_open_window(BLE_PAIR_AUTO_SECONDS);
    return true;
  }
  if (strcmp(type, "blehost") != 0) return false;
  int n = 0;
  JsonVariant s = cfg["slot"];
  if (s.is<int>()) { int v = s.as<int>(); n = (v >= 1 && v <= BLE_SLOT_COUNT) ? v : 0; }
  else if (s.is<const char*>()) n = ble_slot_parse_arg(s.as<const char*>(), ble_slot);
  if (!n) { Serial.println("BLE: blehost button has a bad slot"); return true; }
  if (!ble_enabled) { Serial.println("BLE: blehost pressed but Bluetooth is disabled (SET_BLE enabled)"); return true; }
  ble_switch_slot(n);
  return true;
}

// Standalone button execution via BLE HID (key/text/media). Return true if executed (or queued).
bool ble_button(JsonObject cfg, int page, int idx, bool hasState, bool state) {
  if (!ble_running || ble_st != BLE_ST_CONN) return false;     // let the other modules / host path handle it
  const char* type = cfg["type"] | "";
  // M5: "connected" is not enough. If the approved host has not subscribed to the report we would send to (right after connect, or iOS
  // unsubscribing while idle) the press would be queued and then dropped after ~0.6 s, and returning true would also stop the
  // WiFi/Home Assistant fallback from running. Only claim the press when the host can actually receive it.
  bool isMedia = strcmp(type, "media") == 0;
  NimBLECharacteristic* rep = isMedia ? ble_media_in : ble_kb_in;
  if ((strcmp(type, "key") == 0 || strcmp(type, "text") == 0 || isMedia) && (!rep || rep->getSubscribedCount() == 0)) return false;

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
