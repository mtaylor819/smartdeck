// net_wifi.h -- WiFi STA, mDNS, TCP host link, OTA, NTP, standalone HA/HTTP actions
// OWNER: fork "net". Only this file (plus clearly-marked hook edits in smart_deck.ino if essential) should change for this feature.
// Included from features.h AFTER all globals/types in smart_deck.ino are declared (gfx, doc, strip, current_page, ...).
// See companion-mac/PROTOCOL.md for the wire contract. Companion file: host_io.h (Serial tee to the TCP link).
//
// Everything here is NON-BLOCKING: net_loop() runs a few small state machines per loop() iteration.
// Secrets (WiFi password, link/OTA token, HA token) live in Preferences namespace "net" (plain NVS) and are never
// printed, echoed or logged.
#ifndef NET_WIFI_H
#define NET_WIFI_H

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <esp_system.h>  // esp_random()
#include <mbedtls/sha256.h>
#include <lwip/sockets.h>
#include <time.h>
#include <vector>
#include "net_auth_logic.h"  // [v4] pure HMAC / per-IP lockout / validators (unit-tested on a PC)

#define NET_FW_VERSION "2.5.1-mac1"  // mac1 = v4 security protocol (HMAC auth, signed OTA)
static const uint16_t NET_TCP_PORT = 7778;  // host link (AUTH + protocol lines)
static const uint16_t NET_OTA_PORT = 7779;  // HTTP POST /update

// Cross-module API (signatures are a CONTRACT with ble_hid.h; do not change):
const char* ble_state_str();   // "off" | "advertising" | "connected"   (implemented in ble_hid.h)
String ble_peer_str();
int ble_slot_num();             // current BLE host slot 1..3   (implemented in ble_hid.h)
String ble_slots_json();       // JSON array of slot names, e.g. ["Mac","PC"]  (implemented in ble_hid.h)         // connected peer description or ""        (implemented in ble_hid.h)
static bool net_status_dirty = false;
void net_status_changed() { net_status_dirty = true; }  // BLE/other modules call this when their state changes

// ---------------------------------------------------------------------------------------------------------------
// Config (Preferences "net")
// ---------------------------------------------------------------------------------------------------------------
struct NetConfig {
  String ssid, pass, host, token, haUrl, haToken, tz;
  uint8_t standalone = 0;  // 0 auto, 1 always, 2 never
  bool wifi = true;
};
static NetConfig net_cfg;
static Preferences net_prefs;

enum NetWifiState { NET_OFF, NET_CONNECTING, NET_CONNECTED };
static NetWifiState net_state = NET_OFF;
static bool net_attempt_active = false;
static unsigned long net_attempt_started = 0;
static unsigned long net_retry_at = 0;
static unsigned long net_backoff_ms = 1000;
static unsigned long net_apply_at = 0;  // deferred application of SET_NET (lets the reply flush first)
static unsigned long net_last_status_ms = 0;

// [v4] Auth failure throttle: PER SOURCE IP (shared by the TCP link and OTA), so a hostile device cannot lock out the real Mac.
static NaIpTable net_ip_table;

static WiFiServer net_tcp_server(NET_TCP_PORT);
static WiFiServer net_ota_server(NET_OTA_PORT);
static bool net_services_up = false;

static WiFiClient net_tcp_auth;  // authenticated host link
static uint32_t net_tcp_auth_ip = 0;
// [v4] Up to 3 connections waiting for their AUTH (each already holds its own CHALLENGE nonce). A new connection evicts the oldest.
#define NET_PEND_SLOTS 3
struct NetPend {
  WiFiClient c;
  unsigned long since = 0;
  char buf[160];
  size_t len = 0;
  char nonce[33] = {0};
  uint32_t ip = 0;
  bool used = false;
};
static NetPend net_pend[NET_PEND_SLOTS];
static String net_tcp_line;
static bool net_tcp_overflow = false;
static bool net_tcp_was_up = false;

static bool net_ntp_started = false;
static bool net_ntp_synced = false;
static unsigned long net_ntp_next = 0;
static unsigned long net_last_host_time_ms = 0;  // when a host last sent SET_TIME

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------
// [v4] Per-IP lockout wrappers (logic lives in net_auth_logic.h and is unit-tested on a PC).
static bool net_locked_out(uint32_t ip) { return net_ip_table.isLocked(ip, (uint32_t)millis()); }
static void net_note_auth_fail(uint32_t ip) { net_ip_table.noteFail(ip, (uint32_t)millis()); }
static void net_note_auth_ok(uint32_t ip) { net_ip_table.noteSuccess(ip); }

static void net_sha256_oneshot(const uint8_t* d, size_t n, uint8_t out[32]) { mbedtls_sha256_ret(d, n, out, 0); }

// 16 random bytes from the hardware RNG as 32 lowercase hex chars (needs 33 bytes).
static void net_random_nonce(char out[33]) {
  uint8_t b[16];
  for (int i = 0; i < 4; i++) {
    uint32_t r = esp_random();
    memcpy(b + 4 * i, &r, 4);
  }
  na_hex(b, 16, out);
}

// out = hex(HMAC(token, prefix + nonce [+ ":" + extra])). Returns false if there is no usable token (< 8 chars).
static bool net_hmac_for(const char* prefix, const char* nonce, const char* extra, char out[65]) {
  if (net_cfg.token.length() < 8) return false;
  char msg[NA_HMAC_MAX_MSG + 1];
  int n = snprintf(msg, sizeof(msg), extra ? "%s%s:%s" : "%s%s", prefix, nonce, extra ? extra : "");
  if (n <= 0 || n > NA_HMAC_MAX_MSG) return false;
  return na_hmac_hex(net_sha256_oneshot, net_cfg.token.c_str(), msg, out);
}

static bool net_printable_token(const String& s, size_t lo, size_t hi) {
  if (s.length() < lo || s.length() > hi) return false;
  for (size_t i = 0; i < s.length(); i++)
    if ((uint8_t)s[i] <= 32 || (uint8_t)s[i] >= 127) return false;
  return true;
}

static bool net_valid_host(const String& s) {
  if (s.length() < 1 || s.length() > 32) return false;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return s[0] != '-' && s[s.length() - 1] != '-';
}

static bool net_valid_tz(const String& s) {
  if (s.length() > 64) return false;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strchr(",.:/+-<> ", c);
    if (!ok) return false;
  }
  return true;
}

static void net_load_config() {
  net_prefs.begin("net", false);
  net_cfg.ssid = net_prefs.getString("ssid", "");
  net_cfg.pass = net_prefs.getString("pass", "");
  net_cfg.host = net_prefs.getString("host", "smartdeck");
  net_cfg.token = net_prefs.getString("token", "");
  net_cfg.haUrl = net_prefs.getString("ha_url", "");
  net_cfg.haToken = net_prefs.getString("ha_tok", "");
  net_cfg.tz = net_prefs.getString("tz", "");
  net_cfg.standalone = net_prefs.getUChar("sa", 0);
  net_cfg.wifi = net_prefs.getBool("wifi", true);
  if (!net_valid_host(net_cfg.host)) net_cfg.host = "smartdeck";
}

