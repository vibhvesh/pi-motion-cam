/* 5. Fight / violence — EXPERIMENTAL: people close together + high limb (pose) or motion energy, sustained */
SC.register({
  id: 'fight', name: 'Fight / violence', icon: '🥊', needsPose: true, experimental: true,
  desc: 'EXPERIMENTAL heuristic, not a trained violence classifier: two or more people close together with fast limb movement (MoveNet) or heavy motion around them for several seconds. Expect false alarms (dancing, hugging, sports).',
  defaults: { holdSec: 3, energy: 1.0, proximity: 1.0, cooldown: 60 },
  fields: [
    { k: 'holdSec', label: 'Sustained for (s)', type: 'range', min: 1, max: 10, step: 1 },
    { k: 'energy', label: 'Limb speed threshold (body-heights/s)', type: 'range', min: 0.3, max: 4, step: 0.1 },
    { k: 'proximity', label: 'Closeness (× box width)', type: 'range', min: 0.5, max: 2.5, step: 0.1 },
  ],
  limbEnergy(t, now) {
    const h = t.poseHist; if (h.length < 2 || now - h.at(-1)[0] > 1000) return null;
    const [t0, a] = h.at(-2), [t1, b] = h.at(-1), dt = Math.max(0.05, (t1 - t0) / 1000);
    const d = [7, 8, 9, 10, 13, 14, 15, 16].filter(i => a[i].s > 0.3 && b[i].s > 0.3).map(i => Math.hypot(b[i].x - a[i].x, b[i].y - a[i].y));
    return d.length ? d.reduce((x, y) => x + y) / d.length / Math.max(1, t.box[3]) / dt : null;
  },
  motionEnergy(a, b) { // fraction of changed pixels in the pair's union box (small motion mask)
    const S = SC.S, m = S.mask; if (!m) return 0;
    const x0 = Math.min(a.box[0], b.box[0]) / S.W * S.SW | 0, y0 = Math.min(a.box[1], b.box[1]) / S.H * S.SH | 0;
    const x1 = Math.max(a.box[0] + a.box[2], b.box[0] + b.box[2]) / S.W * S.SW | 0, y1 = Math.max(a.box[1] + a.box[3], b.box[1] + b.box[3]) / S.H * S.SH | 0;
    let n = 0, c = 0; for (let y = y0; y < Math.min(S.SH, y1); y++) for (let x = x0; x < Math.min(S.SW, x1); x++) { n++; c += m[y * S.SW + x]; }
    return n ? c / n * 4 : 0; // scaled so ~0.3 motion fraction ≈ 1.2
  },
  onDetect(F) {
    let best = 0, pair = null; const P = F.people;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j], d = Math.hypot(a.box[0] + a.box[2] / 2 - b.box[0] - b.box[2] / 2, a.box[1] + a.box[3] / 2 - b.box[1] - b.box[3] / 2);
      if (d > this.cfg.proximity * (a.box[2] + b.box[2]) / 2) continue;
      const ea = this.limbEnergy(a, F.now), eb = this.limbEnergy(b, F.now);
      const e = ea != null || eb != null ? Math.max(ea || 0, eb || 0) : this.motionEnergy(a, b);
      if (e > best) { best = e; pair = [a, b]; }
    }
    this.ema = 0.6 * (this.ema || 0) + 0.4 * best; // smoothed so one quiet frame doesn't reset
    this.energyNow = this.ema; if (pair) this.pair = pair;
    if (this.ema < this.cfg.energy) { this.since = null; this.alerted = false; return; }
    this.since ||= F.now;
    if (!this.alerted && F.now - this.since >= this.cfg.holdSec * 1000) {
      this.alerted = true; this.emit('fight', `EXPERIMENTAL: possible fight between #${pair[0].id} and #${pair[1].id} (energy ${this.ema.toFixed(2)})`, { severity: 'alert' });
    }
  },
  draw(c) {
    if (!this.pair || !this.since) return;
    const [a, b] = this.pair, x = Math.min(a.box[0], b.box[0]), y = Math.min(a.box[1], b.box[1]);
    c.strokeStyle = '#ff9e64'; c.strokeRect(x, y, Math.max(a.box[0] + a.box[2], b.box[0] + b.box[2]) - x, Math.max(a.box[1] + a.box[3], b.box[1] + b.box[3]) - y);
    c.fillStyle = '#ff9e64'; c.fillText(`energy ${this.energyNow.toFixed(2)}`, x, y - 4);
  },
  stats() { return { 'Possible fights': this.counts.fight || 0 }; },
});
