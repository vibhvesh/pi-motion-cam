"""Modules 9 & 11: camera tamper (covered / blurred / moved) and EXPERIMENTAL fire/smoke heuristics."""
from collections import deque

import cv2
import numpy as np

from .base import Module, Event


class TamperModule(Module):
    """Runs on the cheap lores stream every frame."""
    name = "tamper"
    needs_detection = False

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.dark = cfg.get("dark_threshold", 15)        # mean brightness below -> covered/dark
        self.flat = cfg.get("flat_std", 8)               # very uniform image -> covered
        self.blur = cfg.get("blur_threshold", 15)        # Laplacian variance below -> out of focus / smeared
        self.change = cfg.get("scene_change", 0.3)       # histogram correlation below -> camera moved
        self.hold = cfg.get("hold_seconds", 1.5)
        self.struct = cfg.get("structure_change", 0.35)  # thumbnail correlation below -> moved
        self.blur_ratio = cfg.get("blur_ratio", 0.25)    # sharpness below ratio x reference -> blurred
        self.ref, self.ref_ts, self.state = None, 0, {}
        self.ref_thumb, self.ref_lap = None, None

    def _check(self, key, bad, ts, msg):
        if not bad:
            self.state.pop(key, None)
            return []
        st = self.state.setdefault(key, {"since": ts, "alerted": False})
        if not st["alerted"] and ts - st["since"] >= self.hold:
            st["alerted"] = True
            self.count(key)
            return [Event(self.name, key, msg, "alert")]
        return []

    def on_lores(self, gray, mask, area, ts):
        mean, std = float(gray.mean()), float(gray.std())
        lap = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        hist = cv2.normalize(cv2.calcHist([gray], [0], None, [32], [0, 256]), None).flatten()
        thumb = cv2.resize(cv2.GaussianBlur(gray, (5, 5), 0), (32, 24), interpolation=cv2.INTER_AREA).astype(np.float32).ravel()
        thumb = (thumb - thumb.mean()) / (thumb.std() + 1e-6)
        if self.ref is None or (ts - self.ref_ts > 60 and not self.state):
            self.ref, self.ref_ts, self.ref_thumb, self.ref_lap = hist, ts, thumb, lap   # refresh while stable
        corr = float(cv2.compareHist(self.ref, hist, cv2.HISTCMP_CORREL))
        ncc = float(np.dot(thumb, self.ref_thumb) / thumb.size)   # layout similarity (catches pan/turn)
        covered = mean < self.dark or std < self.flat
        ev = self._check("covered", covered, ts, f"Camera covered or dark (brightness {mean:.0f}, contrast {std:.0f})")
        blurred = not covered and (lap < self.blur or (self.ref_lap and self.ref_lap > 4 * self.blur and lap < self.blur_ratio * self.ref_lap))
        ev += self._check("blurred", blurred, ts, f"Camera view blurred / smeared (sharpness {lap:.0f})")
        ev += self._check("moved", not covered and (corr < self.change or ncc < self.struct), ts,
                          f"Scene changed suddenly — camera moved? (similarity {min(corr, ncc):.2f})")
        if ev and any(e.type == "moved" for e in ev):
            self.ref, self.ref_ts, self.ref_thumb, self.ref_lap = hist, ts, thumb, lap
        return ev


class FireSmokeModule(Module):
    """EXPERIMENTAL color + flicker heuristic. Expect false positives (sunsets, red clothes, lamps)."""
    name = "fire_smoke"
    needs_detection = False

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.min_frac = cfg.get("min_fire_fraction", 0.005)
        self.flicker = cfg.get("flicker_threshold", 0.3)
        self.smoke_frac = cfg.get("min_smoke_fraction", 0.15)
        self.hold = cfg.get("hold_seconds", 4)
        self.hist = deque(maxlen=20)
        self.since, self.alerted, self.smoke_since, self.smoke_alerted = None, False, None, False
        self.prev_small = None

    def process(self, f):
        small = cv2.resize(f.image, (160, 90))
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        b, g, r = cv2.split(small.astype(np.int16))
        fire = ((r > 180) & (r > g) & (g > b) & (r - b > 60) & (hsv[..., 2] > 170)).astype(np.uint8)
        frac = float(fire.mean())
        self.hist.append(frac)
        flick = float(np.std(self.hist) / (np.mean(self.hist) + 1e-6)) if len(self.hist) > 5 else 0.0
        ev = []
        recent = float(np.mean(list(self.hist)[-6:]))
        if recent >= self.min_frac and flick >= self.flicker:
            self.since = self.since or f.ts
            if not self.alerted and f.ts - self.since >= self.hold:
                self.alerted = True
                self.count("fire")
                ev.append(Event(self.name, "fire", f"EXPERIMENTAL: possible fire ({recent * 100:.1f}% flame-colored, flicker {flick:.2f})", "alert"))
        else:
            self.since, self.alerted = None, False
        # smoke: grayish, low-saturation, low-sharpness area that is changing
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        smoke = (hsv[..., 1] < 40) & (hsv[..., 2] > 90) & (hsv[..., 2] < 220)
        moving = np.abs(gray.astype(np.int16) - self.prev_small) > 8 if self.prev_small is not None else np.zeros_like(smoke)
        self.prev_small = gray.astype(np.int16)
        sfrac = float((smoke & moving).mean())
        if sfrac >= self.smoke_frac:
            self.smoke_since = self.smoke_since or f.ts
            if not self.smoke_alerted and f.ts - self.smoke_since >= self.hold:
                self.smoke_alerted = True
                self.count("smoke")
                ev.append(Event(self.name, "smoke", f"EXPERIMENTAL: possible smoke ({sfrac * 100:.0f}% of view)", "warning"))
        else:
            self.smoke_since, self.smoke_alerted = None, False
        return ev
