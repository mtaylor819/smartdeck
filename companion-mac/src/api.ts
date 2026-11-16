import type { Action } from './actions.js';
import type { Config } from './config.js';

export interface DeckStatus {
  connected: boolean;
  deviceName?: string;
  port?: string;
  /** 0-based page currently shown on the deck */
  page: number;
  /** most recent log lines, oldest first (max ~200) */
  log: string[];
  /** latest widget values keyed "page:index" */
  widgets: Record<string, string>;
}

/**
 * Everything the web UI server needs from the running daemon.
 * The UI server (src/server.ts) depends ONLY on this interface so it can be tested with a fake.
 */
export interface DaemonApi {
  /** Full current config (secrets NOT masked; the server masks on the way out). */
  getConfig(): Config;
  /** Validate, persist to disk and hot-reload. Throws Error with a user-readable message if invalid. */
  setConfig(next: Config): void;
  status(): DeckStatus;
  /** Upload esp_config.json + icons to the deck (deck reboots). Rejects if no deck connected. */
  sync(): Promise<void>;
  /** Run an action on the Mac right now (for the editor's Test button). */
  testAction(action: Action): Promise<void>;
  /** Directory holding uploaded JPG icons (served and listed by the UI). */
  iconsDir(): string;
  /** Called after the UI adds/removes an icon file. */
  iconsChanged(): void;
}
