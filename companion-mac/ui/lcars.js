// LCARS flavour: colour schemes + synthesized interface sounds (WebAudio, no audio files).
(function () {
  const THEMES = ['tng', 'voyager', 'picard'];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  };

  // ---- colour scheme ----
  let theme = store.get('sd-theme');
  if (!THEMES.includes(theme)) theme = 'tng';
  document.documentElement.dataset.theme = theme;

  // ---- sounds: [freqStart, freqEnd, startSec, durSec, gain] ----
  const SOUNDS = {
    blip: [[1500, 1500, 0, 0.045, 0.07]],
    chirp: [[1100, 1700, 0, 0.055, 0.09], [1700, 2100, 0.055, 0.045, 0.08]],
    confirm: [[880, 880, 0, 0.07, 0.08], [1175, 1175, 0.08, 0.07, 0.08], [1760, 1760, 0.16, 0.13, 0.08]],
    error: [[220, 200, 0, 0.14, 0.11], [180, 160, 0.18, 0.2, 0.11]],
  };
  let soundOn = store.get('sd-sound') !== 'off';
  let ctx;

  window.lcarsSound = function (name) {
    if (!soundOn || !SOUNDS[name]) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const t0 = ctx.currentTime;
      for (const [f0, f1, start, dur, gain] of SOUNDS[name]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.setValueAtTime(f0, t0 + start);
        osc.frequency.linearRampToValueAtTime(f1, t0 + start + dur);
        g.gain.setValueAtTime(0, t0 + start);
        g.gain.linearRampToValueAtTime(gain, t0 + start + 0.004);
        g.gain.linearRampToValueAtTime(0, t0 + start + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(t0 + start);
        osc.stop(t0 + start + dur + 0.02);
      }
    } catch { /* audio unavailable: stay silent */ }
  };

  // ---- controls ----
  const sel = document.getElementById('themeSel');
  if (sel) {
    sel.value = theme;
    sel.addEventListener('change', () => {
      theme = THEMES.includes(sel.value) ? sel.value : 'tng';
      document.documentElement.dataset.theme = theme;
      store.set('sd-theme', theme);
      window.lcarsSound('confirm');
    });
  }
  const btn = document.getElementById('soundBtn');
  const paint = () => { if (btn) btn.textContent = soundOn ? 'Sound: on' : 'Sound: off'; };
  if (btn) {
    paint();
    btn.addEventListener('click', () => {
      soundOn = !soundOn;
      store.set('sd-sound', soundOn ? 'on' : 'off');
      paint();
      window.lcarsSound('chirp');
    });
  }

  // Interface beeps for clicks (capture phase so they fire even if handlers re-render).
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('button, .tab, .cell, .icons img, .ifyicon');
    if (!t || t.id === 'soundBtn') return;
    window.lcarsSound(t.matches('.tab, .cell, .icons img, .ifyicon') ? 'chirp' : 'blip');
  }, true);
})();
