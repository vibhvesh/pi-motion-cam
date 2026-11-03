"""Modules 3, 6, 7, 8, 10: restricted-zone intrusion, perimeter tripwire (farm), loitering, occupancy limit, after-hours."""
import cv2
import numpy as np

from .base import Module, Event, point_in_poly, side_of_line, denorm, put_label, PERSON, ANIMALS, VEHICLES


def _zones(cfg):
    """zones: [{name, points: [[x,y],...] normalized}]"""
    return cfg.get("zones", []) or []


def _draw_zones(img, zones, color, label=True):
    h, w = img.shape[:2]
    for z in zones:
        pts = np.array(denorm(z["points"], w, h), np.int32)
        cv2.polylines(img, [pts], True, color, 3)
        if label:
            put_label(img, z.get("name", "zone"), tuple(pts[0]), color)


class ZoneIntrusionModule(Module):
    """Alert when a tracked person's foot-point enters a restricted polygon (optionally only during active_hours)."""
    name = "zone_intrusion"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.zones, self.classes = _zones(cfg), set(cfg.get("classes", [PERSON]))

    def process(self, f):
        if not self.active():
            return []
        w, h = f.size
        ev = []
        for t in f.tracks.values():
            if t.cls not in self.classes:
                continue
            for z in self.zones:
                key = "zi_" + z.get("name", "zone")
                inside = point_in_poly(t.foot, denorm(z["points"], w, h))
                if inside and not t.flags.get(key):
                    self.count(z.get("name", "zone"))
                    ev.append(Event(self.name, "intrusion", f"{t.cls} #{t.id} entered restricted zone '{z.get('name', 'zone')}'", "alert", t.id))
                t.flags[key] = inside
        return ev

    def draw(self, img):
        _draw_zones(img, self.zones, (0, 0, 255))


class PerimeterModule(Module):
    """Farm/perimeter mode: selected classes (people + animals) crossing a tripwire or entering a zone."""
    name = "perimeter"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.classes = set(cfg.get("classes", [PERSON, "cow", "dog", "horse", "sheep"]))
        self.line = cfg.get("line")                       # tripwire [[x,y],[x,y]] or None
        self.direction = cfg.get("direction", "both")      # both | positive | negative
        self.zones = _zones(cfg)

    def process(self, f):
        if not self.active():
            return []
        w, h = f.size
        ev = []
        for t in f.tracks.values():
            if t.cls not in self.classes:
                continue
            if self.line:
                a, b = denorm(self.line, w, h)
                s, prev = side_of_line(t.foot, a, b), t.flags.get("pm_side")
                if s:
                    t.flags["pm_side"] = s
                if prev and s and s != prev and (self.direction == "both" or (s > 0) == (self.direction == "positive")):
                    self.count(t.cls)
                    ev.append(Event(self.name, "tripwire", f"Perimeter: {t.cls} #{t.id} crossed the line", "alert", t.id))
            for z in self.zones:
                key = "pm_" + z.get("name", "zone")
                inside = point_in_poly(t.foot, denorm(z["points"], w, h))
                if inside and not t.flags.get(key):
                    self.count(t.cls)
                    ev.append(Event(self.name, "zone", f"Perimeter: {t.cls} #{t.id} entered '{z.get('name', 'zone')}'", "alert", t.id))
                t.flags[key] = inside
        return ev

    def draw(self, img):
        h, w = img.shape[:2]
        if self.line:
            a, b = [tuple(map(int, p)) for p in denorm(self.line, w, h)]
            cv2.line(img, a, b, (0, 140, 255), 3)
        _draw_zones(img, self.zones, (0, 140, 255))


class LoiteringModule(Module):
    """Alert when a person stays inside a zone (or anywhere, if no zones) longer than max_seconds."""
    name = "loitering"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.zones, self.max_s = _zones(cfg), cfg.get("max_seconds", 60)

    def process(self, f):
        if not self.active():
            return []
        w, h = f.size
        ev = []
        for t in f.tracks.values():
            if t.cls != PERSON:
                continue
            inside = not self.zones or any(point_in_poly(t.foot, denorm(z["points"], w, h)) for z in self.zones)
            if not inside:
                t.flags.pop("loiter_since", None)
                continue
            since = t.flags.setdefault("loiter_since", f.ts)
            if f.ts - since >= self.max_s and not t.flags.get("loiter_alerted"):
                t.flags["loiter_alerted"] = True
                self.count("loiterers")
                ev.append(Event(self.name, "loitering", f"Person #{t.id} loitering for {int(f.ts - since)} s", "warning", t.id))
        return ev

    def draw(self, img):
        _draw_zones(img, self.zones, (255, 0, 255))


class OccupancyModule(Module):
    """Crowd / occupancy limit: alert when people in frame (or zone) exceed max_people for hold_seconds."""
    name = "occupancy"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.zones, self.max_p, self.hold = _zones(cfg), cfg.get("max_people", 5), cfg.get("hold_seconds", 5)
        self.over_since, self.alerted, self.peak, self.current = None, False, 0, 0

    def process(self, f):
        w, h = f.size
        n = sum(1 for t in f.tracks.values() if t.cls == PERSON and
                (not self.zones or any(point_in_poly(t.foot, denorm(z["points"], w, h)) for z in self.zones)))
        self.current, self.peak = n, max(self.peak, n)
        if n <= self.max_p:
            self.over_since, self.alerted = None, False
            return []
        self.over_since = self.over_since or f.ts
        if not self.alerted and f.ts - self.over_since >= self.hold:
            self.alerted = True
            self.count("over_limit")
            return [Event(self.name, "over_limit", f"Occupancy {n} exceeds limit {self.max_p}", "warning")]
        return []

    def draw(self, img):
        _draw_zones(img, self.zones, (255, 255, 0))
        put_label(img, f"Occupancy {self.current}/{self.max_p}", (20, 95), (255, 255, 0))

    def summary(self):
        return {**self.counts, "peak": self.peak}

    def reset_day(self):
        super().reset_day()
        self.peak = 0


class AnimalModule(Module):
    """Any animal class detected (needs detector.type: mobilenet_ssd). One event per track."""
    name = "animal"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.classes = set(cfg.get("classes", sorted(ANIMALS)))

    def process(self, f):
        if not self.active():
            return []
        ev = []
        for t in f.tracks.values():
            if t.cls in self.classes and not t.flags.get("animal_seen"):
                t.flags["animal_seen"] = True
                self.count(t.cls)
                ev.append(Event(self.name, "animal", f"Animal detected: {t.cls} #{t.id}", "warning", t.id))
        return ev


class AfterHoursModule(Module):
    """Night / after-hours activity: any person or vehicle while inside active_hours (e.g. '20:00-06:00')."""
    name = "after_hours"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.schedule = cfg.get("active_hours", "20:00-06:00")
        self.classes = set(cfg.get("classes", [PERSON] + sorted(VEHICLES)))

    def process(self, f):
        if not self.active():
            return []
        ev = []
        for t in f.tracks.values():
            if t.cls in self.classes and not t.flags.get("ah_seen"):
                t.flags["ah_seen"] = True
                self.count(t.cls)
                ev.append(Event(self.name, "activity", f"After-hours activity: {t.cls} #{t.id}", "alert", t.id))
        return ev
