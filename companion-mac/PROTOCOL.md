# SmartDeck extended protocol (v2 additions)

Text lines, `\n` terminated, same on every link (USB serial 115200, WiFi TCP). Base commands are in the stock firmware
(`PING_DECK`, `GET_SYNC`, `SET_BRIGHTNESS`, `SET_PAGE`, `SET_BTN_DATA`, `START_UPLOAD`/`FILE:`/`END_UPLOAD`, `WEATHER`, `SET_TIME`,
`DIAG`, `SET_SLEEP_SCREEN`...). Everything below is NEW and must be implemented exactly as written.

## Links and host presence
- **USB serial**: unchanged.
- **WiFi TCP host link**: deck listens on TCP **7778**. Client's first line must be `AUTH:<token>`; deck answers `AUTH_OK` or
  `AUTH_FAIL` (then closes). After `AUTH_OK` the stream is the normal protocol in both directions, *including the upload flow*.
  Max 1 client; a new authenticated client replaces the old one. Token compared in constant time. mDNS hostname (default
  `smartdeck`, so `smartdeck.local`) and service `_smartdeck._tcp` port 7778.
- **`HB`**: host -> deck heartbeat every 5 s. Silent: no reply, MUST NOT wake the deck. Any host line counts as presence.
  Deck treats the host as present for 15 s after the last line (`host_link_active()` in features.h).
- **Standalone**: when no host is present, a button press is executed ON THE DECK by whichever module can (BLE HID for
  key/text/media, WiFi for ha/http). When a host is present the deck sends `BTN:page:idx[:state]` as before and does nothing itself.

## Provisioning (sent over USB or an authenticated WiFi link)
- `SET_NET:<json>` -> stores in Preferences (NVS), applies immediately, replies `NET_SET:ok` or `NET_SET:err:<reason>`.
  JSON keys (all optional, absent = keep): `ssid`, `pass`, `host` (mDNS name, [a-z0-9-]{1,32}), `token` (host-link + OTA token,
  8..64 chars), `ha_url` (e.g. `http://homeassistant.local:8123`), `ha_token` (long-lived token), `tz` (POSIX TZ string, e.g.
  `GMT0BST,M3.5.0/1,M10.5.0/2`), `standalone` (`"auto"|"always"|"never"`, default auto), `wifi` (bool, default true when ssid set).
  Secrets (`pass`, `token`, `ha_token`) are never echoed back or logged.
- `GET_NET` -> one line `NET_STATUS:<json>`: `{"wifi":"off|connecting|connected","ip":"..","rssi":-55,"host":"smartdeck","ssid":"..",
  "clients":0|1,"ota":true,"ntp":true|false,"ble":"off|advertising|connected","ble_peer":"..","fw":"<version string>"}` (no secrets).
- `SET_BLE:<json>` -> `{"enabled":true,"name":"SmartDeck"}`; persisted; replies `BLE_SET:ok`. `name` 1..24 printable ASCII.
- Deck-originated events: `NET_STATUS:...` is also emitted when WiFi/BLE connection state changes (at most 1 per 2 s).

## OTA
- HTTP on TCP **7779**: `POST /update` with header `X-SmartDeck-Token: <token>`, body = raw APP image (`smart_deck.ino.bin`, NOT
  the merged image), `Content-Length` required. 200 `OK` then reboot; 401 on bad token; 4xx/5xx with a one-line reason otherwise.
  Uses the ESP32 `Update` library into the inactive OTA slot (partition table has app0/app1 3 MB each), validates the image header,
  and relies on the bootloader to keep the old slot if the new one fails to boot is NOT assumed: mark app valid only after setup() completes.
  While updating, show progress on screen and keep serial commands responsive.

## Alerts (LED ring + optional banner)
- `ALERT:<kind>:<seconds>[:<text>]` kind = `red|yellow|blue|green`, seconds 0..3600 (0 = until `ALERT:off` or acknowledged), text <= 24 chars
  (no colons). `ALERT:off` clears. Red = fast flashing red ring ("red alert"), yellow = slower amber pulse, blue = gentle cyan breathe,
  green = brief green sweep. Wakes the deck and shows an LCARS-style banner on screen if awake. A touch anywhere acknowledges:
  deck sends `ALERT_ACK:<kind>` and clears the alert.

## Auto-dim
- `SET_AUTODIM:<enabled 0|1>:<minPct>:<maxPct>[:<luxLow>:<luxHigh>]` -> reply `AUTODIM:ok` or `AUTODIM:no_sensor`.
  Optional BH1750 (I2C 0x23/0x5C) auto-detected at boot; smooth brightness between min..max following lux (log curve), never
  fighting an explicit `SET_BRIGHTNESS` for 60 s after it. Deck emits `LUX:<n>` at most every 10 s and only on >20% change.