static bool net_wanted() { return net_cfg.wifi && net_cfg.ssid.length() > 0; }

int net_standalone_mode() { return net_cfg.standalone; }          // 0 auto, 1 always, 2 never (BLE module may honour this)
bool net_standalone_always() { return net_cfg.standalone == 1; }  // used by the send_pc_command hook in smart_deck.ino

// ---------------------------------------------------------------------------------------------------------------
// NET_STATUS
// ---------------------------------------------------------------------------------------------------------------
static void net_emit_status() {
  JsonDocument d;
  const char* w = net_state == NET_CONNECTED ? "connected" : (net_state == NET_CONNECTING ? "connecting" : "off");
  d["wifi"] = w;
  d["ip"] = net_state == NET_CONNECTED ? WiFi.localIP().toString() : String("");
  d["rssi"] = net_state == NET_CONNECTED ? WiFi.RSSI() : 0;
  d["host"] = net_cfg.host;
  d["ssid"] = net_cfg.ssid;
  d["clients"] = net_tcp_auth.connected() ? 1 : 0;
  d["ota"] = net_services_up;
  d["ntp"] = net_ntp_synced;
  d["ble"] = ble_state_str();
  d["ble_peer"] = ble_peer_str();
  d["fw"] = NET_FW_VERSION;
  JsonArray caps = d["caps"].to<JsonArray>();  // features the host may rely on (older firmware omits "caps")
  caps.add("btn_live");
  caps.add("ha_state");
  caps.add("ble_hosts");
  d["ble_slot"] = ble_slot_num();
  {
    JsonDocument sl;
    if (!deserializeJson(sl, ble_slots_json()) && sl.is<JsonArray>()) d["ble_slots"] = sl.as<JsonArray>();
    else d["ble_slots"].to<JsonArray>();
  }
  String out;
  serializeJson(d, out);
  Serial.print("NET_STATUS:");
  Serial.println(out);
  net_last_status_ms = millis();
  net_status_dirty = false;
}

// ---------------------------------------------------------------------------------------------------------------
// SET_NET
// ---------------------------------------------------------------------------------------------------------------
// Write a string key only if it changed, then read it back. The sentinel default can never equal a validated value.
static bool net_put_str(const char* k, const String& v) {
  const String sentinel = "\x01<unset>";
  if (net_prefs.getString(k, sentinel) == v) return true;  // unchanged: no flash write, no wear
  net_prefs.putString(k, v);
  return net_prefs.getString(k, sentinel) == v;
}
static bool net_put_u8(const char* k, uint8_t v) {
  if (net_prefs.isKey(k) && net_prefs.getUChar(k, (uint8_t)(v ^ 0xFF)) == v) return true;
  net_prefs.putUChar(k, v);
  return net_prefs.isKey(k) && net_prefs.getUChar(k, (uint8_t)(v ^ 0xFF)) == v;
}
static bool net_put_bool(const char* k, bool v) {
  if (net_prefs.isKey(k) && net_prefs.getBool(k, !v) == v) return true;
  net_prefs.putBool(k, v);
  return net_prefs.isKey(k) && net_prefs.getBool(k, !v) == v;
}
static bool net_write_all(const NetConfig& n) {
  bool ok = true;
  ok &= net_put_str("ssid", n.ssid);
  ok &= net_put_str("pass", n.pass);
  ok &= net_put_str("host", n.host);
  ok &= net_put_str("token", n.token);
  ok &= net_put_str("ha_url", n.haUrl);
  ok &= net_put_str("ha_tok", n.haToken);
  ok &= net_put_str("tz", n.tz);
  ok &= net_put_u8("sa", n.standalone);
  ok &= net_put_bool("wifi", n.wifi);
  return ok;
}
// Commit `n`; on any failure best-effort restore the previous values so flash keeps matching the (unchanged) RAM config.
static bool net_commit_config(const NetConfig& n) {
  if (net_write_all(n)) return true;
  net_write_all(net_cfg);
  return false;
}

// Returns nullptr on success, else a fixed error token (never echoes values).
static const char* net_apply_set_net(const String& body) {
  if (body.length() > 2048) return "too_long";
  JsonDocument d;
  if (deserializeJson(d, body)) return "bad_json";
  NetConfig n = net_cfg;
  bool changedConn = false, changedTz = false;

  if (!d["ssid"].isNull()) {
    if (!d["ssid"].is<const char*>()) return "bad_ssid";
    String v = d["ssid"].as<String>();
    if (v.length() > 32) return "bad_ssid";
    if (v != n.ssid) changedConn = true;
    n.ssid = v;
  }
  if (!d["pass"].isNull()) {
    if (!d["pass"].is<const char*>()) return "bad_pass";
    String v = d["pass"].as<String>();
    if (v.length() > 63 || (v.length() > 0 && v.length() < 8)) return "bad_pass";
    if (v != n.pass) changedConn = true;
    n.pass = v;
  }
  if (!d["host"].isNull()) {
    String v = d["host"].as<String>();
    if (!net_valid_host(v)) return "bad_host";
    if (v != n.host) changedConn = true;
    n.host = v;
  }
  if (!d["token"].isNull()) {
    String v = d["token"].as<String>();
    if (!net_printable_token(v, 8, 64)) return "bad_token";
    n.token = v;
  }
  if (!d["ha_url"].isNull()) {
    String v = d["ha_url"].as<String>();
    if (v.length() > 0 && ((!v.startsWith("http://") && !v.startsWith("https://")) || v.length() > 128)) return "bad_ha_url";
    n.haUrl = v;
  }
  if (!d["ha_token"].isNull()) {
    String v = d["ha_token"].as<String>();
    if (v.length() > 0 && !net_printable_token(v, 1, 600)) return "bad_ha_token";
    n.haToken = v;
  }
  if (!d["tz"].isNull()) {
    String v = d["tz"].as<String>();
    if (!net_valid_tz(v)) return "bad_tz";
    if (v != n.tz) changedTz = true;
    n.tz = v;
  }
  if (!d["standalone"].isNull()) {
    String v = d["standalone"].as<String>();
    if (v == "auto") n.standalone = 0;
    else if (v == "always") n.standalone = 1;
    else if (v == "never") n.standalone = 2;
    else return "bad_standalone";
  }
  if (!d["wifi"].isNull()) {
    if (!d["wifi"].is<bool>()) return "bad_wifi";
    if (d["wifi"].as<bool>() != n.wifi) changedConn = true;
    n.wifi = d["wifi"].as<bool>();
  }

  // Commit (all validated). [v4] Only CHANGED keys are written, each is read back to prove it stuck, and RAM is only
  // updated if every write succeeded (a full NVS must not leave RAM and flash disagreeing after the next reboot).
  if (!net_commit_config(n)) return "nvs";
  net_cfg = n;

  // Defer reconnect so the "NET_SET:ok" reply can leave over the (possibly WiFi) link first.
  if (changedConn) {
    net_apply_at = millis() + 250;
    if (net_apply_at == 0) net_apply_at = 1;
  }
  if (changedTz && net_ntp_started) net_ntp_started = false;  // re-run configTzTime next tick
  net_status_changed();
  return nullptr;
}

