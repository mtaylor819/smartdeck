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
#include <time.h>
#include <vector>

#define NET_FW_VERSION "2.5.1-mac0"
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

// Auth failure throttle shared by the TCP link and OTA.
static uint8_t net_auth_fails = 0;
static unsigned long net_lockout_until = 0;

static WiFiServer net_tcp_server(NET_TCP_PORT);
static WiFiServer net_ota_server(NET_OTA_PORT);
static bool net_services_up = false;

static WiFiClient net_tcp_auth;  // authenticated host link
static WiFiClient net_tcp_pend;  // connected, waiting for AUTH
static unsigned long net_tcp_pend_since = 0;
static char net_tcp_pend_buf[160];
static size_t net_tcp_pend_len = 0;
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
static bool net_ct_equal(const String& a, const String& b) {
  // Constant-time w.r.t. content; length difference is folded into the result.
  size_t n = a.length() > b.length() ? a.length() : b.length();
  uint8_t diff = (uint8_t)(a.length() != b.length());
  for (size_t i = 0; i < n; i++) {
    uint8_t x = i < a.length() ? (uint8_t)a[i] : 0;
    uint8_t y = i < b.length() ? (uint8_t)b[i] : 0;
    diff |= x ^ y;
  }
  return diff == 0;
}

static bool net_locked_out() {
  if (net_lockout_until == 0) return false;
  if ((long)(millis() - net_lockout_until) >= 0) {
    net_lockout_until = 0;
    net_auth_fails = 0;
    return false;
  }
  return true;
}

