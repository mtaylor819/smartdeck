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
