# smartdeck-mac

A macOS companion for the [SmartDeck](../README.md) ESP32 macro deck, written from scratch
against the firmware's serial protocol (the original Windows app's source isn't published).

The deck stores display info (labels, icons, colours, button `type`) on its SD card and reports
presses as `BTN:page:index` over USB serial. This app keeps the *actions* on the Mac, so
parameters such as app names, URLs and scripts never go to the device.

## Status

| Area | State |
|---|---|
| Serial protocol, upload handshake, config -> `esp_config.json` | Done, unit-tested against a simulated firmware |
| Actions: key, text, paste, app, website, urlscheme, script, shortcut, applescript, mouse, media, sound, http, Home Assistant, multi, toggle | Implemented; logic tested with a fake runner |
| Knob (steps, direction, wraparound), deck power/LED/brightness settings | Done, tested |
| Live widgets (clock, cpu, memory, now playing, HA state, JSON URL, Moonraker) | Done, tested |
| App-based page switching, weather (Open-Meteo) | Done, tested |
| Web UI: LCARS look with 3 colour schemes (TNG, Voyager, Picard), interface sounds | Rendered and checked in headless Chromium; drag-and-drop/upload not exercised |
| Mac-side press/error sounds (`sounds` in config; synthesized WAVs in `sounds/`) | Done, tested (afplay on a real Mac untested) |
| Starship-diagnostics sleep screen (`sleepScreen: "diag"`) | Mac sender done + tested; firmware side compile-checked only, **never seen on a real screen** |
| `flash` (esptool), `install-service` (launch at login) | Done; flashing unverified on hardware |
| WiFi link, provisioning, OTA, heartbeat, hold + alert actions, brightness schedule | Done; tested against a fake WiFi deck |
| Firmware: WiFi/OTA, BLE HID, LED alerts, auto-dim, gestures, animations | Compiles (app 1.35 MB / 3 MB); **never run on hardware** |
| **Real macOS / real deck** | **Not yet verified** (built on Linux, no hardware) |

See `ROADMAP.md` for what's next.

## Setup

```sh
cd companion-mac
npm install
npm run start          # daemon + UI at http://127.0.0.1:7777 (also: `open` command)
npx tsx src/cli.ts init     # write the default config
npx tsx src/cli.ts ports    # list candidate serial ports
npx tsx src/cli.ts sync     # upload config + icons to the deck (it reboots); or use the UI button
npx tsx src/cli.ts flash fw.bin   # flash firmware via esptool (pip3 install esptool)
npm run build && node dist/cli.js install-service   # launch at login
```

Config lives at `~/Library/Application Support/SmartDeckMac/config.json` (override with
`SMARTDECK_CONFIG`). Put 1-bit-friendly JPG icons in `icons/` beside it and reference them with
`"icon": "name.jpg"`.

**macOS permissions** (first run will prompt): grant *Accessibility* to your terminal (or the
packaged app) so `System Events` keystrokes and media keys work.

## Look & sound

- **Colour scheme:** the dropdown in the header (TNG / Voyager / Picard). Remembered per browser.
- **Interface sounds:** the *Sound* button toggles synthesized beeps in the web UI (no audio files).
- **Deck sounds on the Mac:** Settings → Sounds, or in config: `"sounds": {"press": "chirp", "error": "error", "volume": 50}`.
  Built-ins: `chirp`, `confirm`, `error`, `blip` (regenerate with `node scripts/make-sounds.mjs`), or any absolute file path.
- **Diagnostics sleep screen:** set `"sleepScreen": "diag"` (Settings → Sleep screen). Needs the updated firmware in `../firmware/`.
  The Mac sends CPU, memory, disk, network and uptime every 5 s.

## WiFi, Bluetooth and standalone use (needs the updated firmware)

Flash `firmware/dist/smartdeck-jc8048w550-merged.bin` once over USB, then:

1. **Provision over USB** (Settings -> *Deck connectivity*): WiFi SSID + password, a link/OTA token (*Generate*), optional
   Bluetooth and Home Assistant details for the deck itself, then *Push to deck*. Secrets travel **only over USB**.
2. **WiFi link:** set *Deck address* (`smartdeck.local`). The Mac app uses USB when plugged in and falls back to WiFi otherwise
   (plain TCP on your LAN, protected by the token).
3. **Standalone:** with no Mac connected the deck runs buttons itself: `key`/`text`/`media` over a **Bluetooth keyboard** to any
   machine, `ha`/`http` over WiFi straight to Home Assistant. *Run on the deck* = auto / always / never.
4. **OTA updates:** `smartdeck-mac ota ../firmware/dist/smartdeck-jc8048w550-app.bin` (app image only). No automatic rollback on this
   ESP32 core: a bad image that boot-loops needs a USB reflash with the merged image.
5. **Red alert:** `smartdeck-mac alert red 30 "Build failed"` (also a button action, `POST /api/alert`, or the test buttons in Settings).
   Touching the deck acknowledges it. Kinds: red, yellow, blue, green, off.
6. **Gestures:** swipe left/right to change page; buttons with a *long-press action* send `BTN_HOLD`.
7. **Auto-dim:** needs a BH1750 light sensor (I2C). Without one, use the **brightness schedule** (works from the Mac).
8. **Sleep screens:** clock, diagnostics, animated diagnostics, warp-speed starfield.

## Config example

```json
{ "label": "Screenshot", "action": { "type": "key", "combo": "cmd+shift+4" } }
{ "label": "Standup",    "action": { "type": "multi", "steps": [
    { "type": "app", "app": "Zoom" }, { "type": "delay", "ms": 800 }, { "type": "key", "combo": "cmd+shift+a" } ] } }
```

## Tests

`npm test` (no hardware or macOS needed).

## First-run checklist on a Mac with the deck

1. `ports` shows `/dev/cu.usbmodem…`; `run` logs `Connected to "Smart Deck"`.
2. Does opening the port reboot the board? (Code already holds DTR/RTS low.)
3. Press a button mapped to `app`; then `key`; then `media` (these need Accessibility).
4. Turn the knob: if volume goes the wrong way set `knob.invert`; tune `knob.step`.
5. `sync` once, confirm the layout and reboot work.
