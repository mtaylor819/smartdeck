import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LABEL = 'com.smartdeck.mac';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** launchd LaunchAgent that starts the daemon at login and restarts it if it dies. */
export function plistFor(nodePath: string, cliPath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(nodePath)}</string><string>${esc(cliPath)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;
}

export function installService(nodePath: string, cliPath: string): { plist: string; commands: string[] } {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  const logDir = join(homedir(), 'Library', 'Logs');
  mkdirSync(dir, { recursive: true });
  const plist = join(dir, `${LABEL}.plist`);
  writeFileSync(plist, plistFor(nodePath, cliPath, join(logDir, 'smartdeck-mac.log')));
  return {
    plist,
    commands: [`launchctl bootstrap gui/$(id -u) "${plist}"`, `launchctl kickstart -k gui/$(id -u)/${LABEL}`],
  };
}
