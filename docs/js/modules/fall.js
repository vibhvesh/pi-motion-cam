/* 4. Fall detection — MoveNet torso angle (fallback: box aspect) + sudden drop, then stays down */
SC.register({
  id: 'fall', name: 'Fall detection', icon: '🆘', needsPose: true,
  desc: 'Alerts when a person goes from upright to lying (torso angle from MoveNet pose, or box shape if pose is unsure) with a sudden drop, then stays down.',
  defaults: { downSec: 5, angle: 60, dropFrac: 0.25, cooldown: 30 },
  fields: [
    { k: 'downSec', label: 'Must stay down (s)', type: 'range', min: 1, max: 30, step: 1 },
    { k: 'angle', label: 'Lying if torso tilt > (°)', type: 'range', min: 40, max: 80, step: 5 },
    { k: 'dropFrac', label: 'Min. drop (fraction of height)', type: 'range', min: 0.05, max: 0.6, step: 0.05 },
  ],
  posture(t) {
    const a = SC.torsoAngle(t.pose && SC.S.tracks.get(t.id) === t && performance.now() - (t.poseHist.at(-1)?.[0] || 0) < 1500 ? t.pose : null);
    if (a != null) return a > this.cfg.angle ? 'down' : a < 30 ? 'up' : null;
    const [, , w, h] = t.box; return w > 1.3 * h ? 'down' : h > 1.4 * w ? 'up' : null;
  },
  onDetect(F) {
    for (const t of F.people) {
      const p = this.posture(t), st = t.flags.fall ||= { state: 'unknown' }, cy = t.box[1] + t.box[3] / 2;
      t.flags.posture = p;
      if (p === 'up') Object.assign(st, { state: 'up', upT: F.now, upH: t.box[3], upCy: cy, downT: null, alerted: false });
      else if (p === 'down' && st.state === 'up') {
        const dropped = cy - st.upCy > this.cfg.dropFrac * st.upH, fast = F.now - st.upT < 2000;
        if (dropped || fast) Object.assign(st, { state: 'falling', downT: F.now });
      } else if (p === 'down' && st.state === 'falling' && !st.alerted && F.now - st.downT >= this.cfg.downSec * 1000) {
        st.alerted = true; this.emit('fall', `Possible fall: person #${t.id} down for ${Math.round((F.now - st.downT) / 1000)} s`, { severity: 'alert', trackId: t.id });
      }
    }
  },
  draw(c) {
    for (const t of SC.S.tracks.values()) if (t.cls === 'person' && t.flags.fall?.state === 'falling') {
      const [x, y, w, h] = t.box; c.strokeStyle = '#f7768e'; c.setLineDash([8, 6]); c.strokeRect(x - 4, y - 4, w + 8, h + 8); c.setLineDash([]);
      c.fillStyle = '#f7768e'; c.fillText(t.flags.fall.alerted ? 'FALL!' : 'down…', x, y + h + 16);
    }
  },
  stats() { return { Falls: this.counts.fall || 0 }; },
});
