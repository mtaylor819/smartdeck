# First power-on checklist

Nothing in this project has run on a real board yet. Work **bottom-up**: get each layer solid before enabling the next, so a failure
tells you which layer is wrong. After each step run `smartdeck-mac doctor` (it explains most failures and the fix).

Keep the USB cable handy: it is also your recovery path for every other layer.

## 0. Before plugging anything in
- `git pull`, `cd companion-mac && npm install`, `npm test` (should be all green on your Mac too).
- `npx tsx src/cli.ts virtual` + the Mac app against it (see README): proves the Mac side works with no hardware.
- `pip3 install esptool` (only needed for flashing).

## 1. Does the board boot? (stock firmware, before flashing ours)
Plug in with a **data** USB-C cable (charge-only cables show no port). The original firmware should show its page.
- No screen at all: check power/cable. If `ports` lists nothing, try another cable/port.
- Note the serial port name: `npx tsx src/cli.ts ports`  (`/dev/cu.usbmodem…`).
- With the stock firmware, the Mac app should already work over USB (buttons, knob, hotkeys): this checks the Mac<->deck path
  independently of anything we built. `npm start`, press a button mapped to *Open app*.

## 2. Flash our firmware (USB)
`npx tsx src/cli.ts flash ../firmware/dist/smartdeck-jc8048w550-merged.bin`
If esptool can't connect: hold **BOOT**, tap **RESET** (or unplug and replug while holding BOOT), run it again.
Our build uses **assumed** board settings (16 MB flash, 8 MB OPI PSRAM, QIO). What you see tells you which are wrong:

| Symptom after flashing | Likely cause | What to try |
|---|---|---|
| Black screen, backlight on, serial prints garbage or nothing | PSRAM mode wrong | rebuild with `PSRAM=enabled` (quad) instead of `opi` (see `firmware/build.sh` OPTIONS) |
| Boot loop with `Guru Meditation` / `flash read err` | flash mode/size wrong | rebuild with `FlashMode=dio`, or `FlashSize=8M` |
| Boots, screen shows but is shifted/garbled | display timing | compare with the stock firmware's board options; ask me, this is the Windows binary's settings |
| Boots fine | good | continue |

To read the boot log: `screen /dev/cu.usbmodemXXXX 115200` (quit: Ctrl-A then K). You want to see `SETUP_DONE`.
Always recoverable: re-flash the merged image, or the original firmware.

## 3. USB only
`npm start`, open the UI. `doctor` should show **Firmware ... capabilities: btn_live, ha_state, ble_hosts**.
- Press every button type you use. Turn the knob. Hold a button that has a long-press action.
- Swipe left/right on the screen (page change). Try a touch near the edges.
- Settings: brightness, sleep screen choice, sleep timers; let it sleep and wake it by touch.
- `smartdeck-mac alert red 10 "test"` then touch the screen to acknowledge.
- Leave a CPU widget running for a minute while the deck sleeps: it must **not** wake the deck.

## 4. WiFi (still plugged in)
Settings -> *Deck connectivity*: SSID, password, *Generate* a token, *Push to deck (USB)*. `doctor` -> *Deck WiFi* should say
connected with an IP. Then set *Deck address* (`smartdeck.local`) and unplug USB: the app should reconnect over WiFi within seconds.
- Screen flicker while WiFi is busy is a known risk with this panel: note when it happens.
- `smartdeck.local` not resolving: use the IP shown by `doctor`.
- Test OTA: `smartdeck-mac ota ../firmware/dist/smartdeck-jc8048w550-app.bin` (APP image, not the merged one).
  If an OTA ever boot-loops, reflash the merged image over USB.

## 5. Standalone + Bluetooth
Enable *Bluetooth keyboard*, push settings, then pair "SmartDeck" in macOS Bluetooth settings **within 2 minutes** (the pairing window
opens automatically the first time; later, add a *Bluetooth pairing mode* button to reopen it). Strangers can't pair outside the window. Stop the Mac app (so no host is present)
and wait 15 s: `key`/`text`/`media` buttons should now type on the paired machine; `ha` buttons call Home Assistant directly.
- Bluetooth host slots: add a *Bluetooth host* button, switch slots, pair a second machine.
- Typed text assumes a **US layout** on the receiving machine.

## 6. Optional hardware
- **Light sensor** (BH1750): wire to the shared I2C bus, enable *Auto-dim*; `doctor`/log shows `LUX` readings.
- Anything that misbehaves: capture the serial log (`screen` as above) and `smartdeck-mac doctor` output.

## Recovery summary
| Situation | Recovery |
|---|---|
| Bad settings / won't connect | USB + *Push to deck*; or reflash merged image (clears nothing else) |
| Bad OTA / boot loop | hold BOOT, USB reflash of `smartdeck-jc8048w550-merged.bin` |
| Forgot the token | USB + *Generate* + *Push to deck* |
| Want stock behaviour back | flash the original firmware from the upstream release |
