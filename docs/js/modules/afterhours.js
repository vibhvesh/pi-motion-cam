/* 10. After-hours / night activity */
SC.register({
  id: 'afterhours', name: 'After-hours activity', icon: '🌙', schedule: true,
  desc: 'During the active hours (default 20:00–06:00), alerts on any person or vehicle.',
  defaults: { schedule: '20:00-06:00', classes: ['person', 'car', 'motorcycle', 'truck', 'bicycle'], cooldown: 60 },
  fields: [{ k: 'classes', label: 'Classes', type: 'classes', options: ['person', ...SC.VEHICLES, 'dog'] }],
  onDetect(F) {
    if (!this.active()) return;
    for (const t of F.tracks) if (this.cfg.classes.includes(t.cls) && !t.flags.ah) { t.flags.ah = true; this.emit('activity', `After-hours: ${t.cls} #${t.id}`, { severity: 'alert', trackId: t.id }); }
  },
  stats() { return { Alerts: this.counts.activity || 0, 'Active now': this.active() ? 'yes' : 'no' }; },
});