## Gestures
- `SET_GESTURES:<swipe 0|1>:<holdMs>` (default 1:600). Horizontal swipe (>=120 px, <=700 ms, mostly horizontal) left/right changes
  page (clamped, no wrap) and emits `PAGE_CHANGED:n`; it must NOT trigger a button. A button whose JSON has `"hold":true` emits
  `BTN_HOLD:page:idx` when held >= holdMs (and then does NOT emit the normal `BTN` on release); buttons without `hold` behave as today.

## Colour scheme
- `SET_SCHEME:tng|voyager|picard` (reply `SCHEME_SET:<name>`, `ERR_SCHEME` for an unknown name): recolours the LCARS frame, keys and
  sleep screens (same palettes as `ui/style.css`); stored in Preferences (`lc_scheme`) and redraws the current page. Does not wake the deck.

## Sleep screens
- `SET_SLEEP_SCREEN:clock|diag|diag-anim|warp` (reply `SLEEP_SCREEN_SET:<mode>`): clock (default, existing), diag (static
  diagnostics, existing), diag-anim (diagnostics with animated LCARS details), warp (animated warp-streak starfield + large clock).

## Device button JSON additions (inside esp_config.json / SET_BTN_DATA)
- `type:"key"` + `combo:"cmd+shift+4"` (existing); `type:"text"` + `text` (existing); `type:"media"` + `media:"play_pause|next|previous|
  volume_up|volume_down|mute"` (NEW); `type:"ha"` + `ha:{"service":"light.toggle","entity":"light.desk","data":{...}}` (NEW);
  `type:"http"` + `http:{"url":"...","method":"GET|POST","body":"...","headers":{...}}` (extends existing `http.url`);
  `hold:true` (NEW) = long-press emits BTN_HOLD.
- Key combo tokens (device parser): modifiers `ctrl|control`, `shift`, `alt|option|opt`, `cmd|command|meta|win|super` (GUI),
  keys: a-z, 0-9, f1-f24, arrows, enter/return, esc, tab, space, backspace/delete, home/end/pageup/pagedown, punctuation.


# v3 additions

## Capabilities
- `NET_STATUS` gains `"caps":[...]` (strings the firmware supports): `"btn_live"`, `"ha_state"`, `"ble_hosts"`. The host only uses a
  feature if its cap is listed (stock/older firmware omits `caps`).

## Live button updates (RAM only)
- `SET_BTN_LIVE:<page>:<idx>:<json>` json keys (all optional): `label` (<=24 chars), `labelColor`, `btnColor` (6 hex), `labelSize` (8..40),
  `icon` (filename). Updates how that button is DRAWN, in RAM only: never writes the SD card, never wakes the deck, never changes
  what the button does. Redraws just that button if its page is showing and the deck is awake; otherwise applied at next draw.
  Overrides survive page changes and wake, and are lost on reboot (host re-sends). MUST NOT leak heap: 100k updates must not
  grow memory (fixed-size override table; do not mutate the ArduinoJson doc with new strings). No reply (no serial spam).
  Table size: at least 24 buttons; if full, drop the oldest.

