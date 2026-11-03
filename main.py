#!/usr/bin/env python3
"""Pi 5 motion camera: motion -> person detection -> (face recognition) -> Telegram photo alert."""
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import requests
import yaml

from attendance import Attendance, LineCounter

BASE = Path(__file__).resolve().parent
log = logging.getLogger("motioncam")


def load_config(path=BASE / "config.yaml"):
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
    tg = cfg.setdefault("telegram", {})
    tg["bot_token"] = os.environ.get("TELEGRAM_BOT_TOKEN") or tg.get("bot_token", "")
    tg["chat_id"] = os.environ.get("TELEGRAM_CHAT_ID") or tg.get("chat_id", "")
    return cfg


class MotionDetector:
    def __init__(self, c):
        self.thr = c.get("pixel_threshold", 25)
        self.min_area = c.get("min_area", 800)
        b = int(c.get("blur", 21))
        self.blur = b if b % 2 else b + 1
        self.prev = None

    def update(self, gray):
        g = cv2.GaussianBlur(gray, (self.blur, self.blur), 0)
        if self.prev is None:
            self.prev = g
            return False, 0, None
        diff = cv2.absdiff(self.prev, g)
        self.prev = g
        _, mask = cv2.threshold(diff, self.thr, 255, cv2.THRESH_BINARY)
        mask = cv2.dilate(mask, None, iterations=2)
        changed = int(cv2.countNonZero(mask))
        return changed >= self.min_area, changed, mask


class PersonDetector:
    def __init__(self, c):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        self.stride = tuple(c.get("win_stride", [8, 8]))
        self.scale = c.get("scale", 1.05)
        self.width = c.get("detect_width", 640)

    def detect(self, bgr):
        h, w = bgr.shape[:2]
        r = self.width / float(w) if w > self.width else 1.0
        small = cv2.resize(bgr, (int(w * r), int(h * r))) if r != 1.0 else bgr
        rects, _ = self.hog.detectMultiScale(small, winStride=self.stride, padding=(8, 8), scale=self.scale)
        return [(int(x / r), int(y / r), int(bw / r), int(bh / r)) for (x, y, bw, bh) in rects]


class FaceRecognizer:
    def __init__(self, c):
        import face_recognition  # optional dependency
        self.fr = face_recognition
        self.tol = c.get("tolerance", 0.6)
        self.dir = BASE / c.get("known_faces_dir", "known_faces")
        self.unknown_dir = BASE / c.get("unknown_faces_dir", "unknown_faces")
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


def send_telegram(cfg, path, caption):
    token, chat = cfg.get("bot_token"), cfg.get("chat_id")
    if not cfg.get("enabled", True) or not token or not chat:
        log.warning("Telegram disabled or not configured; skipping alert")
        return
    try:
        with open(path, "rb") as f:
            r = requests.post(f"https://api.telegram.org/bot{token}/sendPhoto",
                              data={"chat_id": chat, "caption": caption[:1024]},
                              files={"photo": f}, timeout=30)
        if r.ok:
            log.info("Telegram alert sent")
        else:
            log.error("Telegram error %s: %s", r.status_code, r.text[:200])
    except requests.RequestException as e:
        log.error("Telegram send failed: %s", e)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()
    from picamera2 import Picamera2

    cam_c, mot_c = cfg.get("camera", {}), cfg.get("motion", {})
    pd_c, fr_c = cfg.get("person_detection", {}), cfg.get("face_recognition", {})
    out_c = cfg.get("output", {})
    save_dir = BASE / out_c.get("save_dir", "captures")
    save_dir.mkdir(parents=True, exist_ok=True)

    picam = Picamera2()
    conf = picam.create_video_configuration(
        main={"size": tuple(cam_c.get("main_size", [2304, 1296])), "format": "RGB888"},
        lores={"size": tuple(cam_c.get("lores_size", [320, 240])), "format": "YUV420"},
        controls={"FrameRate": cam_c.get("framerate", 10)})
    picam.configure(conf)
    picam.start()
    time.sleep(mot_c.get("warmup_seconds", 2))
    lw, lh = conf["lores"]["size"]

    motion = MotionDetector(mot_c)
    person = PersonDetector(pd_c) if pd_c.get("enabled", True) else None
    faces = None
    if fr_c.get("enabled", False):
        try:
            faces = FaceRecognizer(fr_c)
        except ImportError:
            log.error("face_recognition not installed; face recognition disabled")
    att_c, dir_c = cfg.get("attendance", {}), cfg.get("direction", {})
    attendance = Attendance(att_c, BASE) if att_c.get("enabled", False) else None
    if attendance and not faces:
        log.warning("Attendance needs face_recognition enabled; it will log nothing")
    counter = LineCounter(dir_c, BASE, (lw, lh)) if dir_c.get("enabled", False) else None
    cooldown = mot_c.get("cooldown_seconds", 30)
    last_alert = 0.0
    log.info("Watching for motion...")

    try:
        while True:
            yuv = picam.capture_array("lores")
            gray = yuv[:lh, :lw]  # Y plane
            moved, area, mask = motion.update(gray)
            if counter and mask is not None:
                d = counter.update(mask)
                if d:
                    log.info("Line crossing: %s (IN=%d OUT=%d)", d, counter.count["IN"], counter.count["OUT"])
            if not moved or time.time() - last_alert < cooldown:
                continue
            log.info("Motion detected (%d px)", area)
            frame = picam.capture_array("main")  # RGB888 is BGR-ordered in memory -> OpenCV ready
            frame = np.ascontiguousarray(frame)
            people = person.detect(frame) if person else []
            if person and pd_c.get("require_person", True) and not people:
                log.info("No person found; ignoring")
                continue
            for (x, y, w, h) in people:
                cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 3)
                cv2.putText(frame, "Person", (x, max(30, y - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
            names, new_unknown = [], []
            ts = datetime.now()
            if faces:
                faces.reload_if_changed()  # picks up photos added/renamed in known_faces/
                for loc, name, enc in faces.recognize(frame):
                    if name == "Unknown":
                        up = faces.save_unknown(frame, loc, enc, ts)
                        if up:
                            new_unknown.append(up)
                    top, right, bottom, left = loc
                    names.append(name)
                    color = (0, 0, 255) if name == "Unknown" else (255, 128, 0)
                    cv2.rectangle(frame, (left, top), (right, bottom), color, 3)
                    cv2.putText(frame, name, (left, max(30, top - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, color, 2)
            if counter:
                counter.draw(frame)
            path = save_dir / f"motion_{ts:%Y%m%d_%H%M%S}.jpg"
            cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, out_c.get("jpeg_quality", 90)])
            log.info("Saved %s", path)
            caption = f"Motion at {ts:%Y-%m-%d %H:%M:%S}\nPeople: {len(people)}"
            if names:
                caption += "\nFaces: " + ", ".join(names)
            if new_unknown:
                caption += f"\nUnknown person — please label in admin panel ({len(new_unknown)} new in unknown_faces/)"
            if counter:
                d = counter.recent(dir_c.get("alert_window_seconds", 10))
                caption += f"\nDirection: {d or 'n/a'} (IN {counter.count['IN']} / OUT {counter.count['OUT']})"
            if attendance:
                attendance.seen(names, path)
            send_telegram(cfg.get("telegram", {}), path, caption)
            last_alert = time.time()
            motion.prev = None  # reset background after capture
    except KeyboardInterrupt:
        log.info("Stopping")
    finally:
        picam.stop()


if __name__ == "__main__":
    sys.exit(main())
