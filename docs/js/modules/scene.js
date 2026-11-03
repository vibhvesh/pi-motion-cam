/* 11. Camera tamper (covered / blurred / moved) and 12. EXPERIMENTAL fire/smoke — run on the small frame every frame */
SC.register({
  id: 'tamper', name: 'Camera tamper', icon: '🛡️',
  desc: 'Detects when the camera is covered or dark, out of focus or smeared (Laplacian sharpness), or suddenly moved (scene changed).',
  defaults: { enabled: true, dark: 15, flat: 8, blur: 12, change: 0.5, holdSec: 3, cooldown: 120 },
  fields: [
    { k: 'dark', label: 'Covered if brightness <', type: 'range', min: 2, max: 60, step: 1 },
    { k: 'blur', label: 'Blurred if sharpness <', type: 'range', min: 1, max: 80, step: 1 },
    { k: 'change', label: 'Moved if similarity <', type: 'range', min: 0.1, max: 0.9, step: 0.05 },
    { k: 'holdSec', label: 'Must last (s)', type: 'range', min: 1, max: 15, step: 1 },
  ],
  st: {}, ref: null, refT: 0, lastT: 0,
  check(key, bad, now, msg) {
    if (!bad) { delete this.st[key]; return; }
    const s = this.st[key] ||= { since: now };
    if (!s.alerted && now - s.since >= this.cfg.holdSec * 1000) { s.alerted = true; this.emit(key, msg, { severity: 'alert' }); }
  },
  onFast(S, now) {
    if (now - this.lastT < 200) return; this.lastT = now;
    const g = S.gray, W = S.SW, H = S.SH, n = g.length;
    let sum = 0, sq = 0; const hist = new Float32Array(32);
    for (let i = 0; i < n; i++) { sum += g[i]; sq += g[i] * g[i]; hist[g[i] >> 3]++; }
    const mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
    let ls = 0, lq = 0, ln = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x, v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W]; ls += v; lq += v * v; ln++; }
    const lap = lq / ln - (ls / ln) ** 2;
    const norm = h => { const m = h.reduce((a, b) => a + b) / h.length; return h.map(v => v - m); };
    const hn = norm(hist);
    if (!this.ref || (now - this.refT > 30000 && !this.st.moved && !this.st.covered)) { this.ref = hn; this.refT = now; }
    let num = 0, da = 0, db = 0; for (let i = 0; i < 32; i++) { num += hn[i] * this.ref[i]; da += hn[i] ** 2; db += this.ref[i] ** 2; }
    const corr = num / Math.sqrt(da * db + 1e-9);
    this.live = { mean, std, lap, corr };
    this.check('covered', mean < this.cfg.dark || std < this.cfg.flat, now, `Camera covered or dark (brightness ${mean.toFixed(0)})`);
    this.check('blurred', lap < this.cfg.blur && std >= this.cfg.flat, now, `Camera blurred / smeared (sharpness ${lap.toFixed(0)})`);
    this.check('moved', corr < this.cfg.change, now, `Scene changed suddenly — camera moved? (similarity ${corr.toFixed(2)})`);
    if (this.st.moved?.alerted) { this.ref = hn; this.refT = now; delete this.st.moved; }
  },
  stats() { const l = this.live; return { Covered: this.counts.covered || 0, Blurred: this.counts.blurred || 0, Moved: this.counts.moved || 0, ...(l ? { 'Live': `bright ${l.mean.toFixed(0)} · sharp ${l.lap.toFixed(0)} · sim ${l.corr.toFixed(2)}` } : {}) }; },
});
SC.register({
  id: 'fire', name: 'Fire / smoke', icon: '🔥', experimental: true,
  desc: 'EXPERIMENTAL color + flicker heuristic, not a certified smoke alarm. Flame-colored pixels that flicker, and grey low-saturation areas that keep changing. Sunsets, red clothing and lamps can trigger it.',
  defaults: { fireFrac: 0.5, flicker: 0.3, smokeFrac: 15, holdSec: 4, cooldown: 120 },
  fields: [
    { k: 'fireFrac', label: 'Min. flame pixels (%)', type: 'range', min: 0.1, max: 10, step: 0.1 },
    { k: 'flicker', label: 'Min. flicker', type: 'range', min: 0.05, max: 1, step: 0.05 },
    { k: 'smokeFrac', label: 'Min. smoke area (%)', type: 'range', min: 2, max: 60, step: 1 },
    { k: 'holdSec', label: 'Must last (s)', type: 'range', min: 1, max: 15, step: 1 },
  ],
  hist: [], lastT: 0,
  onFast(S, now) {
    if (now - this.lastT < 150) return; this.lastT = now;
    const d = S.rgba, m = S.mask, n = S.SW * S.SH; let fire = 0, smoke = 0;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (r > 180 && r > g && g > b && r - b > 60 && mx > 170) fire++;
      else if (m[i] && mx - mn < 25 && mx > 90 && mx < 220) smoke++;
    }
    const f = fire / n * 100, s = smoke / n * 100;
    this.hist.push(f); if (this.hist.length > 20) this.hist.shift();
    const mean = this.hist.reduce((a, b) => a + b, 0) / this.hist.length, recent = this.hist.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, this.hist.length);
    const sd = Math.sqrt(this.hist.reduce((a, b) => a + (b - mean) ** 2, 0) / this.hist.length), flick = this.hist.length > 5 ? sd / (mean + 1e-6) : 0;
    this.live = { f: recent, flick, s };
    if (recent >= this.cfg.fireFrac && flick >= this.cfg.flicker) { this.fs ||= now; if (!this.fa && now - this.fs >= this.cfg.holdSec * 1000) { this.fa = true; this.emit('fire', `EXPERIMENTAL: possible fire (${recent.toFixed(1)}% flame pixels, flicker ${flick.toFixed(2)})`, { severity: 'alert' }); } }
    else { this.fs = null; this.fa = false; }
    if (s >= this.cfg.smokeFrac) { this.ss ||= now; if (!this.sa && now - this.ss >= this.cfg.holdSec * 1000) { this.sa = true; this.emit('smoke', `EXPERIMENTAL: possible smoke (${s.toFixed(0)}% of view)`, { severity: 'warning' }); } }
    else { this.ss = null; this.sa = false; }
  },
  stats() { const l = this.live; return { Fire: this.counts.fire || 0, Smoke: this.counts.smoke || 0, ...(l ? { Live: `flame ${l.f.toFixed(1)}% · flicker ${l.flick.toFixed(2)} · smoke ${l.s.toFixed(0)}%` } : {}) }; },
});
