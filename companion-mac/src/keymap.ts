// macOS virtual key codes (ANSI layout) and combo parsing.

const KEYS: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, return: 36, l: 37,
  j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48,
  space: 49, '`': 50, delete: 51, escape: 53,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80,
  home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  left: 123, right: 124, down: 125, up: 126,
};

const KEY_ALIASES: Record<string, string> = {
  enter: 'return', esc: 'escape', backspace: 'delete', del: 'forwarddelete', pgup: 'pageup',
  pgdn: 'pagedown', plus: '=', minus: '-', spacebar: 'space', arrowleft: 'left', arrowright: 'right',
  arrowup: 'up', arrowdown: 'down',
};

const MODIFIERS: Record<string, 'command' | 'control' | 'option' | 'shift'> = {
  cmd: 'command', command: 'command', meta: 'command', win: 'command', super: 'command',
  ctrl: 'control', control: 'control',
  alt: 'option', option: 'option', opt: 'option',
  shift: 'shift',
};

export interface ParsedCombo {
  keyCode: number;
  modifiers: Array<'command' | 'control' | 'option' | 'shift'>;
}

/** Parse "cmd+shift+4", "CTRL+ALT+DELETE", "f5" ... Throws on unknown tokens. */
export function parseCombo(combo: string): ParsedCombo {
  const tokens = combo.split('+').map((t) => t.trim().toLowerCase()).filter(Boolean);
  // "cmd++" style: a trailing empty token after '+' means the plus/equals key.
  if (combo.trim().endsWith('+') && !tokens.includes('plus')) tokens.push('=');
  const modifiers: ParsedCombo['modifiers'] = [];
  let keyCode: number | undefined;
  for (const raw of tokens) {
    const mod = MODIFIERS[raw];
    if (mod) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
      continue;
    }
    const name = KEY_ALIASES[raw] ?? raw;
    const code = KEYS[name];
    if (code === undefined) throw new Error(`Unknown key "${raw}" in combo "${combo}"`);
    if (keyCode !== undefined) throw new Error(`Combo "${combo}" has more than one non-modifier key`);
    keyCode = code;
  }
  if (keyCode === undefined) throw new Error(`Combo "${combo}" has no key`);
  return { keyCode, modifiers };
}

export function comboToAppleScript({ keyCode, modifiers }: ParsedCombo): string {
  const using = modifiers.length ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}` : '';
  return `tell application "System Events" to key code ${keyCode}${using}`;
}
