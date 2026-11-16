# macOS setup: Keychain secrets and menu bar

**Status: written on Linux, never run on a real Mac.** Everything below is unit-tested with fakes only.

## Keychain secrets

Any of these config values may be `keychain:<name>` instead of the secret itself (name: letters, digits, `.`, `_`, `-`, max 64):
`integrations.homeassistant.token`, `device.wifi.password`, `device.token`, `device.ha.token`.
The secret lives in the login Keychain as a generic password, service `smartdeck-mac`, account `<name>`.

- Secrets never appear in command-line arguments (`ps`). Writes are fed to `security -i` on stdin, with the value hex-encoded (`-X`),
  so no shell/tokenizer quoting is involved. Reads use `find-generic-password -w`.
- Assumed from memory of `security(1)`: `-i` reads commands from stdin; `-X` takes hex data; `-U` updates an existing item; exit code 44 = item not found.
  If `-X` misbehaves on your macOS version, `security add-generic-password -U -s smartdeck-mac -a NAME -w` (prompts) is the manual fallback.
- First use may pop a Keychain "allow access" dialog for `security`/node; choose "Always Allow".

Manual check: `security find-generic-password -s smartdeck-mac -a ha-token -w`.

## Menu bar (SwiftBar or xbar)

1. `brew install --cask swiftbar` and pick a plugin folder on first launch.
2. Install the plugin (the CLI wires this up): it writes `smartdeck.10s.sh` (mode 0755) into the plugin folder.
   Folder lookup order: SwiftBar's saved preference, `~/Library/Application Support/SwiftBar/Plugins`, `~/Library/Application Support/xbar/plugins`.
3. The menu shows the deck status (from `smartdeck-mac status --short`, refreshed every 10 s) and offers: open the UI, red/yellow/blue alerts,
   clear alert, sync, restart the launchd service, open the log.

Assumed SwiftBar syntax (UNVERIFIED): refresh interval from the filename, `---` separates title from items, ` | key=value` params,
`shell=... paramN=...`, `terminal=false`, `refresh=true`, `href=`. Paths containing `"`, `|` or newlines are rejected.
