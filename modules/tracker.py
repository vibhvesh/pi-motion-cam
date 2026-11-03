"""Simple multi-object centroid/IoU tracker giving each detection a stable ID."""
from collections import deque
from dataclasses import dataclass, field


@dataclass
class Detection:
    cls: str
    conf: float
    box: tuple  # x, y, w, h (full-res pixels)
    track_id: int = None

    @property
    def centroid(self):
        x, y, w, h = self.box
        return x + w / 2, y + h / 2

    @property
    def foot(self):
        x, y, w, h = self.box
        return x + w / 2, y + h


@dataclass
class Track:
    id: int
    cls: str
    box: tuple
    first_seen: float
    last_seen: float
    history: deque = field(default_factory=lambda: deque(maxlen=60))  # (ts, cx, cy, w, h)
    pose: object = None          # latest keypoints [(x, y, score)] * 17 or None
    pose_hist: deque = field(default_factory=lambda: deque(maxlen=30))  # (ts, keypoints)
    flags: dict = field(default_factory=dict)  # per-module state

    @property
    def centroid(self):
        x, y, w, h = self.box
        return x + w / 2, y + h / 2

    @property
    def foot(self):
        x, y, w, h = self.box
        return x + w / 2, y + h

    @property
    def age(self):
        return self.last_seen - self.first_seen


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix, iy = max(0, min(ax + aw, bx + bw) - max(ax, bx)), max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    u = aw * ah + bw * bh - inter
    return inter / u if u else 0.0


class Tracker:
    def __init__(self, max_lost_s=2.0, max_dist_frac=0.25):
        self.tracks, self.next_id = {}, 1
        self.max_lost, self.max_dist_frac = max_lost_s, max_dist_frac

    def update(self, dets, ts, frame_w):
        unmatched = set(self.tracks)
        pairs = []
        for di, d in enumerate(dets):
            for tid in self.tracks:
                t = self.tracks[tid]
                if t.cls != d.cls:
                    continue
                (cx, cy), (tx, ty) = d.centroid, t.centroid
                dist = ((cx - tx) ** 2 + (cy - ty) ** 2) ** 0.5
                if dist > self.max_dist_frac * frame_w and iou(d.box, t.box) == 0:
                    continue
                pairs.append((iou(d.box, t.box) - dist / frame_w, di, tid))
        used = set()
        for _, di, tid in sorted(pairs, reverse=True):
            if di in used or tid not in unmatched:
                continue
            used.add(di)
            unmatched.discard(tid)
            self._assign(self.tracks[tid], dets[di], ts)
        for di, d in enumerate(dets):
            if di not in used:
                t = Track(self.next_id, d.cls, d.box, ts, ts)
                self.next_id += 1
                self.tracks[t.id] = t
                self._assign(t, d, ts)
        for tid in list(self.tracks):
            if ts - self.tracks[tid].last_seen > self.max_lost:
                del self.tracks[tid]
        return {d.track_id: self.tracks[d.track_id] for d in dets}

    @staticmethod
    def _assign(t, d, ts):
        t.box, t.last_seen = d.box, ts
        x, y, w, h = d.box
        t.history.append((ts, x + w / 2, y + h / 2, w, h))
        d.track_id = t.id
