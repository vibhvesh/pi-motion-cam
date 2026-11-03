"""Attendance log + virtual-line direction counter."""
import csv
import time
from datetime import datetime
from pathlib import Path

import cv2


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


class LineCounter:
    """Tracks the largest moving blob centroid on the lores motion mask and counts line crossings."""

    def __init__(self, c, base, size):
        self.w, self.h = size
        self.orient = c.get("orientation", "vertical")  # vertical line: left/right; horizontal: top/bottom
        frac = c.get("position", 0.5)
        self.pos = int((self.w if self.orient == "vertical" else self.h) * frac)
        self.in_dir = c.get("in_direction", "left_to_right")  # or right_to_left / top_to_bottom / bottom_to_top
        self.min_area = c.get("min_blob_area", 300)
        self.max_jump = c.get("max_jump_px", 80)
        self.events = base / c.get("events_file", "events.csv")
        self.prev = None
        self.count = {"IN": 0, "OUT": 0}
        self.last_event = None  # (direction, timestamp)

    def update(self, mask):
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnts = [c for c in cnts if cv2.contourArea(c) >= self.min_area]
        if not cnts:
            self.prev = None
            return None
        m = cv2.moments(max(cnts, key=cv2.contourArea))
        if m["m00"] == 0:
            return None
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        cur, self.prev, prev = (cx, cy), (cx, cy), self.prev
        if prev is None or abs(cx - prev[0]) + abs(cy - prev[1]) > self.max_jump:
            return None
        a, b = (prev[0], cx) if self.orient == "vertical" else (prev[1], cy)
        if a < self.pos <= b:
            move = "left_to_right" if self.orient == "vertical" else "top_to_bottom"
        elif b < self.pos <= a:
            move = "right_to_left" if self.orient == "vertical" else "bottom_to_top"
        else:
            return None
        d = "IN" if move == self.in_dir else "OUT"
        self.count[d] += 1
        self.last_event = (d, time.time())
        new = not self.events.exists()
        with open(self.events, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["timestamp", "direction", "movement", "total_in", "total_out"])
            w.writerow([datetime.now().strftime("%Y-%m-%d %H:%M:%S"), d, move, self.count["IN"], self.count["OUT"]])
        return d

    def recent(self, window=10):
        if self.last_event and time.time() - self.last_event[1] <= window:
            return self.last_event[0]
        return None

    def draw(self, frame):
        h, w = frame.shape[:2]
        if self.orient == "vertical":
            x = int(self.pos * w / self.w)
            cv2.line(frame, (x, 0), (x, h), (0, 255, 255), 2)
        else:
            y = int(self.pos * h / self.h)
            cv2.line(frame, (0, y), (w, y), (0, 255, 255), 2)
        cv2.putText(frame, f"IN {self.count['IN']}  OUT {self.count['OUT']}", (20, 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 255, 255), 3)
