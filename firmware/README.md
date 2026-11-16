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
