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


def _edge_candidates(gray):
    h, w = gray.shape
    gx = cv2.convertScaleAbs(cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3))
    _, th = cv2.threshold(gx, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, w // 25), max(3, h // 60)))
    closed = cv2.morphologyEx(th, cv2.MORPH_CLOSE, k)
    closed = cv2.morphologyEx(closed, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return th, cnts


def _color_candidates(bgr):
    """White and yellow (commercial) plate backgrounds: bright low-saturation or yellow-hue blobs."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 150), (180, 60, 255))
    yellow = cv2.inRange(hsv, (15, 80, 110), (40, 255, 255))
    out = []
    for m in (white, yellow):
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)))
        out += cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    return out


def plate_candidates(bgr, max_n=4):
    """Plate-like regions: vertical-edge blobs + white/yellow color blobs, filtered by aspect ratio
    (1-line plates ~2.5-6, 2-line plates ~1.2-2.2), size, and edge density inside."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    th, cnts = _edge_candidates(gray)
    cnts = list(cnts) + list(_color_candidates(bgr))
    out = []
    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        ar = cw / max(1, ch)
        if 1.2 <= ar <= 7 and 0.08 * w <= cw <= 0.8 * w and ch >= 8:
            fill = cv2.countNonZero(th[y:y + ch, x:x + cw]) / float(cw * ch)
            if fill < 0.08:      # plain paint / sky: no characters inside
                continue
            out.append((fill * min(ar, 5), (x, y, cw, ch)))
    res = []
    for _, r in sorted(out, reverse=True):   # drop near-duplicates
        if all(abs(r[0] - q[0]) + abs(r[1] - q[1]) > 0.3 * r[2] for q in res):
            res.append(r)
        if len(res) >= max_n:
            break
    return res


class OnnxPlates:
    """Optional open-source models (MIT): YOLOv9-t plate detector (open-image-models) and
    fast-plate-ocr CCT OCR. Install: ./install.sh --alpr  (pip: onnxruntime open-image-models fast-plate-ocr)."""

    def __init__(self, detector, ocr):
        self.det = self.rec = None
        if detector:
            from open_image_models import LicensePlateDetector
            self.det = LicensePlateDetector(detection_model="yolo-v9-t-384-license-plate-end2end")
        if ocr:
            from fast_plate_ocr import LicensePlateRecognizer
            self.rec = LicensePlateRecognizer("cct-xs-v1-global-model")

    def detect(self, bgr, conf=0.35):
        return [(b.bounding_box.x1, b.bounding_box.y1, b.bounding_box.x2 - b.bounding_box.x1, b.bounding_box.y2 - b.bounding_box.y1, r.confidence)
                for r in self.det.predict(bgr) for b in [r] if r.confidence >= conf]

    def ocr(self, crop):
        p = self.rec.run(crop, return_confidence=True)[0]
        conf = float(np.mean(p.char_probs)) * 100 if getattr(p, "char_probs", None) is not None and len(p.char_probs) else 50.0
        n = normalize(p.plate)
        return (n[0], n[1], conf) if n else None


class PlateModule(Module):
    name = "plates"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.engine = cfg.get("ocr_engine", "tesseract")          # tesseract | fast_plate_ocr
        self.use_det = cfg.get("plate_detector", "classic") == "onnx"
        self.onnx = OnnxPlates(self.use_det, self.engine == "fast_plate_ocr") if (self.use_det or self.engine == "fast_plate_ocr") else None
        if self.engine == "tesseract":
            import pytesseract  # optional: ./install.sh --ocr
            self.tess = pytesseract
        self.wl = "-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        self.classes = set(cfg.get("classes", ["car", "truck", "bus", "motorbike", "motorcycle"]))
        self.tries = cfg.get("tries", 8)
        self.min_conf = cfg.get("min_confidence", 40)
        self.indian_only = cfg.get("indian_only", False)
        self.char_h = cfg.get("char_height", 32)            # upscale crops so characters are ~this many px tall
        self.min_plate_w = cfg.get("min_plate_width", 60)  # px in the main frame (onnx detector)
        self.votes_needed = cfg.get("votes", 2)             # same text read this many times on one track -> accept
        self.out_after = cfg.get("out_after_minutes", 2) * 60
        self.line = cfg.get("line")
        self.watch = {w.upper() for w in cfg.get("watchlist", []) or []}
        self.dir = ctx.base / cfg.get("dir", "plates")
        self.dir.mkdir(parents=True, exist_ok=True)
        self.plates = {}   # plate -> {inside, in, out, last, visits, conf}
        self.pending = {}  # track id -> (state, track) with votes not yet logged
        self.ghosts = {}   # plate-detector hits with no vehicle track: key -> state
        self.min_interval, self.last_ocr = cfg.get("min_interval_seconds", 1.0), 0.0

    def _tess(self, g, psm):
        d = self.tess.image_to_data(g, config=f"--oem 1 --psm {psm} {self.wl}", output_type=self.tess.Output.DICT)
        words = [(t, float(c)) for t, c in zip(d["text"], d["conf"]) if t.strip()]
        if not words:
            return None
        return "".join(t for t, _ in words), sum(max(0.0, c) for _, c in words) / len(words)

    def _ocr(self, img):
        if self.engine == "fast_plate_ocr":
            return self.onnx.ocr(img)
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = g.shape
        two_line = w / max(1, h) < 2.3
        # characters fill ~70% of a 1-line plate, ~40% of each line of a 2-line plate
        scale = max(1.0, min(6.0, self.char_h / max(1.0, h * (0.38 if two_line else 0.7))))
        g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        g = cv2.createCLAHE(2.0, (8, 8)).apply(g)
        pad = lambda im: cv2.copyMakeBorder(im, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
        reads = []
        if two_line:   # 2-line plate (bikes, trucks): OCR top and bottom halves separately, join
            H2 = g.shape[0] // 2
            top, bot = self._tess(pad(g[:H2 + 2]), 7), self._tess(pad(g[H2 - 2:]), 7)
            if top and bot:
                reads.append((top[0] + bot[0], (top[1] + bot[1]) / 2))
            r = self._tess(pad(g), 6)
            r and reads.append(r)
        r = self._tess(pad(g), 7)
        r and reads.append(r)
        if not reads:
            _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
            r = self._tess(pad(b), 7)
            r and reads.append(r)
        best = None
        for text, conf in reads:
            n = normalize(text)
            if n and (best is None or (n[1], conf) > (best[1], best[2])):
                best = (n[0], n[1], conf)
        return best

    def read(self, frame, box):
        x, y, w, h = [int(v) for v in box]
        H, W = frame.shape[:2]
        x0, y0 = max(0, x), max(0, y + int(h * 0.3))
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

    def _accept(self, r):
        """Indian-format reads are kept even at low/zero Tesseract confidence (the regex is the real check)."""
        return bool(r) and (r[1] or (r[2] >= self.min_conf and not self.indian_only))

    def _vote(self, st, r, ts, t, ev):
        """Majority vote across frames of one track; emits once the winner has enough votes or tries run out."""
        v = st.setdefault("votes", {})
        e = v.setdefault(r[0], [0, 0.0, r[1]])
        e[0] += 1
        e[1] = max(e[1], r[2])
        win, (n, conf, ind) = max(v.items(), key=lambda kv: (kv[1][0], kv[1][2], kv[1][1]))
        st["best"] = (win, ind, conf)
        if t:
            t.flags["plate_text"] = win
        done = n >= self.votes_needed or st["tries"] >= self.tries or (ind and conf >= 85)
        if done and not st.get("emitted"):
            st["emitted"] = True
            self._mark(win, st["dir"] or "in", conf, ts, t, ev)

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
        todo = [t for t in vehicles if t.flags["plate"]["tries"] < self.tries and not t.flags["plate"].get("emitted")]
        if f.ts - self.last_ocr >= self.min_interval and (todo or self.use_det):
            self.last_ocr = f.ts
            if self.use_det:
                self._detector_pass(f, vehicles, ev)
            else:
                t = max(todo, key=lambda t: t.box[2] * t.box[3])
                st = t.flags["plate"]
                st["tries"] += 1
                r = self.read(f.image, t.box)
                if self._accept(r):
                    self._vote(st, r, f.ts, t, ev)
        for t in vehicles:   # tries used up: accept the vote winner so far
            st = t.flags["plate"]
            if st.get("votes") and not st.get("emitted"):
                self.pending[t.id] = (st, t)
                if st["tries"] >= self.tries:
                    self._flush(st, t, f.ts, ev)
        for tid in [k for k in self.pending if k not in f.tracks]:   # vehicle left before enough votes
            self._flush(*self.pending.pop(tid), f.ts, ev)
        if not self.line:
            for plate, p in self.plates.items():
                if p["inside"] and f.ts - p["last"] > self.out_after:
                    self._mark(plate, "out", p["conf"], f.ts, None, ev)
        return ev

    def _flush(self, st, t, ts, ev):
        if st.get("votes") and not st.get("emitted"):
            st["emitted"] = True
            self._mark(st["best"][0], st["dir"] or "in", st["best"][2], ts, t, ev)
        if t is not None:
            self.pending.pop(t.id, None)

    def _detector_pass(self, f, vehicles, ev):
        """ONNX plate detector on the whole frame: finds plates even when the vehicle detector misses
        the truck/bus. Each plate is tied to the vehicle track containing it, else to a 'ghost' track."""
        img = f.image
        for (px, py, pw, ph, _) in self.onnx.detect(img)[:4]:
            if pw < self.min_plate_w:   # too small to read reliably -> skip instead of logging junk
                continue
            cx, cy = px + pw / 2, py + ph / 2
            t = next((t for t in vehicles if t.box[0] <= cx <= t.box[0] + t.box[2] and t.box[1] <= cy <= t.box[1] + t.box[3]), None)
            if t:
                st = t.flags["plate"]
            else:
                key = min(self.ghosts, key=lambda k: abs(k[0] - cx) + abs(k[1] - cy), default=None)
                if key is None or abs(key[0] - cx) + abs(key[1] - cy) > 3 * pw or f.ts - self.ghosts[key]["seen"] > 5:
                    key = (cx, cy)
                    self.ghosts[key] = {"tries": 0, "best": None, "dir": None, "seen": f.ts}
                    self.count("vehicles")
                st = self.ghosts.pop(key)
                st["seen"] = f.ts
                self.ghosts[(cx, cy)] = st
            if st.get("emitted") or st["tries"] >= self.tries:
                continue
            st["tries"] += 1
            m = int(0.08 * pw)
            crop = img[max(0, py - m):py + ph + m, max(0, px - m):px + pw + m]
            r = self._ocr(crop) if crop.size else None
            if self._accept(r):
                self._vote(st, r, f.ts, t, ev)
        for k in [k for k, v in self.ghosts.items() if f.ts - v["seen"] >= 5]:
            self._flush(self.ghosts.pop(k), None, f.ts, ev)

    def draw(self, img):
        h, w = img.shape[:2]
        if self.line:
            a, b = [tuple(map(int, p)) for p in denorm(self.line, w, h)]
            cv2.line(img, a, b, (255, 200, 0), 3)

    def summary(self):
        return {**self.counts, "inside_now": sum(1 for p in self.plates.values() if p["inside"]),
                "unique_plates": len(self.plates)}
