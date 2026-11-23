#!/usr/bin/env bash
# Reproducible CLI build of the SmartDeck firmware for the Guition JC8048W550.
# Needs: arduino-cli (>=1.0) on PATH (or $ARDUINO_CLI), python3 with venv, internet on first run.
# Output: firmware/dist/{bootloader,partitions,boot_app0,app}.bin + smartdeck-jc8048w550-merged.bin + .sha256
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SKETCH="$ROOT/JC8048W550/Arduino/smart_deck"
LIBS="$ROOT/JC8048W550/Arduino/libraries"     # vendored, do not install others
CLI="${ARDUINO_CLI:-arduino-cli}"
WORK="${SMARTDECK_FW_WORK:-$HERE/.work}"      # toolchains, build cache, venv (gitignored)
DIST="${SMARTDECK_FW_DIST:-$HERE/dist}"          # override to build in parallel without clobbering dist/
BUILD="${SMARTDECK_FW_BUILD:-$WORK/build}"        # override per parallel build

CORE_VERSION="2.0.17"                         # README: "ESP32 Board Package v2.0.17"
ESPTOOL_VERSION="4.8.1"
CORE_URL="https://espressif.github.io/arduino-esp32/package_esp32_index.json"

# Board options (NOT specified upstream; chosen for the JC8048W550 = ESP32-S3 N16R8, see README.md)
FQBN="esp32:esp32:esp32s3"
# Verified on hardware: compile QIO (stable RGB panel) but patch the image header to DIO/40 MHz (QIO/80 MHz boot-loops this board).
# Compiling the app in DIO mode made the panel flicker. Flash with: --flash_mode dio --flash_freq 40m (see README).
OPTIONS="FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,FlashMode=${SMARTDECK_FW_FLASH_MODE:-qio},CDCOnBoot=default"

export ARDUINO_DIRECTORIES_DATA="$WORK/arduino/data"
export ARDUINO_DIRECTORIES_USER="$WORK/arduino/user"
export ARDUINO_DIRECTORIES_DOWNLOADS="$WORK/arduino/dl"
mkdir -p "$WORK" "$DIST"

# The ESP32 core runs esptool/gen_esp32part via system python and needs pyserial.
if [ ! -x "$WORK/venv/bin/esptool.py" ]; then
  python3 -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install -q "esptool==$ESPTOOL_VERSION" pyserial pyyaml
fi
export PATH="$WORK/venv/bin:$PATH"

"$CLI" core update-index --additional-urls "$CORE_URL"
"$CLI" core install "esp32:esp32@$CORE_VERSION" --additional-urls "$CORE_URL"

# Several builds can share one toolchain dir; serialise the compile step if flock exists.
LOCK=()
command -v flock >/dev/null 2>&1 && LOCK=(flock "$WORK/.compile.lock")
${LOCK[@]+"${LOCK[@]}"} "$CLI" compile --fqbn "$FQBN" --board-options "$OPTIONS" \
  --libraries "$LIBS" \
  --build-path "$BUILD" --output-dir "$DIST/parts" "$SKETCH"

P="$DIST/parts"
BOOT_APP0="$(find "$ARDUINO_DIRECTORIES_DATA/packages/esp32/hardware/esp32/$CORE_VERSION/tools/partitions" -name boot_app0.bin | head -1)"
cp "$BOOT_APP0" "$P/boot_app0.bin"

# ESP32-S3 flash layout: bootloader 0x0, partition table 0x8000, boot_app0 0xe000, app 0x10000
esptool.py --chip esp32s3 merge_bin -o "$DIST/smartdeck-jc8048w550-merged.bin" \
  --flash_mode "${SMARTDECK_FW_HDR_MODE:-dio}" --flash_freq "${SMARTDECK_FW_HDR_FREQ:-40m}" --flash_size 16MB \
  0x0 "$P/smart_deck.ino.bootloader.bin" \
  0x8000 "$P/smart_deck.ino.partitions.bin" \
  0xe000 "$P/boot_app0.bin" \
  0x10000 "$P/smart_deck.ino.bin"

( cd "$DIST" && shasum -a 256 smartdeck-jc8048w550-merged.bin > smartdeck-jc8048w550-merged.bin.sha256 2>/dev/null \
  || sha256sum smartdeck-jc8048w550-merged.bin > smartdeck-jc8048w550-merged.bin.sha256 )
ls -l "$DIST" "$P"
