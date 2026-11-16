# SmartDeck firmware: command-line build and Mac flashing

Builds `JC8048W550/Arduino/smart_deck` for the Guition JC8048W550 without the Arduino IDE.
No source files are modified; the vendored `JC8048W550/Arduino/libraries` are used as-is.

## Build (Linux or macOS)

```sh
brew install arduino-cli          # or download from github.com/arduino/arduino-cli/releases
./firmware/build.sh               # first run downloads the ESP32 core (~1 GB) into firmware/.work
```

Pinned: ESP32 Arduino core **2.0.17** (as the main README requires), esptool 4.8.1, arduino-cli 1.6.0 (tested).
Result: `dist/smartdeck-jc8048w550-merged.bin` (+ `.sha256`), a single image to write at offset `0x0`.
Size: app ≈ 527 KB of the 3 MB app partition; merged image ≈ 580 KB.

## Board options and where they came from

FQBN `esp32:esp32:esp32s3` with `FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,FlashMode=qio,CDCOnBoot=default`.

| Option | Value | Provenance |
|---|---|---|
| Core | esp32 2.0.17 | **Read from README.md** |
| Chip | ESP32-S3 | **Read from README / config.h / pin map** (RGB panel is S3-only) |
| Flash size 16 MB | 16M | **Assumed**: the usual spec for this board (ESP32-S3-WROOM-1 N16R8). Not stated in the repo. |
| PSRAM | OPI (8 MB) | **Assumed**: same module; the 800x480 RGB framebuffer needs PSRAM. Wrong value = black screen/boot loop. |
| Partition scheme | 16M (3 MB app / 9.9 MB FATFS) | **Assumed**; any 16 MB scheme with an app ≥ 1 MB works since the sketch is only ~527 KB. |
| Flash mode / freq | QIO / 80 MHz | **Assumed** (Arduino defaults for the S3 Dev Module). If the board won't boot, rebuild with `DIO`. |
| USB CDC on boot | disabled | **Assumed**: the sketch uses `Serial` at 115200 and the board has a USB-UART bridge. If your unit enumerates as `usbmodem` via native USB, the host app would need CDC on boot enabled instead. |

**Nothing here has been tested on real hardware.** The original Windows app flashes its own bundled binary, whose
board options I could not inspect. If the deck misbehaves, read the options back from a known-good unit
(`esptool.py flash_id`, `esptool.py read_flash 0x8000 0x1000 pt.bin`) and compare.

## Flash on macOS

```sh
pip3 install esptool
ls /dev/cu.usb*                                  # find the port
esptool.py --chip esp32s3 --port /dev/cu.usbserial-XXXX --baud 460800 \
  write_flash 0x0 firmware/dist/smartdeck-jc8048w550-merged.bin
```

Equivalent unmerged offsets (files in `dist/parts/`): `0x0` bootloader, `0x8000` partitions,
`0xe000` boot_app0, `0x10000` app (`smart_deck.ino.bin`).

