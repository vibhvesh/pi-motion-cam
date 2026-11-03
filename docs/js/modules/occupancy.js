/* 8. Crowd / occupancy limit */
SC.register({
  id: 'occupancy', name: 'Crowd / occupancy', icon: '👥',
  desc: 'Shows how many people are in view (or inside a zone) and alerts when the count stays above the limit.',
  defaults: { zones: [], max: 5, holdSec: 5, cooldown: 120 },
  geometry: ['zones'],
  fields: [
    { k: 'max', label: 'Max. people', type: 'range', min: 1, max: 50, step: 1 },
    { k: 'holdSec', label: 'Over limit for (s)', type: 'range', min: 1, max: 60, step: 1 },
  ],
  onDetect(F) {
    const n = F.people.filter(t => !this.cfg.zones.length || this.cfg.zones.some(z => SC.geo.inPoly(SC.geo.foot(t), z.points))).length;
    this.now = n; this.counts.peak = Math.max(this.counts.peak || 0, n);
    if (n <= this.cfg.max) { this.since = null; this.alerted = false; return; }
    this.since ||= F.now;
    if (!this.alerted && F.now - this.since >= this.cfg.holdSec * 1000) { this.alerted = true; this.emit('over_limit', `Occupancy ${n} exceeds limit ${this.cfg.max}`, { severity: 'warning' }); }
  },
  draw(c, W, H) { for (const z of this.cfg.zones) SC.drawPoly(c, z.points, W, H, '#7dcfff', z.name); c.fillStyle = (this.now || 0) > this.cfg.max ? '#f7768e' : '#7dcfff'; c.fillText(`👥 ${this.now || 0}/${this.cfg.max}`, W - 90, 22); },
  stats() { return { 'Now': this.now || 0, 'Peak today': this.counts.peak || 0, 'Over-limit alerts': this.counts.over_limit || 0 }; },
});
