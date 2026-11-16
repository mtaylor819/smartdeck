# Roadmap

Done in the Mac companion: see README. Ideas below are ranked by value for our own use.

## Firmware (needs a real deck to verify; build pipeline in `../firmware/`)
1. **`SET_BTN_LIVE`** – update a button's label/colour in RAM and redraw *without* `saveConfigToSD()`.
   Today `SET_BTN_DATA` writes the SD card on every call, so live widgets (CPU, printer progress)
   wear the card; the companion rate-limits to ≥10 s and only on change as a mitigation.
2. **Wireless mode** – the ESP32-S3 has WiFi + BLE but the firmware only uses USB serial/ESP-NOW.
   A WebSocket-over-WiFi transport (same text protocol) would give a cable-free deck on the desk.
3. **BLE HID keyboard/consumer-control** – hotkeys and media keys with no companion app at all
   (also works on iPad / phone).
4. **Gestures** – the GT911 reports up to 5 touch points: swipe left/right to change page,
   two-finger tap for brightness, long-press as a separate action (`BTN_HOLD`).
5. **Folders / nested pages** and a back button without burning a grid cell.
6. **Per-page knob actions** – `SET_KNOB_ACTION` exists in the firmware comments; surface it.
7. **Knob push / haptics** – if the hardware gets a button on the encoder.

## Done since the first roadmap
- Diagnostics sleep screen (firmware + Mac sender), LCARS web UI, 3 colour schemes, sounds.

## Companion
- LCARS colour scheme for the deck's own button screen (theme colours via `SET_THEME`) matching the chosen UI scheme.
- Native menu-bar item (SwiftBar plugin or Tauri shell) instead of opening the UI in a browser.
- Keychain storage for the Home Assistant token (`security add-generic-password`).
- Import of the Windows app's presets (Adobe, Blender, OBS...) translated ctrl→cmd.
- Conditional / branching multi-actions; variables; cross-button state.
- Moonraker control actions (pause/resume/cancel) alongside the status widget.
- Proxmox / other homelab status widgets via `http_json`.