static void net_note_auth_fail() {
  if (++net_auth_fails >= 5) {
    net_lockout_until = millis() + 30000UL;
    if (net_lockout_until == 0) net_lockout_until = 1;
  }
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

  // Commit (all validated).
  net_prefs.putString("ssid", n.ssid);
  net_prefs.putString("pass", n.pass);
  net_prefs.putString("host", n.host);
  net_prefs.putString("token", n.token);
  net_prefs.putString("ha_url", n.haUrl);
  net_prefs.putString("ha_tok", n.haToken);
  net_prefs.putString("tz", n.tz);
  net_prefs.putUChar("sa", n.standalone);
  net_prefs.putBool("wifi", n.wifi);
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
  net_tcp_pend.stop();
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
static void net_tcp_reject(WiFiClient& c) {
  c.stop();
}

static void net_tcp_process_auth_line(const String& line) {
  bool ok = false;
  if (line.startsWith("AUTH:") && net_cfg.token.length() >= 8) ok = net_ct_equal(line.substring(5), net_cfg.token);
  if (!ok) {
    net_note_auth_fail();
    net_tcp_pend.print("AUTH_FAIL\n");
    net_tcp_pend.flush();
    net_tcp_pend.stop();
    return;
  }
  net_auth_fails = 0;
  net_tcp_pend.print("AUTH_OK\n");
  if (net_tcp_auth.connected()) net_tcp_auth.stop();  // newest authenticated client replaces the old one
  Serial.setTcp(nullptr);
  net_tcp_auth = net_tcp_pend;  // shares the socket handle
  net_tcp_pend = WiFiClient();  // drop our extra reference WITHOUT closing the socket
  net_tcp_auth.setNoDelay(true);
  net_tcp_line = "";
  net_tcp_overflow = false;
  Serial.setTcp(&net_tcp_auth);
  net_status_changed();
}

static void net_tcp_tick() {
  if (!net_services_up) return;

  // new connections
  WiFiClient nc = net_tcp_server.available();
  if (nc) {
    if (net_locked_out() || net_tcp_pend.connected()) {
      net_tcp_reject(nc);
    } else {
      net_tcp_pend = nc;
      net_tcp_pend.setNoDelay(true);
      net_tcp_pend_since = millis();
      net_tcp_pend_len = 0;
    }
  }

  // pending client: waiting for "AUTH:<token>\n"
  if (net_tcp_pend.connected()) {
    bool done = false;
    while (!done && net_tcp_pend.available() > 0) {
      int ch = net_tcp_pend.read();
      if (ch < 0) break;
      if (ch == '\r') continue;
      if (ch == '\n') {
        net_tcp_pend_buf[net_tcp_pend_len] = 0;
        String line(net_tcp_pend_buf);
        net_tcp_pend_len = 0;
        net_tcp_process_auth_line(line);
        done = true;
      } else if (net_tcp_pend_len < sizeof(net_tcp_pend_buf) - 1) {
        net_tcp_pend_buf[net_tcp_pend_len++] = (char)ch;
      } else {  // absurdly long first line
        net_note_auth_fail();
        net_tcp_pend.stop();
        done = true;
      }
    }
    if (!done && net_tcp_pend.connected() && (millis() - net_tcp_pend_since) > 5000UL) net_tcp_pend.stop();  // idle, no AUTH
  }

  // authenticated client liveness
  bool up = net_tcp_auth.connected();
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
enum NetOtaState { OTA_IDLE, OTA_HEADERS, OTA_BODY };
static NetOtaState net_ota_state = OTA_IDLE;
static WiFiClient net_ota_client;
static unsigned long net_ota_since = 0;       // when the current state began / last data seen
static String net_ota_hdr_line;
static size_t net_ota_hdr_bytes = 0;
static String net_ota_method, net_ota_path, net_ota_token_hdr;
static long net_ota_len = -1;
static uint8_t net_ota_head[64];
static size_t net_ota_head_len = 0;
static bool net_ota_begun = false;
static size_t net_ota_received = 0;
static int net_ota_last_pct = -1;
static bool net_ota_in_progress() { return net_ota_state == OTA_BODY; }

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
  if (k == "x-smartdeck-token") net_ota_token_hdr = v;
  else if (k == "content-length") net_ota_len = v.toInt();
}

static void net_ota_headers_complete() {
  if (net_ota_path != "/update") return net_ota_fail(404, "not found");
  if (net_ota_method != "POST") return net_ota_fail(405, "POST only");
  bool ok = net_cfg.token.length() >= 8 && net_ct_equal(net_ota_token_hdr, net_cfg.token);
  net_ota_token_hdr = "";
  if (!ok) {
    net_note_auth_fail();
    return net_ota_fail(401, "unauthorized");
  }
  net_auth_fails = 0;
  const esp_partition_t* p = esp_ota_get_next_update_partition(NULL);
  if (!p) return net_ota_fail(500, "no OTA slot");
  if (net_ota_len < 100000L) return net_ota_fail(400, "Content-Length missing or too small");
  if ((size_t)net_ota_len > p->size) return net_ota_fail(413, "image larger than OTA slot");
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
    if (!net_ota_begun || !Update.end() || !Update.isFinished()) return net_ota_fail(500, net_ota_begun ? Update.errorString() : "incomplete");
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
      if (net_ota_begun) Update.abort();
      net_ota_client.stop();
      net_ota_finish_state();
    }
    return;
  }
  WiFiClient nc = net_ota_server.available();
  if (nc) {
    if (net_ota_state != OTA_IDLE) net_http_reply(nc, 503, "update already in progress");
    else if (net_locked_out()) net_http_reply(nc, 429, "locked out, retry later");
    else {
      net_ota_client = nc;
      net_ota_state = OTA_HEADERS;
      net_ota_since = millis();
      net_ota_method = net_ota_path = net_ota_token_hdr = "";
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
    if (net_ota_state == OTA_HEADERS && (millis() - net_ota_since) > 5000UL) net_ota_fail(408, "header timeout");
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
  net_action_done = true;
  delete j;
  net_action_busy = false;
  vTaskDelete(NULL);
}

static bool net_start_action(NetActionJob* j) {
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
  net_action_done = false;
  Serial.printf("[net] action %d:%d -> HTTP %d\n", (int)net_action_page, (int)net_action_idx, (int)net_action_code);  // never log URLs/tokens
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
