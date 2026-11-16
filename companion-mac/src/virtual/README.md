# Virtual deck

A software emulator of the SmartDeck firmware, so the whole Mac stack can be run and tested without hardware.

```sh
npx tsx src/virtual/main.ts            # TCP host link :7778, screen at http://127.0.0.1:7780
npx tsx src/virtual/main.ts --token mysecret --data-dir ~/virtual-sd
```

Point the Mac app at `127.0.0.1:7778` with token `virtual-deck` (or your `--token`). The first line a client sends is
`AUTH:<token>`; after `AUTH_OK` it is the normal line protocol (see `../../PROTOCOL.md`).

## What is emulated
- **Protocol** (reply strings copied from `smart_deck.ino`): `PING_DECK`, `GET_SYNC`, the USB upload handshake
  (`START_UPLOAD` / `FILE:` / bytes / `END_UPLOAD`, incl. error replies and timeouts, then a simulated reboot that drops the link),
  `DUMP_CONFIG`, `SET_BTN_DATA`, `SET_PAGE`, `SET_BRIGHTNESS`, `SET_SLEEP`, `SET_DEEP_SLEEP`, `SET_DIM_LED`, `SET_LED_BRIGHTNESS`,
  `SET_KNOB`, `SET_THEME`, `SET_TIME`, `WEATHER`, `DIAG`, `SET_PAGE_NAME`, `SET_DEVICE_NAME`, `SET_GRID`, `CLEAR_BTN`, `SWAP_BTN`.
- **v3 protocol** (see `PROTOCOL.md` "v3 additions"):
  - `NET_STATUS` carries `caps` (`btn_live`, `ha_state`, `ble_hosts`), `ble_slot` and `ble_slots`.
  - `SET_BTN_LIVE:<page>:<idx>:<json>` is a RAM-only drawing override: silent, never wakes the deck, never reaches the SD config,
    `DUMP_CONFIG` or `prefs.json`, survives page changes and wake, and is lost on reboot. Invalid input is rejected whole and noted in
    the deck log (no serial reply). Later updates merge keys; the table holds 32 buttons and drops the oldest.
  - On-deck Home Assistant: `ha_state` buttons on the current page are polled (`GET <ha_url>/api/states/<entity>`, Bearer token, <= 8
    buttons, 5 s minimum / 10 s default interval, one request at a time, 3 s timeout) while WiFi is up, the deck is awake, HA is
    configured and no host is present (or `standalone=always`). Results colour/label the button through the live table
    (`unavailable`/errors -> grey "?"). In standalone mode `ha` and `http` presses really run (fetch with the Bearer token) and the
    result goes to the deck log; an `ha` press re-polls its entity ~700 ms later. Tokens and the HA URL never appear in replies,
    state, the snapshot or the log.
  - BLE host slots: `BLE_HOST:<1|2|3|next>` -> `BLE_HOST:<n>` (`BLE_HOST:err:ble_off` / `err:bad_slot`), `SET_BLE` `slots` (<= 12
    printable chars each) and `clear_bonds` (`true` or a slot number), a `BT: <name>` toast on the canvas, bonds recorded when a
    simulated host connects. `blehost` buttons are device-local (never sent as `BTN`, work with a host present) and the side panel has
    slot buttons.
- **Extended protocol**: `HB`, `SET_NET` / `GET_NET` / `NET_STATUS`, `SET_BLE`, `ALERT` / `ALERT_ACK`, `SET_AUTODIM` / `LUX`,
  `SET_GESTURES` / `BTN_HOLD`, `SET_SLEEP_SCREEN` (clock | diag | diag-anim | warp). Secrets are stored (like NVS, in a 0600
  `prefs.json`) but never echoed or exposed to the UI.
- **Behaviour**: sleep/deep sleep; `HB`, `DIAG`, `SET_BTN_DATA`, `SET_TIME`, `WEATHER` don't wake the deck (as in the patched
  firmware); host presence (15 s) with standalone routing (`SET_NET standalone`); toggle/counter/timer/goto buttons; swipe
  (>=120 px, <=700 ms, mostly horizontal) and hold gestures; alert acknowledge by touch; unreferenced icon cleanup after upload.
- **Screen** (browser canvas, 800x480): faithful grid/button layout from `draw_page()`; sleep screens, LED ring effects and the
  alert banner are approximations. Knob: drag or scroll the dial. "Sleep now", "Wake", BLE-connect and ambient-light controls are on
  the side panel.

## API
`startVirtualDeck({ port?, uiPort?, token, dataDir?, name?, log?, emulator? })` -> `{ tcpPort, uiUrl, uiToken, state, deck, close() }`.
`deck` is the `DeckEmulator` (UI-side hooks: `touch`, `swipe`, `knob`, `ackAlert`, `sleepNow`, `setBlePeer`, `setLux`).
The browser UI binds to 127.0.0.1 only and applies the same Host/Origin/CSRF checks as the main UI server.
