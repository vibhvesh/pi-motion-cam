/* 7. Loitering — person stays in a zone (or anywhere) too long */
SC.register({
  id: 'loiter', name: 'Loitering', icon: '⏱️', schedule: true,
  desc: 'Alerts when the same tracked person stays inside a zone (or anywhere in view, if no zone is drawn) longer than the limit.',
  defaults: { zones: [], maxSec: 30, cooldown: 60 },
  geometry: ['zones'],
  fields: [{ k: 'maxSec', label: 'Max. stay (s)', type: 'range', min: 5, max: 600, step: 5 }],
  onDetect(F) {
    if (!this.active()) return;
    for (const t of F.people) {
      const inside = !this.cfg.zones.length || this.cfg.zones.some(z => SC.geo.inPoly(SC.geo.foot(t), z.points));
      if (!inside) { delete t.flags.lSince; continue; }
      t.flags.lSince ||= F.now;
      if (!t.flags.lAlert && F.now - t.flags.lSince >= this.cfg.maxSec * 1000) { t.flags.lAlert = true; this.emit('loitering', `Person #${t.id} loitering for ${Math.round((F.now - t.flags.lSince) / 1000)} s`, { severity: 'warning', trackId: t.id }); }
    }
  },
  draw(c, W, H) {
    for (const z of this.cfg.zones) SC.drawPoly(c, z.points, W, H, '#bb9af7', z.name);
    for (const t of SC.S.tracks.values()) if (t.flags.lSince && performance.now() - t.last < 600) { c.fillStyle = '#bb9af7'; c.fillText(`${Math.round((performance.now() - t.flags.lSince) / 1000)}s`, t.box[0] + 3, t.box[1] + t.box[3] - 6); }
  },
  stats() { return { Loiterers: this.counts.loitering || 0 }; },
});
