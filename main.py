#!/usr/bin/env python3
"""Pi Motion Cam — modular smart camera for Raspberry Pi 5.

lores stream -> motion + cheap scene modules (tamper) every frame
detection tick -> detector (HOG / MobileNet-SSD) -> tracker -> optional pose -> modules -> event bus (CSV, snapshot, Telegram)
"""
import argparse
import logging
import os
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import yaml

from modules import load_modules
from modules.base import Frame, Module, put_label
from modules.detectors import make_detector, night_enhance
from modules.events import DailySummary, EventBus
from modules.pose import make_pose
from modules.tracker import Tracker

BASE = Path(__file__).resolve().parent
log = logging.getLogger("motioncam")
COLORS = {"person": (0, 255, 0)}


def load_config(path=BASE / "config.yaml"):
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
    tg = cfg.setdefault("events", {}).setdefault("telegram", {})
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


def annotate(img, dets, modules):
    for d in dets:
        x, y, w, h = d.box
        c = COLORS.get(d.cls, (0, 200, 255))
        cv2.rectangle(img, (x, y), (x + w, y + h), c, 3)
        put_label(img, f"{d.cls} #{d.track_id} {d.conf:.2f}", (x, max(30, y - 10)), c, 0.7)
    for m in modules:
        m.draw(img)
    put_label(img, time.strftime("%Y-%m-%d %H:%M:%S"), (20, img.shape[0] - 20), (255, 255, 255), 0.9)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--summary", action="store_true", help="print today's summary JSON and exit")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()
    cam_c, mot_c, det_c = cfg.get("camera", {}), cfg.get("motion", {}), cfg.get("detector", {})
    ctx = SimpleNamespace(base=BASE, min_motion_area=mot_c.get("min_area", 800))
    modules = load_modules(cfg.get("modules", {}), ctx)
    bus = EventBus(cfg.get("events", {}), BASE, cfg.get("modules", {}) or {})
    summary = DailySummary(cfg.get("summary", {}), BASE, bus)
    if args.summary:
        import json
        print(json.dumps(summary.build(modules), indent=2))
        return
    if not modules:
        log.warning("No modules enabled in config.yaml (modules: ...). Only motion will be computed.")

    from picamera2 import Picamera2
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
    det_modules = [m for m in modules if type(m).process is not Module.process]  # modules that need full frames
    detector = make_detector(det_c, BASE) if any(m.needs_detection for m in det_modules) else None
    pose = make_pose(cfg.get("pose", {}), BASE) if any(m.needs_pose for m in modules) else None
    tracker = Tracker(det_c.get("track_lost_seconds", 2.0))
    active_iv, idle_iv = det_c.get("interval_seconds", 0.3), det_c.get("idle_interval_seconds", 2.0)
    conf_thr, night_c = det_c.get("confidence", 0.4), det_c.get("night", {})
    last_det, was_active = 0.0, False
    log.info("Running with %d module(s); detector=%s pose=%s", len(modules),
             type(detector).__name__ if detector else None, bool(pose))

    try:
        while True:
            yuv = picam.capture_array("lores")
            gray = yuv[:lh, :lw]
            ts = time.time()
            moved, area, mask = motion.update(gray)
            lores_events = []
            for m in modules:
                lores_events += m.on_lores(gray, mask, area, ts)
            summary.tick(modules)
            interval = active_iv if (moved or was_active) else idle_iv
            if ts - last_det < interval:
                if lores_events:
                    frame = np.ascontiguousarray(picam.capture_array("main"))
                    bus.emit(lores_events, annotate(frame, [], modules))
                continue
            last_det = ts
            frame = np.ascontiguousarray(picam.capture_array("main"))  # RGB888 is BGR-ordered -> OpenCV-ready
            dark = float(gray.mean()) < night_c.get("dark_brightness", 50)
            det_img = night_enhance(frame) if (dark and night_c.get("enhance", True)) else frame
            thr = conf_thr * night_c.get("confidence_scale", 0.75) if dark else conf_thr
            dets = detector.detect(det_img, thr) if detector else []
            tracks = tracker.update(dets, ts, frame.shape[1])
            was_active = bool(dets)
            if pose:
                for t in sorted((t for t in tracks.values() if t.cls == "person"), key=lambda t: -t.box[2] * t.box[3])[:pose.max_people]:
                    t.pose = pose.estimate(frame, t.box)
                    if t.pose:
                        t.pose_hist.append((ts, t.pose))
            f = Frame(ts, frame, gray, mask, area if moved else 0, dets, tracks, (lw, lh))
            events = list(lores_events)
            for m in det_modules:
                try:
                    events += m.process(f)
                except Exception:
                    log.exception("Module %s crashed on a frame", m.name)
            if events:
                bus.emit(events, annotate(frame.copy(), dets, modules))
            if moved and events:
                motion.prev = None
    except KeyboardInterrupt:
        log.info("Stopping")
    finally:
        summary.write(modules)
        picam.stop()


if __name__ == "__main__":
    main()
