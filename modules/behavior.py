"""Modules 4 & 5: fall detection and (experimental) fight detection. Use MoveNet pose if available, else box/motion heuristics."""
import numpy as np

from .base import Module, Event, PERSON
from .pose import torso_angle


class FallModule(Module):
    """Upright -> horizontal transition with a sudden centroid drop, then staying down for down_seconds."""
    name = "fall"
    needs_pose = True

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.down_s = cfg.get("down_seconds", 5)
        self.drop_frac = cfg.get("drop_fraction", 0.25)   # centroid drop as fraction of upright height
        self.window = cfg.get("fall_window_seconds", 2.0)

    @staticmethod
    def _posture(t):
        ang = torso_angle(t.pose)
        if ang is not None:
            return "down" if ang > 60 else "up" if ang < 30 else None
        x, y, w, h = t.box
        return "down" if w > 1.3 * h else "up" if h > 1.4 * w else None

    def process(self, f):
        ev = []
        for t in f.tracks.values():
            if t.cls != PERSON:
                continue
            p = self._posture(t)
            st = t.flags.setdefault("fall", {"state": "unknown", "up_ts": None, "up_h": None, "up_cy": None, "down_ts": None})
            if p == "up":
                st.update(state="up", up_ts=f.ts, up_h=t.box[3], up_cy=t.centroid[1], down_ts=None)
                st.pop("alerted", None)
            elif p == "down" and st["state"] in ("up", "falling"):
                if st["state"] == "up":
                    dropped = st["up_cy"] is not None and t.centroid[1] - st["up_cy"] > self.drop_frac * st["up_h"]
                    fast = f.ts - (st["up_ts"] or 0) <= self.window
                    if dropped or fast:
                        st.update(state="falling", down_ts=f.ts)
                elif f.ts - st["down_ts"] >= self.down_s and not st.get("alerted"):
                    st["alerted"] = True
                    self.count("falls")
                    ev.append(Event(self.name, "fall", f"Possible fall: person #{t.id} down for {int(f.ts - st['down_ts'])} s", "alert", t.id))
        return ev


class FightModule(Module):
    """EXPERIMENTAL. Two+ people close together with high limb (pose) or motion energy sustained for hold_seconds."""
    name = "fight"
    needs_pose = True

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.hold = cfg.get("hold_seconds", 3)
        self.energy_thr = cfg.get("energy_threshold", 0.15)   # body-heights per second (pose) / motion fraction (fallback)
        self.close = cfg.get("proximity", 1.0)                 # center distance < proximity * mean box width
        self.since, self.alerted, self.energy = None, False, 0.0

    @staticmethod
    def _pose_energy(t):
        if len(t.pose_hist) < 2:
            return None
        (t0, k0), (t1, k1) = t.pose_hist[-2], t.pose_hist[-1]
        dt = max(1e-3, t1 - t0)
        limbs = [7, 8, 9, 10, 13, 14, 15, 16]
        d = [np.hypot(k1[i][0] - k0[i][0], k1[i][1] - k0[i][1]) for i in limbs if k0[i][2] > 0.3 and k1[i][2] > 0.3]
        return (np.mean(d) / max(1, t.box[3]) / dt) if d else None

    def _motion_energy(self, f, a, b):
        if f.motion_mask is None:
            return 0.0
        W, H = f.size
        lw, lh = f.lores_size
        x0, y0 = min(a.box[0], b.box[0]), min(a.box[1], b.box[1])
        x1, y1 = max(a.box[0] + a.box[2], b.box[0] + b.box[2]), max(a.box[1] + a.box[3], b.box[1] + b.box[3])
        sx, sy = lw / W, lh / H
        roi = f.motion_mask[int(y0 * sy):int(y1 * sy) + 1, int(x0 * sx):int(x1 * sx) + 1]
        return float(np.count_nonzero(roi)) / roi.size if roi.size else 0.0

    def process(self, f):
        people = [t for t in f.tracks.values() if t.cls == PERSON]
        best = 0.0
        for i in range(len(people)):
            for j in range(i + 1, len(people)):
                a, b = people[i], people[j]
                (ax, ay), (bx, by) = a.centroid, b.centroid
                if np.hypot(ax - bx, ay - by) > self.close * (a.box[2] + b.box[2]) / 2:
                    continue
                ea, eb = self._pose_energy(a), self._pose_energy(b)
                e = max(ea or 0, eb or 0) if (ea is not None or eb is not None) else self._motion_energy(f, a, b)
                best = max(best, e)
        self.energy = 0.6 * self.energy + 0.4 * best  # smoothed so one quiet frame doesn't reset
        if self.energy < self.energy_thr:
            self.since, self.alerted = None, False
            return []
        self.since = self.since or f.ts
        if not self.alerted and f.ts - self.since >= self.hold:
            self.alerted = True
            self.count("fights")
            return [Event(self.name, "fight", f"EXPERIMENTAL: possible fight/violence (energy {self.energy:.2f})", "alert")]
        return []
