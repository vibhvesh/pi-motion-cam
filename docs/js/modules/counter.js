/* 2. People in/out counter — multi-person tracking across a virtual line */
SC.register({
  id: 'counter', name: 'In/Out counter', icon: '🚶', desc: 'Counts tracked people (or chosen classes) crossing a virtual line. Each person gets an ID, so several people can cross at once.',
  defaults: { enabled: true, telegram: false, line: [[0.5, 0.05], [0.5, 0.95]], invert: false, classes: ['person'], trails: true },
  geometry: ['line'],
  fields: [
    { k: 'invert', label: 'Swap IN / OUT direction', type: 'check' },
    { k: 'trails', label: 'Show movement trails', type: 'check' },
    { k: 'classes', label: 'Count these classes', type: 'classes', options: ['person', 'car', 'motorcycle', 'bicycle', 'truck', 'bus', 'dog', 'cow'] },
  ],
  onDetect(F) {
    const L = this.cfg.line; if (!L) return;
    for (const t of F.tracks) {
      if (!this.cfg.classes.includes(t.cls)) continue;
      const s = SC.geo.side(SC.geo.center(t), L[0], L[1]), prev = t.flags.cside;
      if (s) t.flags.cside = s;
      if (prev && s && s !== prev) {
        const dir = (s < 0) !== this.cfg.invert ? 'in' : 'out';   // default vertical line: left -> right = IN
        this.emit(dir, `${t.cls} #${t.id} ${dir.toUpperCase()} (IN ${(this.counts.in || 0) + (dir === 'in')} / OUT ${(this.counts.out || 0) + (dir === 'out')})`, { trackId: t.id });
      }
    }
  },
  draw(c, W, H) {
    const L = this.cfg.line; if (!L) return;
    SC.drawPoly(c, L, W, H, '#e0af68', null, false);
    // arrow showing IN direction
    const mx = (L[0][0] + L[1][0]) / 2 * W, my = (L[0][1] + L[1][1]) / 2 * H, dx = (L[1][0] - L[0][0]) * W, dy = (L[1][1] - L[0][1]) * H, n = Math.hypot(dx, dy) || 1;
    const k = this.cfg.invert ? 1 : -1, ax = -dy / n * 30 * k, ay = dx / n * 30 * k;
    c.beginPath(); c.moveTo(mx - ax, my - ay); c.lineTo(mx + ax, my + ay); c.stroke(); c.fillStyle = '#e0af68'; c.fillText('IN', mx + ax + 4, my + ay);
    c.fillText(`IN ${this.counts.in || 0}  OUT ${this.counts.out || 0}`, 10, H - 10);
    if (this.cfg.trails) for (const t of SC.S.tracks.values()) if (this.cfg.classes.includes(t.cls) && t.hist.length > 1) {
      c.beginPath(); t.hist.slice(-20).forEach(([, x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.stroke();
    }
  },
  stats() { const i = this.counts.in || 0, o = this.counts.out || 0; return { IN: i, OUT: o, 'Inside (est.)': Math.max(0, i - o) }; },
});
