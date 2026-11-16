// Generates the built-in feedback sounds as 16-bit mono WAVs. Original synthesized tones.
// Run: node scripts/make-sounds.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds');
mkdirSync(out, { recursive: true });

// notes: [freqStart, freqEnd, ms, gain]; each gets a short attack/release envelope.
function render(notes, gapMs = 0) {
  const chunks = [];
  for (const [f0, f1, ms, gain = 0.5] of notes) {
    const n = Math.floor((RATE * ms) / 1000);
    const buf = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const f = f0 + (f1 - f0) * t;
      phase += (2 * Math.PI * f) / RATE;
      const env = Math.min(1, i / (RATE * 0.004)) * Math.min(1, (n - i) / (RATE * 0.012));
      buf[i] = (Math.sin(phase) * 0.8 + Math.sin(phase * 2) * 0.15) * env * gain;
    }
    chunks.push(buf);
    if (gapMs) chunks.push(new Float32Array(Math.floor((RATE * gapMs) / 1000)));
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(new Int16Array(Array.from(c, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))).buffer)));
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const sounds = {
  blip: render([[1500, 1500, 45, 0.35]]),
  chirp: render([[1100, 1700, 55, 0.45], [1700, 2100, 45, 0.4]]),
  confirm: render([[880, 880, 70, 0.4], [1175, 1175, 70, 0.4], [1760, 1760, 130, 0.4]], 12),
  error: render([[220, 200, 140, 0.55], [180, 160, 200, 0.55]], 40),
};
for (const [name, pcm] of Object.entries(sounds)) writeFileSync(join(out, `${name}.wav`), wav(pcm));
console.log('wrote', Object.keys(sounds).join(', '));
