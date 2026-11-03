"""Module 14: vehicles & number plates — plate region search (OpenCV) + OCR (pytesseract, ./install.sh --ocr).

Each new vehicle track is OCR'd up to `tries` times (retrying on later frames) until a confident Indian-format plate is read.
IN = first confident read (or crossing `line` in the IN direction); OUT = line crossing the other way, or not seen for out_after_minutes.
Log: plates/YYYY-MM-DD.csv (plate, direction, time, confidence, snapshot). Watchlist plates raise an alert.
"""
import csv
import logging
import re
import time
from datetime import datetime

import cv2
import numpy as np

from .base import Module, Event, side_of_line, denorm, put_label

log = logging.getLogger("motioncam")
STATES = set("AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB".split())
L2D = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8", "G": "6", "T": "7"}
D2L = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "7": "T", "4": "A"}


def _coerce(s, shape):
    out = []
    for c, want in zip(s, shape):
        if want == "D":
            c = c if c.isdigit() else L2D.get(c)
        else:
            c = c if c.isalpha() else D2L.get(c)
        if c is None:
            return None
        out.append(c)
    return "".join(out)


CONFUSE = {"N": "WMH", "W": "NMV", "M": "NWH", "H": "NM", "U": "VW", "V": "UW", "K": "X", "X": "K", "O": "D", "D": "O",
           "R": "P", "P": "R", "T": "J", "J": "T", "C": "G", "G": "C", "L": "I", "I": "L"}


def fix_state(v):
    """Repair one confusable letter in the 2-letter state code (e.g. NB -> WB)."""
    if v[:2] in STATES:
        return v
    for i in range(2):
        for r in CONFUSE.get(v[i], ""):
            t = (r + v[1:]) if i == 0 else (v[0] + r + v[2:])
            if t[:2] in STATES:
                return t
    return None


def normalize(raw):
    """Clean OCR text to A-Z0-9 and fit the Indian format (e.g. MH12AB1234, DL3CAF1234, 22BH1234AA).
    Returns (plate, is_indian) or None."""
    s = re.sub(r"[^A-Z0-9]", "", (raw or "").upper())
    if len(s) < 4:
        return None
    for n in range(min(11, len(s)), 7, -1):
        for st in range(0, len(s) - n + 1):
            sub = s[st:st + n]
            for dl in (2, 1):  # district codes are usually 2 digits -> try first
                ll = n - 2 - dl - 4
                if 0 <= ll <= 3:
                    v = _coerce(sub, "LL" + "D" * dl + "L" * ll + "DDDD")
                    v = v and fix_state(v)
                    if v:
                        return v, True
            if 9 <= n <= 10:
                v = _coerce(sub, "DDLLDDDD" + "L" * (n - 8))
                if v and v[2:4] == "BH":
                    return v, True
    return (s, False) if 5 <= len(s) <= 10 else None