Download mode (only if auto-reset doesn't work): hold **BOOT** (GPIO0), tap **RESET**, release BOOT, then run
esptool. Press RESET afterwards. Stop the `smartdeck-mac` daemon first, since it holds the serial port.
Flashing does not touch the SD card, so the layout and icons survive.

Verify with `shasum -a 256 -c dist/smartdeck-jc8048w550-merged.bin.sha256`.

## Optional: LCARS diagnostics sleep screen

Added to `smart_deck.ino` (compile-verified only; **not yet seen on real hardware**). Default behaviour is unchanged.

| Command | Effect |
|---|---|
| `SET_SLEEP_SCREEN:diag` / `SET_SLEEP_SCREEN:clock` | choose the sleep screen (stored in Preferences key `sleep_diag`); replies `SLEEP_SCREEN_SET:<mode>` |
| `DIAG:cpu:mem:disk:rxKBs:txKBs:uptimeMin:host` | host metrics (percent ints, KB/s, minutes, name <=16 chars). Does **not** wake the deck. |

While asleep in `diag` mode with DIAG data newer than 120 s, the deck shows gauges (core load, memory, storage, subspace link),
uptime and a clock; otherwise it falls back to the classic clock/weather screen. Repaints are limited to ~every 2 s and only
touch changed regions. Waking redraws the normal page as before. Binary size grew by ~19 KB (app 545,881 bytes, 17% of the 3 MB partition).

## Patches to the stock firmware

- **Widget updates no longer wake a sleeping deck.** In the stock sketch every serial command that isn't explicitly handled counts as
  activity (`update_activity()`), and `SET_BTN_DATA` redraws the page immediately. Live widgets on the Mac send `SET_BTN_DATA`
  periodically, which would keep the deck awake forever. `SET_BTN_DATA` is now excluded from the wake path and skips the redraw while
  the deck is dimmed/deep-sleeping (waking redraws the page from the stored config anyway).
- **Diagnostics sleep screen** (`SET_SLEEP_SCREEN` / `DIAG`), described above.

## Optional: BLE HID keyboard + media keys (module `ble_hid.h`)

Lets the deck act as a standalone Bluetooth keyboard on any machine (Mac, Windows, iPad, phone) when no host app is connected.
**Compile-verified only; nothing has been paired with a real device.** Disabled until you send `SET_BLE` (stock behaviour unchanged).

| Command | Effect |
|---|---|
| `SET_BLE:{"enabled":true,"name":"SmartDeck"}` | persisted (Preferences ns `ble`: `en`, `name`); replies `BLE_SET:ok` or `BLE_SET:err:bad_json\|no_fields\|bad_enabled\|bad_name`. Renaming restarts the BLE stack. |
| `SET_BLE:{"clear_bonds":true}` | extension beyond PROTOCOL.md: forget all paired hosts (applied at next start if BLE is currently off) |

- Pairing: Just Works + bonding (LE Secure Connections), bonds kept in NVS by NimBLE (NimBLE default: 3 bonds). Advertises with the
  HID-keyboard appearance (0x03C1) and the HID service UUID; re-advertises after a disconnect.
- Reports: keyboard (ID 1: modifiers + 6 keys) and consumer control (ID 2: play/pause, next, previous, volume +/-, mute).
- Standalone buttons (only when no host app is connected and a BLE host is connected): `type:"key"` + `combo`, `type:"text"` + `text`,
  `type:"media"` + `media`. Combo tokens match `companion-mac/src/keymap.ts` (all 104 key/alias/modifier names from that file were
  cross-checked) plus `f1..f24`; `cmd|command|meta|win|super` = GUI. As in `keymap.ts`, `delete`/`backspace` = Backspace and `del`/`forwarddelete`
  = forward delete.
- Text is typed as **US-layout ASCII** (press/release, 10 ms spacing, queued, max 1024 chars per button press, non-blocking). The host
  maps key codes to characters, so on a non-US layout symbols such as `@ " # £ ~ \` will come out wrong.
- `NET_STATUS` gets `ble` (`off|advertising|connected`) and `ble_peer` from `ble_state_str()` / `ble_peer_str()`; state changes
  call `net_status_changed()` from the main loop (not from the NimBLE task).
- Size: app grew from ~546 KB to ~770 KB (24% of the 3 MB slot); static RAM 24 KB -> 35 KB.
- **Radio sharing:** WiFi and BLE use the same 2.4 GHz radio; the ESP32 coexistence layer time-slices them. Expect somewhat higher
  HID latency while WiFi is busy (e.g. during an OTA upload), and occasional extra WiFi latency while BLE connects.
- Pure key mapping lives in `ble_keys.h` (no Arduino deps) so it can be unit-tested on a PC:
  `g++ -std=c++17 -iquote JC8048W550/Arduino/smart_deck -o /tmp/bk firmware/tests/ble_keys_test.cpp && /tmp/bk` (use `-iquote`, not `-I`: the sketch folder contains a `features.h`
  that would shadow the system `<features.h>`).

### Vendored library
`JC8048W550/Arduino/libraries/NimBLE-Arduino` = **h2zero/NimBLE-Arduino 1.4.3** (last 1.x release, built for arduino-esp32 2.0.x / IDF 4.4;
the 2.x line has a different API). Source: `https://github.com/h2zero/NimBLE-Arduino/archive/refs/tags/1.4.3.zip`,
zip sha256 `0f9770c49a49b5cf00e492124893f78baa4bf60f109ad1c34bef6bbc2c8c2cd7`. Only `src/`, `library.properties`, `LICENSE`
(Apache-2.0), `README.md`, `CHANGELOG.md` are vendored (no examples/docs); no source edits.

The pre-existing loose `JC8048W550/Arduino/libraries/esp_bt.h` is **not** a problem: arduino-cli only puts library *folders* on the include
path, and the build dependency file for `NimBLEDevice.cpp` shows it compiled against the core's own `esp_bt.h`.
## WiFi, host link and OTA (`net_wifi.h`, `host_io.h`)

Provisioned with `SET_NET:{...}` over USB (or an already-authenticated link); see `companion-mac/PROTOCOL.md` for the full contract.
Example: `SET_NET:{"ssid":"MyWifi","pass":"secret-pass","host":"smartdeck","token":"a-long-random-token","tz":"GMT0BST,M3.5.0/1,M10.5.0/2"}`.

- **WiFi** connects asynchronously (retry back-off 1, 2, 4 ... 60 s) and advertises `smartdeck.local` / `_smartdeck._tcp` on port 7778.
- **Host link**: TCP 7778, first line `AUTH:<token>`. 5 failed attempts lock new connections out for 30 s; unauthenticated clients are dropped after 5 s.
  `host_io.h` makes the sketch's `Serial` write to USB exactly as before *and* tee to the authenticated client, and read from it while a
  TCP-originated command (e.g. `START_UPLOAD`) is running. NOTE: `#define Serial` is active for every header included after
  `host_io.h` in `smart_deck.ino`; third-party library *headers* with inline `Serial` use should be included before it.
- **OTA**: `curl -X POST -H "X-SmartDeck-Token: <token>" --data-binary @smart_deck.ino.bin http://smartdeck.local:7779/update`.
  Send the **app** image (`firmware/dist/parts/smart_deck.ino.bin`), not the merged image; the deck checks the ESP image magic and the
  app-descriptor magic before writing and rejects anything else (merged image / bootloader / random file).
  The image is written to the inactive slot (`app0`/`app1`, 3 MB each) and the deck reboots into it.
- **No automatic rollback.** The Arduino-ESP32 2.0.17 precompiled bootloader is built without app rollback. If an OTA image boots but
  crashes or boot-loops, OTA can't help: reflash over USB (`flash` command / esptool, download mode as described above).
  Test new images on the bench before flashing a deck you can't reach.
- **Secrets** (WiFi password, token, Home Assistant token) are stored in plain NVS (Preferences namespace `net`); they are never printed or
  echoed (`GET_NET` omits them). Anyone with physical access can read flash. The link is unencrypted TCP; use it on a trusted LAN.
- **Standalone** `ha` / `http` buttons run on a short-lived task with 3 s timeouts when no host is connected (or always, with
  `"standalone":"always"`). `https://` skips certificate verification (`setInsecure`): the deck has no CA bundle.
- **NTP**: once WiFi is up the deck sets its own clock (TZ from `tz`) unless a host has sent `SET_TIME` in the last 10 minutes.

## Release artifacts (all modules merged)

| File | Use |
|---|---|
| `dist/smartdeck-jc8048w550-merged.bin` | First flash over USB at offset `0x0` (`smartdeck-mac flash`). Also for recovery after a bad OTA. |
| `dist/smartdeck-jc8048w550-app.bin` | **OTA only**: `smartdeck-mac ota firmware/dist/smartdeck-jc8048w550-app.bin`. The Mac app refuses the merged image here. |

Size: app 1.37 MB of the 3 MB slot (43%), static RAM 20%. Included modules: diagnostics + animated sleep screens, LED alerts,
BH1750 auto-dim, swipe/hold gestures, WiFi + authenticated TCP host link + OTA + NTP + standalone HA/HTTP, BLE HID keyboard.
**None of it has run on a real board.** First boot is the first test; keep the USB cable handy for a reflash.

## BLE host slots: one deck, up to 3 machines (`ble_hid.h`, `ble_slots.h`)

- `BLE_HOST:<1|2|3|next>` (reply `BLE_HOST:<n>`, or `BLE_HOST:err:ble_off|bad_slot`) switches the active slot; a button with
  `"type":"blehost","slot":1|2|3|"next"` does the same **on the deck itself**, even while a host app is connected (never sent as `BTN`).
  A `BT: <slot name>` pill shows for ~1.5 s. `SET_BLE` accepts `"slots":["Mac","Work PC","iPad"]` (1-3 names, <=12 printable chars,
  applied to slots 1..k) and `"clear_bonds": true` (all) or `1..3` (that slot). `NET_STATUS` reports `ble_slot` and `ble_slots`
  (always 3 names; defaults `Host 1..3`).
- **How the identities work.** Slot 1 keeps the chip's public Bluetooth address, so bonds made before slots existed still work. Slots
  2 and 3 use a stable static-random address derived from the chip MAC and the slot number (`ble_slot_addr`). NimBLE-Arduino 1.4.3 has
  no `setOwnAddr()`; on the ESP32 port the host does not pick an address at sync, so after `init()` the module calls the NimBLE host
  API `ble_hs_id_set_rnd()` and then `setOwnAddrType(BLE_OWN_ADDR_RANDOM)` before advertising starts. Each machine therefore pairs
  with a different "device" and remembers it separately. Bonds for all slots stay in NVS; the peer that bonded to each slot is
  recorded in Preferences so a single slot's bond can be cleared.
- **Pair each machine once**: select its slot, then pair from that machine's Bluetooth settings. After that, switching slots and
  letting the machine reconnect is automatic.
- **Limits (honest caveats).** One BLE radio: only ONE host is connected at a time, and switching drops the current one (the stack is
  stopped and restarted, about a second). Use one machine per slot: only the *last* peer that paired on a slot is recorded for
  `clear_bonds:<slot>` (`clear_bonds:true` always clears everything, including bonds from older firmware). macOS and iOS can keep
  auto-reconnecting to a stale identity they still remember; if a machine will not connect, remove "SmartDeck" from its Bluetooth
  list and pair it again on its slot. A random address is only used on slots 2 and 3, so a host that previously paired with slot
  1's public address keeps working untouched.
- Unit test for the pure logic: `g++ -std=c++17 -Wall -iquote JC8048W550/Arduino/smart_deck firmware/tests/ble_slots_test.cpp -o /tmp/t && /tmp/t`
## Live buttons and on-deck Home Assistant state (`live_table.h`, `live_buttons.h`, `net_wifi.h`)

- **`SET_BTN_LIVE:<page>:<idx>:<json>`** changes how one button is *drawn* (`label`, `labelColor`, `btnColor`, `labelSize`, `icon`)
  in RAM only: no SD write (unlike `SET_BTN_DATA`), no wake, no reply. Values live in a fixed 24-entry static table
  (`live_table.h`, 2 KB, oldest evicted), never in the ArduinoJson document, so heap use is constant however many updates
  arrive and nothing is ever persisted. Overrides survive page changes and wake; a reboot drops them (the host re-sends).
  `NET_STATUS` now carries `"caps":["btn_live","ha_state","ble_hosts"]`, `ble_slot` and `ble_slots`.
- **`ha_state`** on a button (`{"entity":"light.desk","on":"1a8f3c","off":"333333","label_on":"ON","label_off":"OFF","interval":10}`):
  when WiFi is up, Home Assistant is provisioned (`ha_url`/`ha_token`), the deck is awake, `standalone` is not `never`, and no host is
  present (or `standalone` is `always`), the deck polls `GET /api/states/<entity>` for ha_state buttons on the current page (<= 8,
  every `interval` s, min 5, default 10, one at a time, 3 s timeouts) and shows `on`/`off` (anything else, or an error: dim grey and `?`).
  After an `ha` button press the entity is re-read after ~700 ms. A press that arrives while a poll is running is queued and runs next.
- **Labels:** the stock firmware draws *no* label text for normal buttons (the Windows app bakes it into the icon JPG). A live label always
  draws (fitted: font shrinks, then characters trim). With `LIVE_LABEL_FALLBACK 1` (default, `live_table.h`) a button with **no icon** also
  draws its configured `label`; set it to `0` for exactly the stock behaviour. A button that has an icon still shows no text unless the
  icon contains it or a live label is set.
- Unverified on hardware: everything above (drawing, HTTP polling, TLS heap use, queueing of presses behind polls).
