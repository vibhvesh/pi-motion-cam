"""Module 1: Attendance — face recognition, unknown-face queue (unknown_faces/), daily IN/OUT CSV."""
import csv
import logging
import re
import time
from datetime import datetime

import cv2
import numpy as np

from .base import Module, Event, PERSON, put_label

log = logging.getLogger("motioncam")
BASE = None  # set by module


class FaceRecognizer:
    def __init__(self, c, base):
        import face_recognition  # optional dependency
        self.fr = face_recognition
        self.tol = c.get("tolerance", 0.6)
        self.dir = base / c.get("known_faces_dir", "known_faces")
        self.unknown_dir = base / c.get("unknown_faces_dir", "unknown_faces")
        self.unknown_dir.mkdir(parents=True, exist_ok=True)
        self.unknown_encs = []  # recent unknown encodings, to avoid saving the same stranger repeatedly
        self._sig = None
        self.reload_if_changed(force=True)

    def _signature(self):
        return tuple(sorted((p.name, p.stat().st_mtime) for p in self.dir.glob("*")
                            if p.suffix.lower() in (".jpg", ".jpeg", ".png")))

    def reload_if_changed(self, force=False):
        self.dir.mkdir(parents=True, exist_ok=True)
        sig = self._signature()
        if not force and sig == self._sig:
            return
        self._sig = sig
        names, encs = [], []
        for name, _ in sig:
            p = self.dir / name
            e = self.fr.face_encodings(self.fr.load_image_file(str(p)))
            if e:
                names.append(re.sub(r"[_-]\d+$", "", p.stem))  # alice.jpg / alice_2.jpg -> alice
                encs.append(e[0])
            else:
                log.warning("No face found in %s", p)
        self.names, self.encs = names, encs
        self.unknown_encs = [u for u in self.unknown_encs
                             if not encs or min(self.fr.face_distance(encs, u)) > self.tol]
        log.info("Loaded %d known face photos (%d people)", len(names), len(set(names)))

    def recognize(self, bgr):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        locs = self.fr.face_locations(rgb)
        out = []
        for loc, enc in zip(locs, self.fr.face_encodings(rgb, locs)):
            name = "Unknown"
            if self.encs:
                dist = self.fr.face_distance(self.encs, enc)
                i = int(np.argmin(dist))
                if dist[i] <= self.tol:
                    name = self.names[i]
            out.append((loc, name, enc))
        return out

    def save_unknown(self, bgr, loc, enc, ts):
        """Save a crop of a new unknown face to unknown_faces/. Returns path, or None if seen recently."""
        if self.unknown_encs and min(self.fr.face_distance(self.unknown_encs, enc)) <= self.tol:
            return None
        self.unknown_encs = (self.unknown_encs + [enc])[-50:]
        top, right, bottom, left = loc
        pad = int((bottom - top) * 0.3)
        h, w = bgr.shape[:2]
        crop = bgr[max(0, top - pad):min(h, bottom + pad), max(0, left - pad):min(w, right + pad)]
        path = self.unknown_dir / f"unknown_{ts:%Y%m%d_%H%M%S}_{len(self.unknown_encs)}.jpg"
        cv2.imwrite(str(path), crop)
        log.info("New unknown face saved: %s (rename to name.jpg and move to known_faces/)", path)
        return path


class Attendance:
    """Logs recognized names to attendance/YYYY-MM-DD.csv (name, in_time, out_time, photo)."""
    FIELDS = ["name", "first_seen_in", "last_seen_out", "photo"]

    def __init__(self, c, base):
        self.dir = base / c.get("dir", "attendance")
        self.dir.mkdir(parents=True, exist_ok=True)
        self.gap = c.get("relog_gap_minutes", 30) * 60
        self.day, self.rows, self.last = None, [], {}

    def _load(self, day):
        self.day, self.rows, self.last = day, [], {}
        p = self.dir / f"{day}.csv"
        if p.exists():
            with open(p) as f:
                self.rows = list(csv.DictReader(f))
            for i, r in enumerate(self.rows):
                t = datetime.strptime(f"{day} {r['last_seen_out']}", "%Y-%m-%d %H:%M:%S").timestamp()
                self.last[r["name"]] = (i, t)

    def _save(self):
        with open(self.dir / f"{self.day}.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=self.FIELDS)
            w.writeheader()
            w.writerows(self.rows)

    def seen(self, names, photo):
        now = datetime.now()
        day = now.strftime("%Y-%m-%d")
        if day != self.day:
            self._load(day)
        hms = now.strftime("%H:%M:%S")
        for name in set(names) - {"Unknown"}:
            prev = self.last.get(name)
            if prev and now.timestamp() - prev[1] <= self.gap:
                self.rows[prev[0]]["last_seen_out"] = hms  # same session: extend OUT time
                self.rows[prev[0]]["photo"] = str(photo)
                idx = prev[0]
            else:  # new session (first sighting or after re-log gap)
                self.rows.append({"name": name, "first_seen_in": hms, "last_seen_out": hms, "photo": str(photo)})
                idx = len(self.rows) - 1
            self.last[name] = (idx, now.timestamp())
        if names:
            self._save()




class AttendanceModule(Module):
    name = "attendance"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.faces = FaceRecognizer(cfg, ctx.base)  # raises ImportError if face_recognition missing
        self.log = Attendance(cfg, ctx.base)
        self.min_interval = cfg.get("min_interval_seconds", 1.0)
        self.last_run, self.last_names, self.drawn = 0.0, {}, []

    def process(self, f):
        people = [t for t in f.tracks.values() if t.cls == PERSON]
        if not people or f.ts - self.last_run < self.min_interval:
            return []
        self.last_run = f.ts
        self.faces.reload_if_changed()
        events, names, self.drawn = [], [], []
        ts = datetime.fromtimestamp(f.ts)
        for loc, name, enc in self.faces.recognize(f.image):
            names.append(name)
            self.drawn.append((loc, name))
            if name == "Unknown":
                p = self.faces.save_unknown(f.image, loc, enc, ts)
                if p:
                    self.count("unknown")
                    t, r, b, l = loc
                    events.append(Event(self.name, "unknown", f"Unknown person — please label in admin panel ({p.name})",
                                        "warning", image=f.image[max(0, t - 40):b + 40, max(0, l - 40):r + 40].copy()))
            else:
                last = self.last_names.get(name, 0)
                if f.ts - last > self.log.gap:
                    self.count("arrivals")
                    events.append(Event(self.name, "arrival", f"{name} arrived", "info"))
                self.last_names[name] = f.ts
        if names:
            self.log.seen(names, "")
        f.faces = self.drawn
        return events

    def draw(self, img):
        for (t, r, b, l), name in self.drawn:
            color = (0, 0, 255) if name == "Unknown" else (255, 128, 0)
            cv2.rectangle(img, (l, t), (r, b), color, 3)
            put_label(img, name, (l, max(30, t - 10)), color)

    def summary(self):
        d = dict(self.counts)
        d["people_today"] = len({r["name"] for r in self.log.rows}) if self.log.day else 0
        return d