// ---------------------------------------------------------------------------------------------------------------
// WiFi + services
// ---------------------------------------------------------------------------------------------------------------
static void net_stop_services() {
  if (!net_services_up) return;
  net_tcp_auth.stop();
  for (int i = 0; i < NET_PEND_SLOTS; i++) {
    net_pend[i].c.stop();
    net_pend[i].used = false;
  }
  Serial.setTcp(nullptr);
  net_tcp_server.end();
  net_ota_server.end();
  MDNS.end();
  net_services_up = false;
  net_ntp_started = false;
  net_tcp_line = "";
  net_tcp_overflow = false;
}

static void net_start_services() {
  if (MDNS.begin(net_cfg.host.c_str())) MDNS.addService("smartdeck", "tcp", NET_TCP_PORT);
  net_tcp_server.begin();
  net_tcp_server.setNoDelay(true);
  net_ota_server.begin();
  net_services_up = true;
}

static void net_wifi_tick() {
  unsigned long now = millis();
  if (net_apply_at && (long)(now - net_apply_at) >= 0) {  // a SET_NET changed connection settings: restart WiFi cleanly
    net_apply_at = 0;
    net_stop_services();
    WiFi.disconnect(false);
    net_state = NET_OFF;
    net_attempt_active = false;
    net_backoff_ms = 1000;
    net_retry_at = 0;
  }

  if (!net_wanted()) {
    if (net_state != NET_OFF) {
      net_stop_services();
      WiFi.disconnect(false);
      net_state = NET_OFF;
      net_attempt_active = false;
      net_status_changed();
    }
    return;
  }

  if (net_state == NET_OFF) {
    net_state = NET_CONNECTING;
    net_attempt_active = false;
    net_retry_at = 0;
    net_status_changed();
  }

  wl_status_t st = WiFi.status();
  if (net_state == NET_CONNECTED) {
    if (st != WL_CONNECTED) {  // link lost
      net_stop_services();
      net_state = NET_CONNECTING;
      net_attempt_active = false;
      net_backoff_ms = 1000;
      net_retry_at = now + 1000;
      net_status_changed();
    }
    return;
  }

  // NET_CONNECTING
  if (!net_attempt_active) {
    if ((long)(now - net_retry_at) < 0) return;
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false);
    WiFi.config(INADDR_NONE, INADDR_NONE, INADDR_NONE);  // known workaround so setHostname takes effect
    WiFi.setHostname(net_cfg.host.c_str());
    WiFi.begin(net_cfg.ssid.c_str(), net_cfg.pass.length() ? net_cfg.pass.c_str() : nullptr);
    net_attempt_active = true;
    net_attempt_started = now;
    return;
  }
  if (st == WL_CONNECTED) {
    net_state = NET_CONNECTED;
    net_attempt_active = false;
    net_backoff_ms = 1000;
    net_start_services();
    net_status_changed();
    return;
  }
  bool failed = (st == WL_CONNECT_FAILED || st == WL_NO_SSID_AVAIL);
  if (failed || (now - net_attempt_started) > 20000UL) {
    WiFi.disconnect(false);
    net_attempt_active = false;
    net_retry_at = now + net_backoff_ms;
    net_backoff_ms = net_backoff_ms >= 60000UL ? 60000UL : net_backoff_ms * 2;  // 1,2,4,...,60 s
  }
}

// ---------------------------------------------------------------------------------------------------------------
// TCP host link (port 7778)
// ---------------------------------------------------------------------------------------------------------------
// [v4] Mutual HMAC challenge-response (see PROTOCOL.md "v4"). The token itself never crosses the network:
//   deck -> CHALLENGE:<32 hex nonce>      client -> AUTH:<hex HMAC(token, "client:"+nonce)>
//   deck -> AUTH_OK:<hex HMAC(token, "deck:"+nonce)>   (the client verifies this: an impostor deck cannot produce it)
static void net_tcp_keepalive(WiFiClient& c) {
  int fd = c.fd();
  if (fd < 0) return;
  int on = 1, idle = 10, intvl = 5, cnt = 3;  // dead peer dropped after ~25 s (Mac asleep / WiFi gone without a FIN)
  setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
}

static void net_pend_drop(NetPend& p) {
  p.c.stop();
  p.used = false;
  p.len = 0;
}

static void net_tcp_process_auth_line(NetPend& p, const char* line, size_t len) {
  bool ok = false;
  char exp[65];
  if (len >= 5 && strncmp(line, "AUTH:", 5) == 0 && net_hmac_for("client:", p.nonce, nullptr, exp))
    ok = na_hmac_matches(line + 5, len - 5, exp);  // fixed 64-byte compare; length mismatch folded in afterwards
  if (!ok) {
    net_note_auth_fail(p.ip);
    p.c.print("AUTH_FAIL\n");
    p.c.flush();
    net_pend_drop(p);
    return;
  }
  char deck[65];
  if (!net_hmac_for("deck:", p.nonce, nullptr, deck)) {  // cannot happen (token was just used), but never send garbage
    net_pend_drop(p);
    return;
  }
  net_note_auth_ok(p.ip);
  p.c.print("AUTH_OK:");
  p.c.print(deck);
  p.c.print("\n");
  if (net_tcp_auth.connected()) net_tcp_auth.stop();  // newest authenticated client replaces the old one
  Serial.setTcp(nullptr);
  net_tcp_auth = p.c;  // shares the socket handle
  net_tcp_auth_ip = p.ip;
  p.c = WiFiClient();  // drop our extra reference WITHOUT closing the socket
  p.used = false;
  p.len = 0;
  net_tcp_auth.setNoDelay(true);
  net_tcp_keepalive(net_tcp_auth);
  net_tcp_line = "";
  net_tcp_overflow = false;
  Serial.setTcp(&net_tcp_auth);
  net_status_changed();
}

