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
