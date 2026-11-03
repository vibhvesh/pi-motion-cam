/* 6. Perimeter / farm intruder — tripwire and/or zones for people and animals, night-friendly */
SC.register({
  id: 'perimeter', name: 'Perimeter / farm', icon: '🚜', schedule: true,
  desc: 'Farm or perimeter mode: alerts when selected classes (people and animals) cross a tripwire or enter a zone. Night mode brightens frames and lowers the confidence threshold (Settings → Night mode).',
  defaults: { line: null, zones: [], direction: 'both', classes: ['person', 'cow', 'dog', 'horse', 'sheep'], cooldown: 30 },
  geometry: ['line', 'zones'],
  fields: [
    { k: 'direction', label: 'Tripwire direction', type: 'select', options: [['both', 'Both ways'], ['pos', 'Only ← / ↑ side to other'], ['neg', 'Only → / ↓ side to other']] },
    { k: 'classes', label: 'Watch for', type: 'classes', options: ['person', ...SC.ANIMALS, 'car', 'motorcycle', 'truck'] },
  ],
  onDetect(F) {
    if (!this.active()) return;
    for (const t of F.tracks) {
      if (!this.cfg.classes.includes(t.cls)) continue;
      const p = SC.geo.foot(t), L = this.cfg.line;
      if (L) {
        const s = SC.geo.side(p, L[0], L[1]), prev = t.flags.pside; if (s) t.flags.pside = s;
        if (prev && s && s !== prev && (this.cfg.direction === 'both' || (this.cfg.direction === 'pos') === (s < 0)))
          this.emit('tripwire', `Intruder: ${t.cls} #${t.id} crossed the perimeter line`, { severity: 'alert', trackId: t.id });
      }
      this.cfg.zones.forEach((z, i) => {
        const k = 'pz' + i, inside = SC.geo.inPoly(p, z.points);
        if (inside && !t.flags[k]) this.emit('zone', `Intruder: ${t.cls} #${t.id} entered "${z.name}"`, { severity: 'alert', trackId: t.id });
        t.flags[k] = inside;
      });
    }
  },
  draw(c, W, H) { if (this.cfg.line) SC.drawPoly(c, this.cfg.line, W, H, '#ff9e64', 'perimeter', false); for (const z of this.cfg.zones) SC.drawPoly(c, z.points, W, H, '#ff9e64', z.name); },
  stats() { return { Intrusions: (this.counts.tripwire || 0) + (this.counts.zone || 0) }; },
});