static void net_tcp_tick() {
  if (!net_services_up) return;
  unsigned long now = millis();

  // new connections: refused if that IP is locked out; otherwise take a free pending slot, evicting the OLDEST pending one
  WiFiClient nc = net_tcp_server.available();
  if (nc) {
    uint32_t ip = (uint32_t)nc.remoteIP();
    if (net_locked_out(ip)) {
      nc.stop();
    } else {
      NetPend* slot = nullptr;
      for (int i = 0; i < NET_PEND_SLOTS && !slot; i++)
        if (!net_pend[i].used) slot = &net_pend[i];
      if (!slot) {
        slot = &net_pend[0];
        for (int i = 1; i < NET_PEND_SLOTS; i++)
          if ((long)(net_pend[i].since - slot->since) < 0) slot = &net_pend[i];
        slot->c.stop();  // an idle connection must not be able to starve real clients
      }
      slot->c = nc;
      slot->c.setNoDelay(true);
      slot->since = now;
      slot->len = 0;
      slot->ip = ip;
      slot->used = true;
      net_random_nonce(slot->nonce);
      slot->c.print("CHALLENGE:");
      slot->c.print(slot->nonce);
      slot->c.print("\n");
    }
  }

  // pending clients: each must answer its CHALLENGE with "AUTH:<hmac>\n" within 5 s
  for (int i = 0; i < NET_PEND_SLOTS; i++) {
    NetPend& p = net_pend[i];
    if (!p.used) continue;
    bool done = false;
    while (!done && p.c.available() > 0) {
      int ch = p.c.read();
      if (ch < 0) break;
      if (ch == '\r') continue;
      if (ch == '\n') {
        p.buf[p.len] = 0;
        size_t len = p.len;
        p.len = 0;
        net_tcp_process_auth_line(p, p.buf, len);  // always ends the pending state (success hands the socket over)
        done = true;
      } else if (p.len < sizeof(p.buf) - 1) {
        p.buf[p.len++] = (char)ch;
      } else {  // absurdly long first line
        net_note_auth_fail(p.ip);
        net_pend_drop(p);
        done = true;
      }
    }
    if (done || !p.used) continue;
    if (!p.c.connected() && p.c.available() == 0) {  // peer left without answering
      net_pend_drop(p);
    } else if ((now - p.since) > 5000UL) {  // idle, no AUTH: counts as a failure for that IP (limits connection-churn attacks)
      net_note_auth_fail(p.ip);
      net_pend_drop(p);
    }
  }

  // authenticated client liveness (a vanished peer is caught by keepalive; a stalled one by the HostIO stall counter)
  bool up = net_tcp_auth.connected();
  if (up && Serial.tcpStalled()) {
    net_tcp_auth.stop();
    up = false;
  }
  if (net_tcp_was_up && !up) {
    Serial.setTcp(nullptr);
    net_tcp_auth.stop();
    net_status_changed();
  }
  net_tcp_was_up = up;
}

