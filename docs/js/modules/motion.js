/* Classic motion snapshot (the original behaviour) */
SC.register({
  id: 'motion', name: 'Motion snapshots', icon: '📸',
  desc: 'The original mode: saves a snapshot to the event log when there is motion (optionally only when a person is in view).',
  defaults: { enabled: true, personOnly: true, cooldown: 10 },
  fields: [{ k: 'personOnly', label: 'Only when a person is detected', type: 'check' }],
  last: 0,
  onDetect(F) {
    if (!F.moving || (this.cfg.personOnly && !F.people.length) || F.now - this.last < this.cfg.cooldown * 1000) return;
    this.last = F.now; this.emit('motion', `Motion · ${F.people.length} person(s)`, {});
  },
  stats() { return { Snapshots: this.counts.motion || 0 }; },
});
