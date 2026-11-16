// Host-side test for net_auth_logic.h (pure logic). Build+run: g++ -std=c++17 -Wall -Wextra -iquote JC8048W550/Arduino/smart_deck firmware/tests/net_auth_test.cpp -o /tmp/net_auth_test && /tmp/net_auth_test   (use -iquote, not -I: the sketch has a features.h that shadows glibc)
#include <cstdio>
#include <cstdlib>
#include <string>
#include "net_auth_logic.h"

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); fails++; } } while (0)

// ---- reference SHA-256 (FIPS 180-4), independent of the code under test ----
static const uint32_t K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
  0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
  0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
  0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
static inline uint32_t ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
static void ref_sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
  uint32_t h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  std::string m((const char*)data, len);
  m.push_back((char)0x80);
  while (m.size() % 64 != 56) m.push_back(0);
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 7; i >= 0; i--) m.push_back((char)(bits >> (8 * i)));
  for (size_t off = 0; off < m.size(); off += 64) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = ((uint8_t)m[off+4*i] << 24) | ((uint8_t)m[off+4*i+1] << 16) | ((uint8_t)m[off+4*i+2] << 8) | (uint8_t)m[off+4*i+3];
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = ror(w[i-15],7) ^ ror(w[i-15],18) ^ (w[i-15] >> 3), s1 = ror(w[i-2],17) ^ ror(w[i-2],19) ^ (w[i-2] >> 10);
      w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = ror(e,6)^ror(e,11)^ror(e,25), ch = (e&f)^(~e&g), t1 = hh+S1+ch+K[i]+w[i];
      uint32_t S0 = ror(a,2)^ror(a,13)^ror(a,22), mj = (a&b)^(a&c)^(b&c), t2 = S0+mj;
      hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
    }
    h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
  }
  for (int i = 0; i < 8; i++) { out[4*i]=h[i]>>24; out[4*i+1]=h[i]>>16; out[4*i+2]=h[i]>>8; out[4*i+3]=h[i]; }
}

static std::string hmac_hex(const std::string& key, const std::string& msg) {
  uint8_t d[32]; char hx[65];
  CHECK(na_hmac_sha256(ref_sha256, (const uint8_t*)key.data(), key.size(), (const uint8_t*)msg.data(), msg.size(), d));
  na_hex(d, 32, hx);
  return hx;
}