def plate_candidates(bgr, max_n=3):
    """Find plate-like regions: strong vertical edges closed horizontally into wide rectangles."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    gx = cv2.convertScaleAbs(cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3))
    _, th = cv2.threshold(gx, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, w // 25), max(3, h // 60)))
    closed = cv2.morphologyEx(th, cv2.MORPH_CLOSE, k)
    closed = cv2.morphologyEx(closed, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        ar = cw / max(1, ch)
        if 1.5 <= ar <= 7 and 0.12 * w <= cw <= 0.8 * w and ch >= 10:
            fill = cv2.countNonZero(th[y:y + ch, x:x + cw]) / float(cw * ch)
            out.append((fill * min(ar, 5), (x, y, cw, ch)))
    return [r for _, r in sorted(out, reverse=True)[:max_n]]


class PlateModule(Module):
    name = "plates"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        import pytesseract  # optional: ./install.sh --ocr
        self.tess = pytesseract
        self.tess_cfg = "--oem 1 --psm 7 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        self.classes = set(cfg.get("classes", ["car", "truck", "bus", "motorbike", "motorcycle"]))
        self.tries = cfg.get("tries", 4)
        self.min_conf = cfg.get("min_confidence", 55)
        self.indian_only = cfg.get("indian_only", False)
        self.out_after = cfg.get("out_after_minutes", 2) * 60
        self.line = cfg.get("line")
        self.watch = {w.upper() for w in cfg.get("watchlist", []) or []}
        self.dir = ctx.base / cfg.get("dir", "plates")
        self.dir.mkdir(parents=True, exist_ok=True)
        self.plates = {}   # plate -> {inside, in, out, last, visits, conf}
        self.min_interval, self.last_ocr = cfg.get("min_interval_seconds", 1.0), 0.0

    def _ocr(self, img):
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        scale = max(1.0, min(4.0, 90.0 / max(1, g.shape[0])))
        g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        g = cv2.copyMakeBorder(cv2.equalizeHist(g), 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
        d = self.tess.image_to_data(g, config=self.tess_cfg, output_type=self.tess.Output.DICT)
        words = [(t, float(c)) for t, c in zip(d["text"], d["conf"]) if t.strip() and float(c) >= 0]
        if not words:
            return None
        text = "".join(t for t, _ in words)
        conf = sum(c for _, c in words) / len(words)
        n = normalize(text)
        return (n[0], n[1], conf) if n else None

    def read(self, frame, box):
        x, y, w, h = [int(v) for v in box]
        H, W = frame.shape[:2]
        x0, y0 = max(0, x), max(0, y + int(h * 0.35))
        roi = frame[y0:min(H, y + h), x0:min(W, x + w)]
        if roi.size == 0:
            return None
        best = None
        for (cx, cy, cw, ch) in plate_candidates(roi) + [(0, 0, roi.shape[1], roi.shape[0])]:
            r = self._ocr(roi[cy:cy + ch, cx:cx + cw])
            if r and (best is None or (r[1], r[2]) > (best[1], best[2])):
                best = r + ((x0 + cx, y0 + cy, cw, ch),)
            if best and best[1] and best[2] > 75:
                break
        return best

    def _log(self, plate, direction, conf, ts):
        p = self.dir / f"{datetime.fromtimestamp(ts):%Y-%m-%d}.csv"
        new = not p.exists()
        with open(p, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["plate", "direction", "time", "confidence"])
            w.writerow([plate, direction, datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"), round(conf)])

    def _mark(self, plate, d, conf, ts, t, events):
        p = self.plates.setdefault(plate, {"inside": False, "visits": 0, "conf": 0})
        p["last"], p["conf"] = ts, max(p["conf"], conf)
        if d == "in" and not p["inside"]:
            p.update(inside=True, visits=p["visits"] + 1)
        elif d == "out" and p["inside"]:
            p["inside"] = False
        else:
            return
        self.count(d)
        self._log(plate, d.upper(), conf, ts)
        hit = plate in self.watch
        events.append(Event(self.name, d, f"{'WATCHLIST ' if hit else ''}{t.cls if t else 'vehicle'} {plate} {d.upper()} (conf {conf:.0f})",
                            "alert" if hit else "info", t.id if t else None))

    def process(self, f):
        ev = []
        W, H = f.size
        vehicles = [t for t in f.tracks.values() if t.cls in self.classes]
        for t in vehicles:
            st = t.flags.setdefault("plate", {"tries": 0, "best": None, "counted": False, "side": None, "dir": None})
            if not st["counted"]:
                st["counted"] = True
                self.count("vehicles")
            if self.line:
                a, b = denorm(self.line, W, H)
                s = side_of_line(t.centroid, a, b)
                if st["side"] and s and s != st["side"]:
                    st["dir"] = "in" if s < 0 else "out"
                    if st["best"]:
                        self._mark(st["best"][0], st["dir"], st["best"][2], f.ts, t, ev)
                if s:
                    st["side"] = s
        todo = [t for t in vehicles if t.flags["plate"]["tries"] < self.tries
                and not (t.flags["plate"]["best"] and t.flags["plate"]["best"][1] and t.flags["plate"]["best"][2] > 80)]
        if todo and f.ts - self.last_ocr >= self.min_interval:
            self.last_ocr = f.ts
            t = max(todo, key=lambda t: t.box[2] * t.box[3])
            st = t.flags["plate"]
            st["tries"] += 1
            r = self.read(f.image, t.box)
            if r and r[2] >= self.min_conf and (r[1] or not self.indian_only):
                if st["best"] is None or (r[1], r[2]) > (st["best"][1], st["best"][2]):
                    first = st["best"] is None
                    st["best"] = r
                    t.flags["plate_text"] = r[0]
                    if first:
                        self._mark(r[0], st["dir"] or "in", r[2], f.ts, t, ev)
        if not self.line:
            for plate, p in self.plates.items():
                if p["inside"] and f.ts - p["last"] > self.out_after:
                    self._mark(plate, "out", p["conf"], f.ts, None, ev)
        return ev

    def draw(self, img):
        h, w = img.shape[:2]
        if self.line:
            a, b = [tuple(map(int, p)) for p in denorm(self.line, w, h)]
            cv2.line(img, a, b, (255, 200, 0), 3)

    def summary(self):
        return {**self.counts, "inside_now": sum(1 for p in self.plates.values() if p["inside"]),
                "unique_plates": len(self.plates)}
