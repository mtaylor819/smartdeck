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
| Web UI (localhost, CSRF/Host/Origin protected) | Served and API-checked; **not yet viewed in a browser** |
| `flash` (esptool), `install-service` (launch at login) | Done; flashing unverified on hardware |
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