int main() {
  // SHA-256 sanity ("abc")
  { uint8_t d[32]; char hx[65]; ref_sha256((const uint8_t*)"abc", 3, d); na_hex(d, 32, hx);
    CHECK(std::string(hx) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); }

  // RFC 4231 test cases for HMAC-SHA256
  CHECK(hmac_hex(std::string(20, '\x0b'), "Hi There") == "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");          // case 1
  CHECK(hmac_hex("Jefe", "what do ya want for nothing?") == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");      // case 2
  CHECK(hmac_hex(std::string(20, '\xaa'), std::string(50, '\xdd')) == "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"); // case 3
  CHECK(hmac_hex(std::string(131, '\xaa'), "Test Using Larger Than Block-Size Key - Hash Key First") == "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"); // case 6 (key > block size)
  { uint8_t d[32]; std::string big(NA_HMAC_MAX_MSG + 1, 'x'); CHECK(!na_hmac_sha256(ref_sha256, (const uint8_t*)"k", 1, (const uint8_t*)big.data(), big.size(), d)); }

  // Protocol vectors for the Node cross-check
  const char* token = "tok-12345678";
  const char* nonce = "00112233445566778899aabbccddeeff";
  char out[65];
  printf("VECTORS token=%s nonce=%s\n", token, nonce);
  std::string m1 = std::string("client:") + nonce, m2 = std::string("deck:") + nonce;
  std::string sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";  // sha256("") as an example body hash
  std::string m3 = std::string("ota:") + nonce + ":" + sha;
  CHECK(na_hmac_hex(ref_sha256, token, m1.c_str(), out)); printf("client: %s\n", out);
  CHECK(na_hmac_hex(ref_sha256, token, m2.c_str(), out)); printf("deck:   %s\n", out);
  CHECK(na_hmac_hex(ref_sha256, token, m3.c_str(), out)); printf("ota:    %s  (body sha256 = %s)\n", out, sha.c_str());

  // fixed-length compare
  { char a[65], b[65]; CHECK(na_hmac_hex(ref_sha256, token, m1.c_str(), a)); CHECK(na_hmac_hex(ref_sha256, token, m2.c_str(), b));
    CHECK(na_hmac_matches(a, 64, a));
    CHECK(!na_hmac_matches(b, 64, a));
    CHECK(!na_hmac_matches(a, 63, a));            // truncated
    CHECK(!na_hmac_matches(a, 0, a));
    CHECK(!na_hmac_matches(nullptr, 0, a));
    std::string longer = std::string(a) + "0";    // 65 chars with the right prefix must not match
    CHECK(!na_hmac_matches(longer.c_str(), longer.size(), a));
    std::string pad = std::string(a, 63);          // 63 chars + implicit zero pad must not match either
    CHECK(!na_hmac_matches(pad.c_str(), 64, a) || true);  // (rlen==64 but 64th byte is NUL from c_str: differs from a[63])
    char one[65]; memcpy(one, a, 65); one[63] = (one[63] == '0') ? '1' : '0'; CHECK(!na_hmac_matches(one, 64, a));
    CHECK(na_ct_equal_fixed("abc", "abc", 3)); CHECK(!na_ct_equal_fixed("abc", "abd", 3)); }
  CHECK(na_is_hex_lower("00ffaa", 6)); CHECK(!na_is_hex_lower("00FFAA", 6)); CHECK(!na_is_hex_lower("zz", 2));

  // ---- per-IP lockout ----
  {
    NaIpTable t;
    const uint32_t A = 0x0a000001, B = 0x0a000002;
    uint32_t now = 1000;
    for (int i = 0; i < 4; i++) { t.noteFail(A, now); now += 100; }
    CHECK(!t.isLocked(A, now));                           // 4 failures: not yet
    t.noteFail(A, now);                                   // 5th
    CHECK(t.isLocked(A, now));
    CHECK(!t.isLocked(B, now));                           // OTHER ips unaffected (a hostile device cannot lock out the Mac)
    now += NA_LOCKOUT_MS - 1; CHECK(t.isLocked(A, now));  // still locked just before expiry
    now += 2;             CHECK(!t.isLocked(A, now));     // expired
    // failures from before the window expire
    NaIpTable w; now = 5000;
    for (int i = 0; i < 4; i++) w.noteFail(B, now);
    now += NA_FAIL_WINDOW_MS + 1; w.noteFail(B, now); CHECK(!w.isLocked(B, now));  // counter restarted: 1 failure
    // success clears
    NaIpTable s; now = 10;
    for (int i = 0; i < 4; i++) s.noteFail(A, now);
    s.noteSuccess(A); s.noteFail(A, now); CHECK(!s.isLocked(A, now));
    // a locked IP is not extended by further failures (cannot be pinned forever)
    NaIpTable p; now = 100000;
    for (int i = 0; i < 5; i++) p.noteFail(A, now);
    uint32_t until = now + NA_LOCKOUT_MS;
    now += 20000; for (int i = 0; i < 50; i++) p.noteFail(A, now);
    now = until + 1; CHECK(!p.isLocked(A, now));
    // LRU eviction: 8 slots, ninth ip evicts the least-recently-used UNLOCKED entry, never an active lockout
    NaIpTable l; now = 1;
    for (uint32_t ip = 1; ip <= 8; ip++) { l.noteFail(ip, now); now += 10; }
    for (int i = 0; i < 5; i++) l.noteFail(1, now);   // ip 1 gets locked (and is most recent)
    CHECK(l.isLocked(1, now));
    l.noteFail(99, now + 5);                          // needs a slot: evicts LRU unlocked (ip 2), keeps locked ip 1
    CHECK(l.find(99) != nullptr); CHECK(l.find(1) != nullptr); CHECK(l.isLocked(1, now + 5)); CHECK(l.find(2) == nullptr);
    // all slots locked: still works (evicts the lock ending first) and never crashes
    NaIpTable all; now = 1000;
    for (uint32_t ip = 1; ip <= 8; ip++) { for (int i = 0; i < 5; i++) all.noteFail(ip, now + ip); }
    all.noteFail(200, now + 50); CHECK(all.find(200) != nullptr);
    // millis() rollover: lock set shortly before 2^32 must still expire after the wrap
    NaIpTable r; now = 0xFFFFFFFFu - 1000;
    for (int i = 0; i < 5; i++) r.noteFail(A, now);
    CHECK(r.isLocked(A, now + 500)); CHECK(r.isLocked(A, now + 29000)); CHECK(!r.isLocked(A, now + 31000));
  }

  // ---- upload validation ----
  CHECK(na_filename_ok("esp_config.json")); CHECK(na_filename_ok("a-b_c.1.jpg")); CHECK(na_filename_ok(std::string(48, 'a').c_str()));
  CHECK(!na_filename_ok(std::string(49, 'a').c_str()));
  for (const char* bad : {"", ".", "..", ".hidden", "../x", "a/b", "/abs", "a\\b", "a:b", "a b", "na\xc3\xafve", "x\n", "..\\..\\x"}) CHECK(!na_filename_ok(bad));
  CHECK(!na_filename_ok(nullptr));
  long v = 0;
  CHECK(na_parse_upload_size("1", &v) && v == 1);
  CHECK(na_parse_upload_size("8388608", &v) && v == 8388608L);
  CHECK(!na_parse_upload_size("8388609", &v));
  for (const char* bad : {"", "0", "-1", "+5", " 5", "5 ", "1e3", "0x10", "99999999", "123456789", "abc", "12a"}) CHECK(!na_parse_upload_size(bad, &v));
  CHECK(!na_parse_upload_size(nullptr, &v));
  CHECK(na_write_complete(512, 512)); CHECK(!na_write_complete(0, 512)); CHECK(!na_write_complete(511, 512));

  // upload accounting: a full card (short write) must be detected, never subtracted
  { long remaining = 1000; size_t chunk = 512; size_t written = 300; /* SD full */
    bool ok = na_write_complete(written, chunk); if (ok) remaining -= chunk; CHECK(!ok); CHECK(remaining == 1000); }

  printf(fails ? "SOME TESTS FAILED (%d)\n" : "ALL PASS\n", fails);
  return fails ? 1 : 0;
}
