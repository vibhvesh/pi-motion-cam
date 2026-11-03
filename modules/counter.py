"""Module 2: People in/out counter — tracked centroids crossing a virtual line (multi-person, per-track IDs)."""
import cv2

from .base import Module, Event, side_of_line, denorm, put_label


class CounterModule(Module):
    name = "counter"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.line = cfg.get("line", [[0.5, 0.0], [0.5, 1.0]])          # two normalized points
        self.in_side = cfg.get("in_side", "negative")  # side a track ends on to count as IN (default vertical line: negative = left->right)
        self.classes = set(cfg.get("classes", ["person"]))
        self.totals = {"IN": 0, "OUT": 0}

    def process(self, f):
        w, h = f.size
        a, b = denorm(self.line, w, h)
        events = []
        for t in f.tracks.values():
            if t.cls not in self.classes:
                continue
            s = side_of_line(t.centroid, a, b)
            prev = t.flags.get("counter_side")
            if s != 0:
                t.flags["counter_side"] = s
            if prev and s and s != prev:
                d = "IN" if (s > 0) == (self.in_side == "positive") else "OUT"
                self.totals[d] += 1
                self.count(d)
                events.append(Event(self.name, d.lower(), f"{t.cls} #{t.id} {d} (IN {self.totals['IN']} / OUT {self.totals['OUT']})",
                                    "info", t.id))
        return events

    def draw(self, img):
        h, w = img.shape[:2]
        a, b = [tuple(map(int, p)) for p in denorm(self.line, w, h)]
        cv2.line(img, a, b, (0, 255, 255), 3)
        put_label(img, f"IN {self.totals['IN']}  OUT {self.totals['OUT']}", (20, 50), (0, 255, 255), 1.2)

    def summary(self):
        return {"in": self.totals["IN"], "out": self.totals["OUT"], "inside_estimate": max(0, self.totals["IN"] - self.totals["OUT"])}

    def reset_day(self):
        super().reset_day()
        self.totals = {"IN": 0, "OUT": 0}
