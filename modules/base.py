"""Shared types and helpers for Pi Motion Cam modules."""
import time
from dataclasses import dataclass, field
from datetime import datetime

import cv2
import numpy as np

PERSON = "person"
VEHICLES = {"car", "bus", "motorbike", "motorcycle", "bicycle", "truck"}
ANIMALS = {"cow", "dog", "horse", "sheep", "bird", "cat", "bear", "elephant", "zebra", "giraffe"}


@dataclass
class Event:
    module: str
    type: str
    message: str
    severity: str = "info"          # info | warning | alert
    track_id: int = None
    extra: dict = field(default_factory=dict)
    image: object = None            # optional crop/image to attach instead of the full frame


@dataclass
class Frame:
    ts: float
    image: np.ndarray               # full-res BGR (None on lores-only ticks)
    gray_lores: np.ndarray          # lores Y plane
    motion_mask: np.ndarray         # lores motion mask (or None)
    motion_area: int
    detections: list                # [Detection]
    tracks: dict                    # id -> Track (only currently visible ones)
    lores_size: tuple
    faces: list = field(default_factory=list)  # [(loc, name, enc)] if attendance active

    @property
    def size(self):
        h, w = self.image.shape[:2]
        return w, h


def in_schedule(spec, now=None):
    """spec: '' / None (always) or 'HH:MM-HH:MM[,HH:MM-HH:MM]' (ranges may wrap past midnight)."""
    if not spec:
        return True
    t = (now or datetime.now()).strftime("%H:%M")
    for part in str(spec).split(","):
        a, _, b = part.strip().partition("-")
        if not b:
            continue
        if (a <= t < b) if a <= b else (t >= a or t < b):
            return True
    return False


def point_in_poly(pt, poly):
    return cv2.pointPolygonTest(np.asarray(poly, np.float32), (float(pt[0]), float(pt[1])), False) >= 0


def side_of_line(pt, a, b):
    return np.sign((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]))


def denorm(points, w, h):
    """Config geometry is normalized (0..1); convert to pixel coords."""
    return [(float(x) * w, float(y) * h) for x, y in points]


class Module:
    name = "base"
    needs_pose = False
    needs_detection = True

    def __init__(self, cfg, ctx):
        self.cfg, self.ctx = cfg or {}, ctx
        self.schedule = self.cfg.get("active_hours", "")
        self.counts = {}

    def active(self):
        return in_schedule(self.schedule)

    def count(self, key, n=1):
        self.counts[key] = self.counts.get(key, 0) + n

    def on_lores(self, gray, mask, area, ts):
        """Called every lores frame (cheap). Return list of Events."""
        return []

    def process(self, f: Frame):
        """Called on every detection tick with a full-res frame. Return list of Events."""
        return []

    def draw(self, img):
        pass

    def summary(self):
        return dict(self.counts)

    def reset_day(self):
        self.counts = {}


def put_label(img, text, org, color, scale=0.8):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 4)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)


def now_str(ts=None):
    return datetime.fromtimestamp(ts or time.time()).strftime("%Y-%m-%d %H:%M:%S")
