// ble_pairing.h -- PURE pairing-window / link-approval logic (no Arduino/NimBLE types), unit-tested on a PC.
// Wire contract: companion-mac/PROTOCOL.md "BLE pairing safety".
//
//  * New bonds are only possible inside a PAIRING WINDOW (the firmware turns bonding on/off with the window). Outside it a stranger can
//    at most complete an unbonded Just-Works encryption, which the verdict below rejects.
//  * A link is APPROVED only when it is encrypted AND bonded. Unapproved links are disconnected (encrypted ones immediately,
//    unencrypted ones after BLE_UNAUTH_KICK_MS) so a stranger can never hold the connection or receive HID reports.
#ifndef BLE_PAIRING_H
#define BLE_PAIRING_H
#include <stdint.h>

#define BLE_PAIR_MIN_SECONDS 1
#define BLE_PAIR_MAX_SECONDS 300
#define BLE_PAIR_AUTO_SECONDS 120
#define BLE_UNAUTH_KICK_MS 15000UL
#define BLE_SECURITY_VERSION 4      // bump to force a one-time purge of bonds made by older (always-open) firmware

struct BlePairWindow {
  bool open = false;
  uint32_t until = 0;  // millis() deadline

  void start(uint32_t now, uint32_t seconds) { open = true; until = now + seconds * 1000UL; }
  void close() { open = false; }
  bool isOpen(uint32_t now) {  // lazily expires; rollover-safe
    if (open && (int32_t)(now - until) >= 0) open = false;
    return open;
  }
  uint32_t remainingSec(uint32_t now) {
    if (!isOpen(now)) return 0;
    return (uint32_t)(until - now + 999UL) / 1000UL;
  }
};

// Digits only, 1..300. Anything else (empty, "12abc", "-5", "0", "301", overly long) is rejected.
inline bool ble_pair_parse_seconds(const char* s, int* out) {
  if (!s || !*s) return false;
  long v = 0;
  int n = 0;
  for (; *s; s++, n++) {
    if (*s < '0' || *s > '9' || n >= 4) return false;
    v = v * 10 + (*s - '0');
  }
  if (v < BLE_PAIR_MIN_SECONDS || v > BLE_PAIR_MAX_SECONDS) return false;
  *out = (int)v;
  return true;
}

enum BleVerdict { BLE_V_ACCEPT = 0, BLE_V_KICK = 1 };

// Called when authentication/encryption of a link completes.
//  encrypted : the link is encrypted
//  bonded    : NimBLE reports a stored bond for the peer (callers also fall back to the bond store, because the flag's timing on the
//              very first encryption of a NEW bond cannot be verified without hardware)
//  windowOpen: the pairing window is open right now. Inside it, an encrypted link is accepted even if the bonded flag is not (yet) set:
//              a stranger can pair inside the window anyway, so this adds no exposure, and it keeps a legitimate first pairing from being kicked.
// Outside the window only encrypted + bonded links (existing bonds) are accepted, so an unbonded Just-Works stranger is rejected.
inline BleVerdict ble_auth_verdict(bool encrypted, bool bonded, bool windowOpen) {
  return (encrypted && (bonded || windowOpen)) ? BLE_V_ACCEPT : BLE_V_KICK;
}

// An unapproved link that has been connected this long is dropped.
inline bool ble_link_expired(bool approved, uint32_t t0, uint32_t now) {
  return !approved && (uint32_t)(now - t0) >= BLE_UNAUTH_KICK_MS;
}

// The window that opens by itself: the first time BLE runs with no bonds at all (and only once, until bonds are cleared).
inline bool ble_auto_window_wanted(int numBonds, bool autoAlreadyUsed) {
  return numBonds <= 0 && !autoAlreadyUsed;
}

// HID reports may only be sent when at least one APPROVED link exists and NO encrypted-but-unapproved link exists (a notify is
// delivered to every encrypted subscriber, so a lone stranger on an encrypted link would otherwise see the keystrokes).
inline bool ble_send_allowed(int approvedLinks, int encryptedUnapprovedLinks) {
  return approvedLinks > 0 && encryptedUnapprovedLinks == 0;
}
#endif
