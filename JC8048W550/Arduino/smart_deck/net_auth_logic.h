// net_auth_logic.h -- pure (no Arduino/ESP dependencies) logic for the v4 security hardening, unit-testable on a PC.
// OWNER: fork "fw-auth". See companion-mac/PROTOCOL.md section "v4: security hardening".
//   * HMAC-SHA256 built over an injected one-shot SHA-256 (firmware passes mbedtls_sha256_ret; the host test passes a reference)
//   * lowercase hex, fixed-length constant-time compare
//   * per-source-IP failure/lockout table (LRU)
//   * upload filename / size validation
#ifndef NET_AUTH_LOGIC_H
#define NET_AUTH_LOGIC_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>

// ---------------------------------------------------------------------------------------------------------------
// HMAC-SHA256
// ---------------------------------------------------------------------------------------------------------------
typedef void (*NaSha256Fn)(const uint8_t* data, size_t len, uint8_t out[32]);
#define NA_HMAC_MAX_MSG 192  // "ota:" + 32 + ":" + 64 = 101 bytes in practice

// Returns false if the message is longer than NA_HMAC_MAX_MSG (fixed stack buffers, no heap).
static inline bool na_hmac_sha256(NaSha256Fn sha, const uint8_t* key, size_t klen, const uint8_t* msg, size_t mlen, uint8_t out[32]) {
  if (mlen > NA_HMAC_MAX_MSG) return false;
  uint8_t k0[64];
  memset(k0, 0, sizeof(k0));
  if (klen > 64) sha(key, klen, k0);  // key longer than the block: hash it first (first 32 bytes, rest stays 0)
  else if (klen) memcpy(k0, key, klen);
  uint8_t inner[64 + NA_HMAC_MAX_MSG];
  uint8_t outer[64 + 32];
  for (int i = 0; i < 64; i++) {
    inner[i] = k0[i] ^ 0x36;
    outer[i] = k0[i] ^ 0x5c;
  }
  if (mlen) memcpy(inner + 64, msg, mlen);
  sha(inner, 64 + mlen, outer + 64);  // inner hash goes straight into the outer buffer
  sha(outer, 64 + 32, out);
  return true;
}

static inline void na_hex(const uint8_t* in, size_t n, char* out) {  // out needs 2n+1 bytes
  static const char H[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = H[in[i] >> 4];
    out[2 * i + 1] = H[in[i] & 15];
  }
  out[2 * n] = 0;
}

// Hex HMAC of an ASCII message with an ASCII key (the token). out needs 65 bytes.
static inline bool na_hmac_hex(NaSha256Fn sha, const char* token, const char* msg, char out[65]) {
  uint8_t d[32];
  if (!na_hmac_sha256(sha, (const uint8_t*)token, strlen(token), (const uint8_t*)msg, strlen(msg), d)) return false;
  na_hex(d, 32, out);
  return true;
}

// Always inspects all n bytes (no early exit). Both buffers must hold n bytes.
static inline bool na_ct_equal_fixed(const char* a, const char* b, size_t n) {
  uint8_t diff = 0;
  for (size_t i = 0; i < n; i++) diff |= (uint8_t)a[i] ^ (uint8_t)b[i];
  return diff == 0;
}

// Compare a received (variable-length, possibly attacker-controlled) hex string against the expected 64-char HMAC without
// leaking where/whether the lengths differ: the received text is copied into a zero-padded 64-byte buffer and the
// length mismatch is folded into the result AFTER the full-length compare.
static inline bool na_hmac_matches(const char* received, size_t rlen, const char* expected64) {
  char buf[64];
  memset(buf, 0, sizeof(buf));
  size_t n = rlen < 64 ? rlen : 64;
  if (received && n) memcpy(buf, received, n);
  bool eq = na_ct_equal_fixed(buf, expected64, 64);
  return eq && rlen == 64;
}