// Called from loop(): returns true and fills `out` with one complete command line from the authenticated TCP client.
bool net_tcp_take_line(String& out) {
  if (!net_tcp_auth.connected()) return false;
  while (net_tcp_auth.available() > 0) {
    int ch = net_tcp_auth.read();
    if (ch < 0) break;
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (net_tcp_overflow) {
        net_tcp_overflow = false;
        net_tcp_line = "";
        continue;
      }
      out = net_tcp_line;
      net_tcp_line = "";
      return true;
    }
    if (net_tcp_overflow) continue;
    if (net_tcp_line.length() >= 4096) {  // line cap: discard the rest of this line
      net_tcp_overflow = true;
      net_tcp_line = "";
      continue;
    }
    net_tcp_line += (char)ch;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// OTA (HTTP POST /update on 7779)
// ---------------------------------------------------------------------------------------------------------------
// [v4] Flow (PROTOCOL.md "v4"): GET /challenge -> nonce; POST /update with X-SmartDeck-Nonce, X-SmartDeck-Sha256 (hash of the
// body) and X-SmartDeck-Auth = hex HMAC(token, "ota:"+nonce+":"+sha256). The nonce is single use, the auth is verified BEFORE
// any flash is touched, and the streamed body's SHA-256 must equal the signed hash or the update is aborted (no reboot).
enum NetOtaState { OTA_IDLE, OTA_HEADERS, OTA_BODY };
static NetOtaState net_ota_state = OTA_IDLE;
static WiFiClient net_ota_client;
static uint32_t net_ota_ip = 0;
static unsigned long net_ota_since = 0;       // when the current state began / last data seen
static String net_ota_hdr_line;
static size_t net_ota_hdr_bytes = 0;
static String net_ota_method, net_ota_path, net_ota_nonce_hdr, net_ota_sha_hdr, net_ota_auth_hdr;
static long net_ota_len = -1;
static uint8_t net_ota_head[64];
static size_t net_ota_head_len = 0;
static bool net_ota_begun = false;
static size_t net_ota_received = 0;
static int net_ota_last_pct = -1;
static mbedtls_sha256_context net_ota_sha;
static bool net_ota_sha_live = false;
static bool net_ota_in_progress() { return net_ota_state == OTA_BODY; }

// Single-use nonces handed out by GET /challenge: at most 4 outstanding (oldest evicted), valid 60 s.
#define NET_OTA_NONCES 4
struct NetOtaNonce {
  char nonce[33];
  unsigned long created;
  bool used;
};
static NetOtaNonce net_ota_nonces[NET_OTA_NONCES];

static void net_ota_issue_nonce(char out[33]) {
  int slot = -1;
  for (int i = 0; i < NET_OTA_NONCES && slot < 0; i++)
    if (!net_ota_nonces[i].used) slot = i;
  if (slot < 0) {  // all busy: evict the oldest
    slot = 0;
    for (int i = 1; i < NET_OTA_NONCES; i++)
      if ((long)(net_ota_nonces[i].created - net_ota_nonces[slot].created) < 0) slot = i;
  }
  net_random_nonce(net_ota_nonces[slot].nonce);
  net_ota_nonces[slot].created = millis();
  net_ota_nonces[slot].used = true;
  memcpy(out, net_ota_nonces[slot].nonce, 33);
}

// Consumes the nonce whether or not it was valid-and-fresh (a nonce is good for exactly one attempt).
static bool net_ota_take_nonce(const String& n) {
  if (n.length() != 32 || !na_is_hex_lower(n.c_str(), 32)) return false;
  bool found = false;
  for (int i = 0; i < NET_OTA_NONCES; i++) {
    if (!net_ota_nonces[i].used) continue;
    if (na_ct_equal_fixed(net_ota_nonces[i].nonce, n.c_str(), 32)) {
      net_ota_nonces[i].used = false;
      found = (millis() - net_ota_nonces[i].created) <= 60000UL;
    }
  }
  return found;
}

static void net_http_reply(WiFiClient& c, int code, const char* text) {
  const char* reason = code == 200 ? "OK" : (code == 401 ? "Unauthorized" : (code == 429 ? "Too Many Requests" : "Error"));
  c.printf("HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s\n", code, reason,
           (int)strlen(text) + 1, text);
  c.flush();
  c.stop();
}

static void net_ota_draw(int pct, const char* msg) {
  // Small status strip at the bottom edge; the page is redrawn from config if the update fails.
  int w = (int)screenWidth - 40, y = (int)screenHeight - 34;
  gfx->fillRect(20, y - 24, w, 56, 0x0000);
  gfx->setTextSize(2);
  gfx->setTextColor(0xFFFF, 0x0000);
  gfx->setCursor(24, y - 20);
  gfx->print(msg);
  gfx->drawRect(20, y + 4, w, 20, 0xFD20);
  if (pct > 0) gfx->fillRect(22, y + 6, ((w - 4) * pct) / 100, 16, 0xFD20);
}

static void net_ota_finish_state() {
  if (net_ota_sha_live) {
    mbedtls_sha256_free(&net_ota_sha);
    net_ota_sha_live = false;
  }
  net_ota_state = OTA_IDLE;
  net_ota_begun = false;
  net_ota_head_len = 0;
  net_ota_received = 0;
  net_ota_last_pct = -1;
  net_ota_hdr_line = "";
  net_ota_hdr_bytes = 0;
}

static void net_ota_fail(int code, const char* msg) {
  if (net_ota_begun) Update.abort();
  net_http_reply(net_ota_client, code, msg);
  bool wasBody = net_ota_state == OTA_BODY;
  net_ota_finish_state();
  if (wasBody && !is_sleeping && !is_deep_sleeping) draw_page(current_page);  // repaint over the progress strip
}

static bool net_ota_app_image_ok(const uint8_t* h) {
  // ESP image magic 0xE9 + esp_app_desc_t magic 0xABCD5432 at offset 32 (the merged image has a bootloader there).
  return h[0] == 0xE9 && h[32] == 0x32 && h[33] == 0x54 && h[34] == 0xCD && h[35] == 0xAB;
}

static void net_ota_handle_request_line(const String& line) {
  if (net_ota_method.length() == 0 && net_ota_path.length() == 0 && line.indexOf(' ') > 0) {
    int a = line.indexOf(' '), b = line.indexOf(' ', a + 1);
    net_ota_method = line.substring(0, a);
    net_ota_path = b > a ? line.substring(a + 1, b) : line.substring(a + 1);
    return;
  }
  int c = line.indexOf(':');
  if (c <= 0) return;
  String k = line.substring(0, c);
  String v = line.substring(c + 1);
  k.trim();
  v.trim();
  k.toLowerCase();
  if (k == "x-smartdeck-nonce") net_ota_nonce_hdr = v;
  else if (k == "x-smartdeck-sha256") net_ota_sha_hdr = v;
  else if (k == "x-smartdeck-auth") net_ota_auth_hdr = v;
  else if (k == "content-length") net_ota_len = v.toInt();
}

static void net_ota_headers_complete() {
  if (net_ota_path == "/challenge") {  // hand out a fresh single-use nonce
    if (net_ota_method != "GET") return net_ota_fail(405, "GET only");
    char n[33];
    net_ota_issue_nonce(n);
    net_http_reply(net_ota_client, 200, n);
    net_ota_finish_state();
    return;
  }
  if (net_ota_path != "/update") return net_ota_fail(404, "not found");
  if (net_ota_method != "POST") return net_ota_fail(405, "POST only");

  // Authenticate BEFORE anything else: nonce (consumed even on failure), well-formed hash, then the HMAC over both.
  bool nonceOk = net_ota_take_nonce(net_ota_nonce_hdr);
  bool shaOk = net_ota_sha_hdr.length() == 64 && na_is_hex_lower(net_ota_sha_hdr.c_str(), 64);
  bool ok = false;
  if (nonceOk && shaOk) {
    char exp[65];
    if (net_hmac_for("ota:", net_ota_nonce_hdr.c_str(), net_ota_sha_hdr.c_str(), exp))
      ok = na_hmac_matches(net_ota_auth_hdr.c_str(), net_ota_auth_hdr.length(), exp);
  }
  net_ota_nonce_hdr = "";
  net_ota_auth_hdr = "";
  if (!ok) {
    net_note_auth_fail(net_ota_ip);
    return net_ota_fail(401, "unauthorized");
  }
  net_note_auth_ok(net_ota_ip);

  const esp_partition_t* p = esp_ota_get_next_update_partition(NULL);
  if (!p) return net_ota_fail(500, "no OTA slot");
  if (net_ota_len < 100000L) return net_ota_fail(400, "Content-Length missing or too small");
  if ((size_t)net_ota_len > p->size) return net_ota_fail(413, "image larger than OTA slot");
  mbedtls_sha256_init(&net_ota_sha);
  mbedtls_sha256_starts_ret(&net_ota_sha, 0);
  net_ota_sha_live = true;
  net_ota_state = OTA_BODY;
  net_ota_since = millis();
  net_ota_head_len = 0;
  net_ota_received = 0;
  net_ota_begun = false;
  net_ota_last_pct = -1;
}

static void net_ota_body_tick() {
  uint8_t buf[1024];
  int loops = 0;
  while (loops++ < 4 && net_ota_client.available() > 0 && net_ota_received < (size_t)net_ota_len) {
    size_t want = sizeof(buf);
    if (want > (size_t)net_ota_len - net_ota_received) want = (size_t)net_ota_len - net_ota_received;
    int n = net_ota_client.read(buf, want);
    if (n <= 0) break;
    net_ota_since = millis();
    mbedtls_sha256_update_ret(&net_ota_sha, buf, (size_t)n);  // [v4] hash everything we receive, in order
    size_t off = 0;
    if (!net_ota_begun) {  // buffer the first 64 bytes and validate before touching flash
      size_t take = 64 - net_ota_head_len;
      if (take > (size_t)n) take = n;
      memcpy(net_ota_head + net_ota_head_len, buf, take);
      net_ota_head_len += take;
      off = take;
      if (net_ota_head_len < 64) {
        net_ota_received += n;
        continue;
      }
      if (!net_ota_app_image_ok(net_ota_head)) return net_ota_fail(400, "not an app image (send smart_deck.ino.bin, not the merged image)");
      if (!Update.begin((size_t)net_ota_len, U_FLASH)) return net_ota_fail(500, Update.errorString());
      net_ota_begun = true;
      update_activity();  // wake the screen so the progress strip is visible
      net_ota_draw(0, "OTA UPDATE");
      if (Update.write(net_ota_head, 64) != 64) return net_ota_fail(500, Update.errorString());
    }
    if ((size_t)n > off) {
      size_t m = n - off;
      if (Update.write(buf + off, m) != m) return net_ota_fail(500, Update.errorString());
    }
    net_ota_received += n;
    int pct = (int)((uint64_t)net_ota_received * 100 / (uint64_t)net_ota_len);
    if (pct >= net_ota_last_pct + 2) {
      net_ota_last_pct = pct;
      char m[24];
      snprintf(m, sizeof(m), "OTA UPDATE %d%%", pct);
      net_ota_draw(pct, m);
    }
  }

  if (net_ota_received >= (size_t)net_ota_len) {
    if (!net_ota_begun) return net_ota_fail(500, "incomplete");
    // [v4] The hash the client signed must equal the hash of what we actually received. Only then is the slot activated.
    uint8_t dig[32];
    char got[65];
    mbedtls_sha256_finish_ret(&net_ota_sha, dig);
    na_hex(dig, 32, got);
    if (!na_ct_equal_fixed(got, net_ota_sha_hdr.c_str(), 64)) return net_ota_fail(400, "hash mismatch");  // Update.abort(): old slot stays active
    if (!Update.end() || !Update.isFinished()) return net_ota_fail(500, Update.errorString());
    net_ota_draw(100, "OTA OK - REBOOTING");
    net_http_reply(net_ota_client, 200, "OK");
    delay(300);
    ESP.restart();
  }
  if ((millis() - net_ota_since) > 15000UL) net_ota_fail(408, "timeout");
}

static void net_ota_tick() {
  if (!net_services_up) {
    if (net_ota_state != OTA_IDLE) {
      bool wasBody = net_ota_state == OTA_BODY;
      if (net_ota_begun) Update.abort();
      net_ota_client.stop();
      net_ota_finish_state();
      if (wasBody && !is_sleeping && !is_deep_sleeping) draw_page(current_page);  // WiFi dropped mid-OTA: clear the progress strip
    }
    return;
  }
  WiFiClient nc = net_ota_server.available();
  if (nc) {
    uint32_t ip = (uint32_t)nc.remoteIP();
    if (net_ota_state == OTA_BODY) net_http_reply(nc, 503, "update already in progress");
    else if (net_locked_out(ip)) net_http_reply(nc, 429, "locked out, retry later");
    else {
      if (net_ota_state == OTA_HEADERS) {  // an unauthenticated, still-sending-headers client must not starve a new one: evict it
        net_ota_client.stop();
        net_ota_finish_state();
      }
      net_ota_client = nc;
      net_ota_ip = ip;
      net_ota_state = OTA_HEADERS;
      net_ota_since = millis();
      net_ota_method = net_ota_path = net_ota_nonce_hdr = net_ota_sha_hdr = net_ota_auth_hdr = "";
      net_ota_len = -1;
      net_ota_hdr_line = "";
      net_ota_hdr_bytes = 0;
    }
  }

  if (net_ota_state == OTA_HEADERS) {
    while (net_ota_client.available() > 0 && net_ota_state == OTA_HEADERS) {
      int ch = net_ota_client.read();
      if (ch < 0) break;
      if (++net_ota_hdr_bytes > 1536) return net_ota_fail(431, "headers too large");
      if (ch == '\r') continue;
      if (ch == '\n') {
        if (net_ota_hdr_line.length() == 0) {
          net_ota_headers_complete();
          break;
        }
        net_ota_handle_request_line(net_ota_hdr_line);
        net_ota_hdr_line = "";
      } else if (net_ota_hdr_line.length() < 256) {
        net_ota_hdr_line += (char)ch;
      }
    }
    if (net_ota_state == OTA_HEADERS && (millis() - net_ota_since) > 5000UL) {  // slow/idle before authenticating: counts against that IP
      net_note_auth_fail(net_ota_ip);
      net_ota_fail(408, "header timeout");
    }
    if (net_ota_state == OTA_HEADERS && !net_ota_client.connected() && net_ota_client.available() == 0) net_ota_finish_state();
  }
  if (net_ota_state == OTA_BODY) {
    if (!net_ota_client.connected() && net_ota_client.available() == 0 && net_ota_received < (size_t)net_ota_len) {
      net_ota_fail(400, "connection closed early");
    } else {
      net_ota_body_tick();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// NTP (so the sleep clock works without a host)
// ---------------------------------------------------------------------------------------------------------------
static void net_ntp_tick() {
  if (net_state != NET_CONNECTED) return;
  unsigned long now = millis();
  if (!net_ntp_started) {
    configTzTime(net_cfg.tz.length() ? net_cfg.tz.c_str() : "UTC0", "pool.ntp.org", "time.cloudflare.com", "time.google.com");
    net_ntp_started = true;
    net_ntp_next = now + 1000;
    return;
  }
  if ((long)(now - net_ntp_next) < 0) return;
  struct tm t;
  if (getLocalTime(&t, 0) && t.tm_year >= 124) {  // year >= 2024: SNTP has set the clock
    bool hostRecent = net_last_host_time_ms != 0 && (now - net_last_host_time_ms) < 600000UL;
    if (!hostRecent) {  // never fight a host that is already supplying the time
      current_hour = t.tm_hour;
      current_minute = t.tm_min;
      current_second = t.tm_sec;
      last_clock_update_millis = now;
      clock_initialized = true;
    }
    if (!net_ntp_synced) {
      net_ntp_synced = true;
      net_status_changed();
    }
    net_ntp_next = now + (hostRecent ? 60000UL : 600000UL);
  } else {
    net_ntp_next = now + 2000;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Standalone actions: type "ha" and "http", run off-thread so touch/LEDs never block (timeouts <= 3 s)
// ---------------------------------------------------------------------------------------------------------------
struct NetActionJob {
  String method, url, body;
  std::vector<std::pair<String, String>> headers;
  int page, idx;
};
static volatile bool net_action_busy = false;
static volatile bool net_action_done = false;
static volatile int net_action_code = 0;
static volatile int net_action_page = 0, net_action_idx = 0;
// [live] The on-deck HA state poller (below) uses its own task but must never run at the same time as a button action
// (two TLS sessions would stress the heap). A button press that arrives while a poll is in flight is parked here and
// started as soon as the poll finishes; presses always win over polls.
static volatile bool live_ha_busy = false;
static NetActionJob* net_pending = nullptr;
static void live_ha_note_press(int page, int idx);  // defined with the HA poller below

static void net_action_task(void* param) {
  NetActionJob* j = (NetActionJob*)param;
  int code = -1;
  {
    HTTPClient http;
    WiFiClientSecure secure;
    WiFiClient plain;
    bool began;
    if (j->url.startsWith("https://")) {
      secure.setInsecure();  // documented trade-off: no CA bundle on the deck; LAN HA with self-signed certs works
      began = http.begin(secure, j->url);
    } else {
      began = http.begin(plain, j->url);
    }
    if (began) {
      http.setConnectTimeout(3000);
      http.setTimeout(3000);
      for (auto& h : j->headers) http.addHeader(h.first, h.second);
      code = http.sendRequest(j->method.c_str(), (uint8_t*)j->body.c_str(), j->body.length());
      http.end();
    }
  }
  net_action_page = j->page;
  net_action_idx = j->idx;
  net_action_code = code;
  __sync_synchronize();  // publish page/idx/code BEFORE the done flag (dual-core: the loop must not see done without them)
  net_action_done = true;
  delete j;
  net_action_busy = false;
  vTaskDelete(NULL);
}

static bool net_start_action(NetActionJob* j) {
  if (live_ha_busy && !net_action_busy) {  // [live] a state poll is running: park this press, it starts right after
    if (net_pending) delete net_pending;
    net_pending = j;
    return true;
  }
  if (net_action_busy) {
    delete j;
    Serial.println("[net] standalone action dropped: previous one still running");
    return true;  // consumed (a double tap must not turn into a host BTN line)
  }
  net_action_busy = true;
  if (xTaskCreatePinnedToCore(net_action_task, "net_act", 16384, j, 1, NULL, 0) != pdPASS) {
    net_action_busy = false;
    delete j;
    Serial.println("[net] standalone action: task create failed");
  }
  return true;
}

static bool net_header_name_ok(const String& s) {
  if (s.length() < 1 || s.length() > 40) return false;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return true;
}

static bool net_valid_domain_service(const String& s, String& dom, String& svc) {
  int dot = s.indexOf('.');
  if (dot < 1 || dot >= (int)s.length() - 1 || s.length() > 64) return false;
  dom = s.substring(0, dot);
  svc = s.substring(dot + 1);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '.' && (int)i == dot) continue;
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
  }
  return true;
}

// Standalone button execution (no host connected). cfg = this button's JSON from esp_config.json. Return true if executed.
bool net_button(JsonObject cfg, int page, int idx, bool hasState, bool state) {
  if (net_cfg.standalone == 2) return false;  // "never"
  const char* type = cfg["type"] | "";
  bool isHa = strcmp(type, "ha") == 0, isHttp = strcmp(type, "http") == 0;
  if (!isHa && !isHttp) return false;
  if (net_state != NET_CONNECTED) {
    Serial.println("[net] standalone action skipped: WiFi not connected");
    return false;
  }
  NetActionJob* j = new NetActionJob();
  j->page = page;
  j->idx = idx;

  if (isHa) {
    String dom, svc;
    JsonObject ha = cfg["ha"];
    if (net_cfg.haUrl.length() == 0 || net_cfg.haToken.length() == 0) {
      delete j;
      Serial.println("[net] standalone HA action skipped: Home Assistant not configured");
      return false;
    }
    if (ha.isNull() || !net_valid_domain_service(String((const char*)(ha["service"] | "")), dom, svc)) {
      delete j;
      Serial.println("[net] standalone HA action skipped: bad service");
      return false;
    }
    JsonDocument b;
    const char* entity = ha["entity"] | "";
    if (entity[0]) b["entity_id"] = entity;
    if (ha["data"].is<JsonObject>())
      for (JsonPair kv : ha["data"].as<JsonObject>()) b[kv.key()] = kv.value();
    serializeJson(b, j->body);
    if (j->body.length() > 1024) {
      delete j;
      return false;
    }
    String base = net_cfg.haUrl;
    while (base.endsWith("/")) base.remove(base.length() - 1);
    j->url = base + "/api/services/" + dom + "/" + svc;
    j->method = "POST";
    j->headers.push_back({"Authorization", String("Bearer ") + net_cfg.haToken});
    j->headers.push_back({"Content-Type", "application/json"});
    live_ha_note_press(page, idx);  // [live] re-read this button's entity state ~700 ms after the service call
    return net_start_action(j);
  }

  // type "http"
  JsonObject h = cfg["http"];
  String url = String((const char*)(h["url"] | ""));
  if (h.isNull() || !(url.startsWith("http://") || url.startsWith("https://")) || url.length() > 256) {
    delete j;
    Serial.println("[net] standalone http action skipped: bad url");
    return false;
  }
  String method = String((const char*)(h["method"] | "GET"));
  method.toUpperCase();
  if (method != "GET" && method != "POST" && method != "PUT" && method != "DELETE") {
    delete j;
    Serial.println("[net] standalone http action skipped: bad method");
    return false;
  }
  j->url = url;
  j->method = method;
  j->body = String((const char*)(h["body"] | ""));
  if (j->body.length() > 1024) j->body = j->body.substring(0, 1024);
  if (h["headers"].is<JsonObject>()) {
    for (JsonPair kv : h["headers"].as<JsonObject>()) {
      if (j->headers.size() >= 8) break;
      String k = String(kv.key().c_str());
      String v = kv.value().as<String>();
      if (!net_header_name_ok(k) || v.length() > 256 || v.indexOf('\r') >= 0 || v.indexOf('\n') >= 0) continue;
      j->headers.push_back({k, v});
    }
  }
  return net_start_action(j);
}

static void net_action_result_tick() {
  if (!net_action_done) return;
  __sync_synchronize();  // pairs with the barrier in the task: read the result only after seeing the flag
  net_action_done = false;
  Serial.printf("[net] action %d:%d -> HTTP %d\n", (int)net_action_page, (int)net_action_idx, (int)net_action_code);  // never log URLs/tokens
}

// ---------------------------------------------------------------------------------------------------------------
// On-deck Home Assistant state ("ha_state" on a button) -- standalone wall-panel use. See PROTOCOL.md "v3 additions".
// Polls GET <ha_url>/api/states/<entity> for the ha_state buttons of the CURRENT page and shows the result through the
// RAM-only live table (live_table.h), so nothing is ever written to the SD card.
// Runs only when: WiFi up, HA configured, deck awake, standalone != never, and (no host present OR standalone == always).
// ---------------------------------------------------------------------------------------------------------------
#define LIVE_HA_MAX 8
#define LIVE_HA_DEFAULT_S 10
#define LIVE_HA_MIN_S 5
#define LIVE_HA_REPOLL_MS 700UL
#define LIVE_HA_GAP_MS 250UL  // minimum spacing between two polls (sequential, never hammering HA)

struct LiveHaEntry {
  bool used;
  uint8_t idx;
  uint32_t intervalMs;
  unsigned long nextDue;
  char entity[65];
  LiveHaCfg cfg;
};
static LiveHaEntry live_ha[LIVE_HA_MAX];
static int live_ha_page = -1;
static unsigned long live_ha_rescan_at = 0;
static unsigned long live_ha_gap_until = 0;

// Result handed from the poll task to the main loop (the task only writes these, then sets live_ha_done last).
static volatile bool live_ha_done = false;
static volatile int live_ha_res_page = 0, live_ha_res_idx = 0, live_ha_res_code = 0;
static char live_ha_res_state[32];

struct LiveHaJob {
  String url, token;
  int page, idx;
};

static bool live_ha_gate() {
  if (net_state != NET_CONNECTED) return false;
  if (net_cfg.standalone == 2) return false;  // "never" disables all on-deck HA work
  if (net_cfg.haUrl.length() == 0 || net_cfg.haToken.length() == 0) return false;
  if (is_sleeping || is_deep_sleeping) return false;
  return !host_link_active() || net_cfg.standalone == 1;
}

// Rebuild the poll list for the current page from the button JSON (cheap: <= 64 buttons, at most every 3 s / page change).
static void live_ha_scan(unsigned long now) {
  LiveHaEntry fresh[LIVE_HA_MAX];
  memset(fresh, 0, sizeof(fresh));
  int n = 0;
  JsonArray btns = doc["pages"][current_page]["buttons"];
  int total = btns.isNull() ? 0 : (int)btns.size();
  for (int i = 0; i < total && i < 64 && n < LIVE_HA_MAX; i++) {
    JsonObject hs = btns[i]["ha_state"];
    if (hs.isNull()) continue;
    const char* entity = hs["entity"] | "";
    if (!live_entity_ok(entity)) continue;
    LiveHaEntry& e = fresh[n];
    e.used = true;
    e.idx = (uint8_t)i;
    strncpy(e.entity, entity, sizeof(e.entity) - 1);
    int iv = hs["interval"].is<int>() ? hs["interval"].as<int>() : LIVE_HA_DEFAULT_S;
    if (iv < LIVE_HA_MIN_S) iv = LIVE_HA_MIN_S;
    if (iv > 3600) iv = 3600;
    e.intervalMs = (uint32_t)iv * 1000UL;
    uint16_t c;
    if (hs["on"].is<const char*>() && live_hex6(hs["on"].as<const char*>(), &c)) { e.cfg.on565 = c; e.cfg.has |= LIVE_HA_H_ON; }
    if (hs["off"].is<const char*>() && live_hex6(hs["off"].as<const char*>(), &c)) { e.cfg.off565 = c; e.cfg.has |= LIVE_HA_H_OFF; }
    if (hs["label_on"].is<const char*>()) { live_sanitize_label(hs["label_on"].as<const char*>(), e.cfg.label_on, LIVE_LABEL_MAX); e.cfg.has |= LIVE_HA_H_LABEL_ON; }
    if (hs["label_off"].is<const char*>()) { live_sanitize_label(hs["label_off"].as<const char*>(), e.cfg.label_off, LIVE_LABEL_MAX); e.cfg.has |= LIVE_HA_H_LABEL_OFF; }
    e.nextDue = now;  // new entries poll immediately; existing ones keep their schedule (below)
    for (int k = 0; k < LIVE_HA_MAX; k++)
      if (live_ha_page == current_page && live_ha[k].used && live_ha[k].idx == e.idx && strcmp(live_ha[k].entity, e.entity) == 0) {
        e.nextDue = live_ha[k].nextDue;
        break;
      }
    n++;
  }
  memcpy(live_ha, fresh, sizeof(live_ha));
  live_ha_page = current_page;
  live_ha_rescan_at = now + 3000UL;
}

// Called from net_button() right after an `ha` button fires its service call: refresh that button's state soon.
static void live_ha_note_press(int page, int idx) {
  if (page != live_ha_page) return;
  for (int k = 0; k < LIVE_HA_MAX; k++)
    if (live_ha[k].used && live_ha[k].idx == idx) live_ha[k].nextDue = millis() + LIVE_HA_REPOLL_MS;
}

static void live_ha_task(void* param) {
  LiveHaJob* j = (LiveHaJob*)param;
  int code = -1;
  char state[32];
  state[0] = '\0';
  {
    HTTPClient http;
    WiFiClientSecure secure;
    WiFiClient plain;
    bool began;
    if (j->url.startsWith("https://")) {
      secure.setInsecure();  // same documented trade-off as the HA service call
      began = http.begin(secure, j->url);
    } else {
      began = http.begin(plain, j->url);
    }
    if (began) {
      http.setConnectTimeout(3000);
      http.setTimeout(3000);
      http.addHeader("Authorization", String("Bearer ") + j->token);
      http.addHeader("Accept", "application/json");
      code = http.GET();
      if (code == 200) {
        JsonDocument filter;
        filter["state"] = true;  // the response also carries all attributes (can be many KB): keep only "state"
        JsonDocument d;
        DeserializationError err;
        int sz = http.getSize();
        if (sz > 0 && sz <= 65536) {
          err = deserializeJson(d, http.getStream(), DeserializationOption::Filter(filter));
        } else if (sz < 0) {  // chunked: let HTTPClient de-chunk (rare for HA)
          String body = http.getString();
          err = body.length() <= 65536 ? deserializeJson(d, body, DeserializationOption::Filter(filter)) : DeserializationError::NoMemory;
        } else {
          err = DeserializationError::NoMemory;
        }
        if (!err && d["state"].is<const char*>()) strncpy(state, d["state"].as<const char*>(), sizeof(state) - 1);
        else code = -2;
        state[sizeof(state) - 1] = '\0';
      }
      http.end();
    }
  }
  strncpy(live_ha_res_state, state, sizeof(live_ha_res_state));
  live_ha_res_page = j->page;
  live_ha_res_idx = j->idx;
  live_ha_res_code = code;
  delete j;
  __sync_synchronize();  // publish the result fields before the flag
  live_ha_done = true;
  vTaskDelete(NULL);
}

static void live_ha_tick() {
  unsigned long now = millis();

  // 1. consume a finished poll
  if (live_ha_done) {
    live_ha_done = false;
    int page = live_ha_res_page, idx = live_ha_res_idx;
    for (int k = 0; k < LIVE_HA_MAX; k++) {
      if (!live_ha[k].used || live_ha[k].idx != idx || page != live_ha_page) continue;
      LiveUpdate u;
      live_ha_map(live_ha_res_code == 200 ? live_ha_res_state : "", live_ha[k].cfg, &u);
      if (live_commit(page, idx, u)) live_redraw(page, idx);
      live_ha[k].nextDue = now + live_ha[k].intervalMs;
      break;
    }
    live_ha_gap_until = now + LIVE_HA_GAP_MS;
    live_ha_busy = false;
  }

  // 2. a press parked while a poll was running goes first
  if (net_pending && !live_ha_busy && !net_action_busy) {
    NetActionJob* j = net_pending;
    net_pending = nullptr;
    net_start_action(j);
    return;
  }

  // 3. maybe start the next poll
  if (live_ha_busy || net_action_busy || net_pending || (long)(now - live_ha_gap_until) < 0) return;
  if (!live_ha_gate()) return;
  if (live_ha_page != current_page || (long)(now - live_ha_rescan_at) >= 0) live_ha_scan(now);
  int best = -1;
  for (int k = 0; k < LIVE_HA_MAX; k++) {
    if (!live_ha[k].used || (long)(now - live_ha[k].nextDue) < 0) continue;
    if (best < 0 || (long)(live_ha[k].nextDue - live_ha[best].nextDue) < 0) best = k;
  }
  if (best < 0) return;
  String base = net_cfg.haUrl;
  while (base.endsWith("/")) base.remove(base.length() - 1);
  LiveHaJob* j = new LiveHaJob();
  j->url = base + "/api/states/" + String(live_ha[best].entity);
  j->token = net_cfg.haToken;
  j->page = current_page;
  j->idx = live_ha[best].idx;
  live_ha[best].nextDue = now + live_ha[best].intervalMs;  // reschedule now so a task failure cannot spin
  live_ha_busy = true;
  if (xTaskCreatePinnedToCore(live_ha_task, "live_ha", 16384, j, 1, NULL, 0) != pdPASS) {
    live_ha_busy = false;
    delete j;
    Serial.println("[net] HA state poll: task create failed");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Module entry points
// ---------------------------------------------------------------------------------------------------------------
void net_setup() {
  net_load_config();
  // WiFi is brought up lazily by net_wifi_tick() once an SSID has been provisioned.
}

void net_loop() {
  net_wifi_tick();
  net_tcp_tick();
  net_ota_tick();
  net_ntp_tick();
  net_action_result_tick();
  live_ha_tick();
  Serial.flushTcp();
  if (net_apply_at == 0 && net_status_dirty && (millis() - net_last_status_ms) >= 2000UL) net_emit_status();
}

bool net_command(const String& c) {
  if (c.startsWith("SET_TIME:")) {  // not consumed: the legacy handler sets the clock; we just note a host is supplying time
    net_last_host_time_ms = millis();
    if (net_last_host_time_ms == 0) net_last_host_time_ms = 1;
    return false;
  }
  if (c.startsWith("SET_NET:")) {
    const char* err = net_apply_set_net(c.substring(8));
    if (err) Serial.printf("NET_SET:err:%s\n", err);
    else Serial.println("NET_SET:ok");
    return true;
  }
  if (c == "GET_NET") {
    net_emit_status();
    return true;
  }
  return false;
}

#endif
