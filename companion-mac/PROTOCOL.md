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
