"""Event bus: unified CSV log, annotated snapshots, Telegram alerts (per-module toggle + cooldown), daily summary."""
import csv
import json
import logging
import queue
import threading
import time
from datetime import datetime

import cv2
import requests

from .base import now_str

log = logging.getLogger("motioncam")


class Telegram:
    def __init__(self, cfg):
        self.token, self.chat = cfg.get("bot_token"), cfg.get("chat_id")
        self.enabled = cfg.get("enabled", True) and bool(self.token and self.chat)
        self.q = queue.Queue(maxsize=50)
        if self.enabled:
            threading.Thread(target=self._worker, daemon=True).start()
        else:
            log.warning("Telegram disabled or not configured")

    def send(self, caption, photo_path=None):
        if self.enabled:
            try:
                self.q.put_nowait((caption, photo_path))
            except queue.Full:
                log.warning("Telegram queue full; dropping alert")

    def _worker(self):
        while True:
            caption, path = self.q.get()
            base = f"https://api.telegram.org/bot{self.token}"
            try:
                if path:
                    with open(path, "rb") as f:
                        r = requests.post(f"{base}/sendPhoto", data={"chat_id": self.chat, "caption": caption[:1024]},
                                          files={"photo": f}, timeout=30)
                else:
                    r = requests.post(f"{base}/sendMessage", data={"chat_id": self.chat, "text": caption[:4000]}, timeout=30)
                if not r.ok:
                    log.error("Telegram error %s: %s", r.status_code, r.text[:200])
            except requests.RequestException as e:
                log.error("Telegram send failed: %s", e)


class EventBus:
    def __init__(self, cfg, base, module_cfgs):
        self.base = base
        self.dir = base / cfg.get("events_dir", "events")
        self.snap_dir = base / cfg.get("snapshot_dir", "captures")
        self.dir.mkdir(parents=True, exist_ok=True)
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.quality = cfg.get("jpeg_quality", 90)
        self.default_cooldown = cfg.get("default_cooldown_seconds", 30)
        self.module_cfgs = module_cfgs
        self.last_sent = {}
        self.telegram = Telegram(cfg.get("telegram", {}))

    def emit(self, events, frame=None):
        if not events:
            return
        ts = datetime.now()
        path = None
        if frame is not None:
            path = self.snap_dir / f"{ts:%Y%m%d_%H%M%S}_{events[0].module}.jpg"
            cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        csv_path = self.dir / f"{ts:%Y-%m-%d}.csv"
        new = not csv_path.exists()
        with open(csv_path, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["timestamp", "module", "type", "severity", "message", "track_id", "snapshot"])
            for e in events:
                w.writerow([ts.strftime("%Y-%m-%d %H:%M:%S"), e.module, e.type, e.severity, e.message, e.track_id or "", path or ""])
                log.info("[%s/%s] %s", e.module, e.type, e.message)
        for e in events:
            mc = self.module_cfgs.get(e.module, {})
            if not mc.get("telegram", True):
                continue
            key = (e.module, e.type)
            cd = mc.get("cooldown_seconds", self.default_cooldown)
            if time.time() - self.last_sent.get(key, 0) < cd:
                continue
            self.last_sent[key] = time.time()
            photo = path
            if e.image is not None and getattr(e.image, "size", 0):
                photo = self.snap_dir / f"{ts:%Y%m%d_%H%M%S}_{e.module}_crop.jpg"
                cv2.imwrite(str(photo), e.image)
            self.telegram.send(f"[{e.module}] {e.message}\n{now_str()}", photo)


class DailySummary:
    """Collects per-module counts; writes summaries/YYYY-MM-DD.json and sends a Telegram text at send_time."""

    def __init__(self, cfg, base, bus):
        self.enabled = cfg.get("enabled", True)
        self.send_time = cfg.get("send_time", "21:00")
        self.dir = base / cfg.get("dir", "summaries")
        self.dir.mkdir(parents=True, exist_ok=True)
        self.bus, self.sent_day, self.day = bus, None, datetime.now().strftime("%Y-%m-%d")

    def build(self, modules):
        data = {"date": self.day, "generated": now_str(), "modules": {m.name: m.summary() for m in modules}}
        csv_path = self.bus.dir / f"{self.day}.csv"
        if csv_path.exists():
            with open(csv_path) as f:
                rows = list(csv.DictReader(f))
            by = {}
            for r in rows:
                by[r["module"]] = by.get(r["module"], 0) + 1
            data["events_total"], data["events_by_module"] = len(rows), by
        return data

    @staticmethod
    def text(data):
        lines = [f"📊 Daily summary {data['date']}", f"Events: {data.get('events_total', 0)}"]
        for m, c in data["modules"].items():
            if c:
                lines.append(f"• {m}: " + ", ".join(f"{k} {v}" for k, v in c.items()))
        return "\n".join(lines)

    def write(self, modules):
        data = self.build(modules)
        (self.dir / f"{self.day}.json").write_text(json.dumps(data, indent=2))
        return data

    def tick(self, modules):
        if not self.enabled:
            return
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        if now.strftime("%H:%M") >= self.send_time and self.sent_day != today and self.day == today:
            self.sent_day = today
            self.bus.telegram.send(self.text(self.write(modules)))
        if today != self.day:  # midnight rollover
            self.write(modules)
            self.day = today
            for m in modules:
                m.reset_day()
