/*
 * Sandscape loading readout — the word "Loading" + a neon wireframe progress box.
 *
 * Engine integration: drive it from your asset/system loader via the global API:
 *
 *     SandscapeLoader.setProgress(loaded / total);   // 0..1, called as things load
 *     SandscapeLoader.setLabel('Compiling shaders');  // optional status text
 *     SandscapeLoader.complete();                      // snap to 100%
 *     window.addEventListener('sandscapeloadcomplete', () => { ... hide screen, start game ... });
 *
 * Until the first setProgress()/complete() call, a placeholder animation runs so
 * the screen looks alive in isolation. The engine takes over on first call.
 */
(function () {
  const root = document.getElementById('loader-ui');
  const label = document.getElementById('loading-label');
  const fill = document.getElementById('progress-fill');
  const percent = document.getElementById('progress-percent');

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  let displayed = 0;     // progress actually shown (0..1), eased toward target
  let target = 0;        // progress we're heading to (0..1)
  let engineDriven = false;
  let completed = false;

  // --- placeholder simulation (disabled once the engine drives progress) ----
  // Fills with the usual "slows down near the end" feel, holds full, then loops.
  let phase = 'fill';
  let phaseT = 0;

  function simulate(dt) {
    if (phase === 'fill') {
      const remaining = 1 - target;
      target = clamp01(target + dt * (0.09 + remaining * 0.5));
      if (displayed > 0.999) {
        phase = 'hold';
        phaseT = 0;
      }
    } else if (phase === 'hold') {
      phaseT += dt;
      if (phaseT > 1.4) {
        phase = 'fadeout';
        phaseT = 0;
      }
    } else if (phase === 'fadeout') {
      phaseT += dt;
      fill.style.opacity = String(clamp01(1 - phaseT / 0.35));
      if (phaseT >= 0.35) {
        displayed = 0;
        target = 0;
        phase = 'fadein';
        phaseT = 0;
      }
    } else if (phase === 'fadein') {
      phaseT += dt;
      fill.style.opacity = String(clamp01(phaseT / 0.35));
      if (phaseT >= 0.35) {
        fill.style.opacity = '1';
        phase = 'fill';
      }
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (!engineDriven) {
      simulate(dt);
    }
    // Ease the shown value toward the target for smooth, non-jumpy motion.
    displayed += (target - displayed) * (1 - Math.exp(-dt / 0.16));

    const pct = displayed * 100;
    fill.style.width = pct.toFixed(2) + '%';
    fill.style.setProperty('--tip', displayed.toFixed(3)); // glow tip intensifies with progress
    percent.textContent = Math.round(pct) + '%';

    if (completed && displayed > 0.997) {
      completed = false;
      root.classList.add('is-complete');
      window.dispatchEvent(new CustomEvent('sandscapeloadcomplete'));
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.SandscapeLoader = {
    /** Report real load progress, 0..1. First call disables the placeholder. */
    setProgress(p) {
      engineDriven = true;
      fill.style.opacity = '1';
      target = clamp01(Number(p) || 0);
    },
    /** Replace the "Loading" label with a status string. */
    setLabel(text) {
      if (label) label.textContent = String(text);
    },
    /** Jump to 100% and fire the 'sandscapeloadcomplete' event when shown. */
    complete() {
      engineDriven = true;
      fill.style.opacity = '1';
      target = 1;
      completed = true;
    },
    /** Current shown progress, 0..1. */
    get value() {
      return displayed;
    },
  };
})();