## On-deck Home Assistant state (standalone wall-panel use)
- Button JSON may carry `"ha_state":{"entity":"light.desk","on":"1a8f3c","off":"333333","label_on":"ON","label_off":"OFF","interval":10}`.
  Works on any button type (typically `type:"ha"`). When WiFi is up, the deck is awake, and NO host is present (or standalone=always),
  the deck polls `GET <ha_url>/api/states/<entity>` (Bearer ha_token) for ha_state buttons on the CURRENT page, every `interval`
  s (default 10, min 5), at most 8 buttons, sequentially in the worker task (3 s timeout). state "on" -> `on` colour/`label_on`;
  "off" -> `off`/`label_off`; "unavailable"/error -> dim grey and label "?". Applied through the same mechanism as SET_BTN_LIVE.
  After an `ha` button press, re-poll that entity after ~700 ms. Colours/labels optional (keep the button's own when absent).

## BLE host slots (switch one deck between machines)
- 3 slots. Each slot advertises with its own identity address (so each machine bonds separately and remembers the deck).
  `BLE_HOST:<1|2|3|next>` -> disconnect, switch identity, advertise; persisted; reply `BLE_HOST:<n>`; brief on-screen toast `BT: <slot name>`.
- `SET_BLE` JSON gains `"slots":["Mac","Work PC","iPad"]` (1..3 names, each <=12 printable chars) and `clear_bonds` may be `true` (all)
  or a slot number.
- `NET_STATUS` gains `"ble_slot":<1..3>` and `"ble_slots":["Mac",...]`.
- Button JSON `"type":"blehost","slot":1|2|3|"next"` is DEVICE-LOCAL: it runs on the deck every time, even when a host is connected
  (like `goto`); it is never sent to the host as BTN.

# v4: security hardening (REPLACES the v2 `AUTH:<token>` handshake and the OTA token header)

The link token is never sent over the network any more. Both sides prove knowledge of it with HMAC-SHA256 over fresh nonces, and the
deck is authenticated to the host too (an impostor on the LAN cannot capture the token or be mistaken for the deck).
Notation: `hex(x)` = lowercase hex; `HMAC(k, m)` = HMAC-SHA256 with key = the token's UTF-8 bytes, message = the ASCII bytes of `m`.

## TCP host link (port 7778)
1. On accept, the deck sends `CHALLENGE:<nonce>` where nonce = 32 lowercase hex chars from the hardware RNG (esp_random x4), fresh per connection.
2. Client replies `AUTH:<hex(HMAC(token, "client:" + nonce))>` (64 hex chars).
3. Deck verifies (constant-time compare of the two 64-char strings; always compare the full length). On success it replies
   `AUTH_OK:<hex(HMAC(token, "deck:" + nonce))>`; the client MUST verify this and drop the link if it does not match. On failure: `AUTH_FAIL`, close.
4. The rest of the stream is the normal protocol. Unauthenticated peers get only the CHALLENGE line; anything else before a valid AUTH counts as a failure.
- Lockout is PER SOURCE IP (table of >= 8 recent IPs, LRU): 5 failures from one IP within the window => that IP is refused for 30 s. Other IPs are unaffected
  (so a hostile device cannot lock out the real Mac). A successful AUTH clears that IP's counter.
- Pending (unauthenticated) connections must not starve real clients: allow up to 3 pending; a new connection evicts the OLDEST pending one. Pending timeout stays 5 s.
- Enable TCP keepalive on the authenticated client and drop dead peers within ~30 s.

## OTA (port 7779)
- `GET /challenge` -> `200` body = a fresh 32-hex nonce (single use, valid 60 s; at most 4 outstanding, oldest evicted). Counts toward per-IP rate limiting.
- `POST /update` headers: `X-SmartDeck-Nonce: <nonce>`, `X-SmartDeck-Sha256: <hex sha256 of the body>`, `X-SmartDeck-Auth: <hex(HMAC(token, "ota:" + nonce + ":" + sha256hex))>`, `Content-Length`.
  The deck verifies the nonce (consumes it), then the auth HMAC BEFORE touching flash, then streams the body into the inactive OTA slot while computing SHA-256
  (mbedtls). At the end it compares the computed hash with the header hash; mismatch => `Update.abort()`, respond `400 hash mismatch`, no reboot. Only then `Update.end(true)` and reboot.
  Existing checks stay (ESP magic 0xE9, app descriptor, size vs slot, one update at a time, per-IP lockout on bad auth).
- A sniffed request cannot be replayed (nonce is single use) and the image cannot be swapped (the HMAC covers its hash).
- Known remaining limitation: no encryption, and an ACTIVE man-in-the-middle on the LAN can still relay/tamper with post-auth traffic. Documented, accepted for a home LAN.

## Upload hardening (both links)
- `FILE:<name>:<size>`: name must match `^[A-Za-z0-9._-]{1,48}$` and not start with a dot (reject otherwise: `ERR_CMD_FORMAT`); size must be a positive integer <= 8 MB (else `ERR_FILE_SIZE`).
  Write to a temporary file (`/.upl.tmp`), CHECK the byte count of every write, and only on success remove the old file and rename the temp into place. On any failure
  delete the temp file and leave the previous file untouched; reply `ERR_WRITE` for write failures (new) in place of OK_DATA.

## BLE pairing safety
- No new bonds outside a PAIRING WINDOW. The window opens: (a) automatically for 120 s the first time BLE is enabled while no bonds exist; (b) on `BLE_PAIR:<seconds>` (1..300; reply `BLE_PAIR:<n>`);
  (c) via a device-local button `{"type":"blepair"}` (runs on the deck like `blehost`). Show a small on-screen indicator while open. Outside a window only already-bonded peers may connect
  (use the NimBLE whitelist / reject unknown peers).
- HID input reports are only ever sent over an ENCRYPTED, bonded link. An unauthenticated peer that connects and subscribes must receive nothing, and is disconnected after ~15 s.
  A stranger must not be able to hold the single connection and block the real host.
- Report map: keyboard usages up to 0xE7 so F13-F24 work (hosts must re-pair after the descriptor change: say so in the README).