static inline bool na_is_hex_lower(const char* s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-source-IP lockout: 5 failures within a 60 s window => that IP is refused for 30 s. Other IPs are unaffected.
// ---------------------------------------------------------------------------------------------------------------
#define NA_IP_SLOTS 8
#define NA_FAIL_LIMIT 5
#define NA_FAIL_WINDOW_MS 60000UL
#define NA_LOCKOUT_MS 30000UL

struct NaIpEntry {
  bool used;
  bool locked;
  uint8_t fails;
  uint32_t ip;
  uint32_t winStart;
  uint32_t lockUntil;
  uint32_t lastUse;
};

struct NaIpTable {
  NaIpEntry e[NA_IP_SLOTS];

  NaIpTable() { memset(e, 0, sizeof(e)); }

  static bool reached(uint32_t now, uint32_t t) { return (int32_t)(now - t) >= 0; }  // rollover-safe "now >= t"

  NaIpEntry* find(uint32_t ip) {
    for (int i = 0; i < NA_IP_SLOTS; i++)
      if (e[i].used && e[i].ip == ip) return &e[i];
    return nullptr;
  }

  static NaIpEntry* claim(NaIpEntry* s, uint32_t ip, uint32_t now) {
    s->used = true;
    s->locked = false;
    s->fails = 0;
    s->ip = ip;
    s->winStart = now;
    s->lockUntil = 0;
    s->lastUse = now;
    return s;
  }

  // Free slot, else evict the least-recently-used UNLOCKED entry; if every entry is locked, the one whose lock ends first.
  NaIpEntry* slotFor(uint32_t ip, uint32_t now) {
    for (int i = 0; i < NA_IP_SLOTS; i++)
      if (!e[i].used) return claim(&e[i], ip, now);
    NaIpEntry* victim = nullptr;
    for (int i = 0; i < NA_IP_SLOTS; i++) {
      if (e[i].locked && !reached(now, e[i].lockUntil)) continue;  // still serving a lockout: keep it
      if (!victim || (int32_t)(e[i].lastUse - victim->lastUse) < 0) victim = &e[i];
    }
    if (!victim) {
      victim = &e[0];
      for (int i = 1; i < NA_IP_SLOTS; i++)
        if ((int32_t)(e[i].lockUntil - victim->lockUntil) < 0) victim = &e[i];
    }
    return claim(victim, ip, now);
  }

  bool isLocked(uint32_t ip, uint32_t now) {
    NaIpEntry* s = find(ip);
    if (!s || !s->locked) return false;
    if (reached(now, s->lockUntil)) {
      s->locked = false;
      s->fails = 0;
      return false;
    }
    return true;
  }

  void noteFail(uint32_t ip, uint32_t now) {
    NaIpEntry* s = find(ip);
    if (!s) s = slotFor(ip, now);
    s->lastUse = now;
    if (s->locked && !reached(now, s->lockUntil)) return;  // already locked: do not extend (an attacker could otherwise pin it)
    if (s->locked) {                                       // lock expired
      s->locked = false;
      s->fails = 0;
      s->winStart = now;
    }
    if ((uint32_t)(now - s->winStart) > NA_FAIL_WINDOW_MS) {  // old failures expire
      s->fails = 0;
      s->winStart = now;
    }
    if (s->fails < 255) s->fails++;
    if (s->fails >= NA_FAIL_LIMIT) {
      s->locked = true;
      s->lockUntil = now + NA_LOCKOUT_MS;
    }
  }

  void noteSuccess(uint32_t ip) {
    NaIpEntry* s = find(ip);
    if (s) {
      s->fails = 0;
      s->locked = false;
    }
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Upload validation (FILE:<name>:<size>)
// ---------------------------------------------------------------------------------------------------------------
#define NA_UPLOAD_MAX_BYTES 8388608L  // 8 MB

// ^[A-Za-z0-9._-]{1,48}$ and must not start with a dot (also rules out "..").
static inline bool na_filename_ok(const char* s) {
  if (!s) return false;
  size_t n = strlen(s);
  if (n < 1 || n > 48 || s[0] == '.') return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

// Digits only (no sign, no spaces), value in 1..8 MB.
static inline bool na_parse_upload_size(const char* s, long* out) {
  if (!s || !*s) return false;
  size_t n = strlen(s);
  if (n > 8) return false;
  long v = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
    v = v * 10 + (s[i] - '0');
  }
  if (v < 1 || v > NA_UPLOAD_MAX_BYTES) return false;
  *out = v;
  return true;
}

// Every write must store exactly what was handed to it.
static inline bool na_write_complete(size_t written, size_t requested) { return written == requested; }

#endif
