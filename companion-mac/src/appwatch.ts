import type { Capture } from './actions.js';
import type { Config } from './config.js';

const FRONTMOST = 'tell application "System Events" to get name of first application process whose frontmost is true';

/**
 * Switches the deck page when the frontmost macOS app changes (and has a rule).
 * It only acts on *changes*, so you can still navigate pages manually afterwards.
 */
export class AppWatcher {
  private timer?: NodeJS.Timeout;
  private last?: string;
  private busy = false;

  constructor(
    private getConfig: () => Config,
    private capture: Capture,
    private setPage: (page: number) => Promise<void>,
    private log: (m: string) => void = () => {},
  ) {}

  start(intervalMs = 1500): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    const rules = this.getConfig().appPages;
    if (!rules?.length || this.busy) return;
    this.busy = true;
    try {
      const app = (await this.capture('osascript', ['-e', FRONTMOST])).trim();
      if (!app || app === this.last) return;
      this.last = app;
      const rule = rules.find((r) => r.app.toLowerCase() === app.toLowerCase());
      if (rule) await this.setPage(rule.page);
    } catch (e) {
      this.log(`app watcher: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }
}
