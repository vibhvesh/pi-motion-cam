/* 3. Restricted area — alert when a person's feet enter a drawn polygon */
SC.register({
  id: 'zone', name: 'Restricted area', icon: '⛔', desc: "Draw one or more zones. Alerts when a tracked person's foot-point (bottom-centre of the box) enters. Optional active hours.",
  defaults: { zones: [], classes: ['person'], cooldown: 20 },
  geometry: ['zones'], schedule: true,
  fields: [{ k: 'classes', label: 'Classes', type: 'classes', options: ['person', 'car', 'motorcycle', 'bicycle', 'dog'] }],
  onDetect(F) {
    if (!this.active() || !this.cfg.zones.length) return;
    for (const t of F.tracks) {
      if (!this.cfg.classes.includes(t.cls)) continue;
      const p = SC.geo.foot(t);
      this.cfg.zones.forEach((z, i) => {
        const k = 'zone' + i, inside = SC.geo.inPoly(p, z.points);
        if (inside && !t.flags[k]) this.emit('intrusion', `${t.cls} #${t.id} entered restricted zone "${z.name}"`, { severity: 'alert', trackId: t.id });
        t.flags[k] = inside;
      });
    }
  },
  draw(c, W, H) { const on = this.active(); for (const z of this.cfg.zones) SC.drawPoly(c, z.points, W, H, on ? '#f7768e' : '#565f89', z.name + (on ? '' : ' (inactive)')); },
  stats() { return { Intrusions: this.counts.intrusion || 0 }; },
});
