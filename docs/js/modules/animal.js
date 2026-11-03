/* 9. Animal detection + vehicle log */
SC.register({
  id: 'animal', name: 'Animal detection', icon: '🐄', schedule: true,
  desc: 'Logs each new animal (COCO classes: bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe).',
  defaults: { classes: ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'bear', 'elephant'], cooldown: 60 },
  fields: [{ k: 'classes', label: 'Animals', type: 'classes', options: SC.ANIMALS }],
  onDetect(F) {
    if (!this.active()) return;
    for (const t of F.tracks) if (this.cfg.classes.includes(t.cls) && !t.flags.animal) { t.flags.animal = true; this.emit(t.cls, `Animal: ${t.cls} #${t.id}`, { severity: 'warning', trackId: t.id }); }
  },
  stats() { return Object.fromEntries(Object.entries(this.counts)); },
});
SC.register({
  id: 'vehicle', name: 'Vehicle log', icon: '🚗',
  desc: 'Logs each new vehicle (car, truck, bus, motorcycle, bicycle). Counts appear in the daily summary.',
  defaults: { telegram: false, classes: SC.VEHICLES, cooldown: 60 },
  fields: [{ k: 'classes', label: 'Vehicles', type: 'classes', options: SC.VEHICLES }],
  onDetect(F) { for (const t of F.tracks) if (this.cfg.classes.includes(t.cls) && !t.flags.veh) { t.flags.veh = true; this.emit(t.cls, `Vehicle: ${t.cls} #${t.id}`, { trackId: t.id }); } },
  stats() { return Object.fromEntries(Object.entries(this.counts)); },
});
