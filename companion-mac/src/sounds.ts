import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runner } from './actions.js';
import type { Config } from './config.js';

export const BUILTIN_SOUNDS = ['chirp', 'confirm', 'error', 'blip'] as const;
export type SoundKind = 'press' | 'error';

const here = dirname(fileURLToPath(import.meta.url));
/** sounds/ sits beside src/ and dist/, so it resolves from both. */
export const SOUNDS_DIR = join(here, '..', 'sounds');

/** Resolve a configured sound to a file path, or null for none/unknown/missing. */
export function resolveSound(name: string | undefined, dir = SOUNDS_DIR): string | null {
  if (!name || name === 'none') return null;
  if ((BUILTIN_SOUNDS as readonly string[]).includes(name)) {
    const f = join(dir, `${name}.wav`);
    return existsSync(f) ? f : null;
  }
  return isAbsolute(name) && existsSync(name) ? name : null;
}

/** Plays short feedback sounds on the Mac for deck presses/errors (afplay, fire-and-forget). */
export class SoundPlayer {
  constructor(
    private getConfig: () => Config,
    private run: Runner,
    private log: (m: string) => void = () => {},
    private dir = SOUNDS_DIR,
  ) {}

  play(kind: SoundKind): void {
    const s = this.getConfig().sounds;
    const file = resolveSound(s?.[kind], this.dir);
    if (!file) return;
    const vol = ((s?.volume ?? 60) / 100).toFixed(2);
    this.run('afplay', ['-v', vol, file], { detached: true }).catch((e) =>
      this.log(`sound: ${e instanceof Error ? e.message : e}`),
    );
  }
}
