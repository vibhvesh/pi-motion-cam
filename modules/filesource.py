"""FileSource: drop-in replacement for Picamera2 that feeds an image or video file through main.py's pipeline.

Used by `main.py --source FILE --out DIR` (and the dashboard's 🧪 Test file tab). Frames are BGR like Picamera2's
RGB888 'main' stream; the 'lores' stream is a Y plane shaped like YUV420 (h*3/2 x w) so main.py can slice [:lh, :lw].
Time is the file's own clock (frame_index / fps), so detection intervals and hold/cooldown timers follow video time.
"""
import time
from pathlib import Path

import cv2
import numpy as np

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_EXT = {".mp4", ".avi", ".mov", ".mkv", ".m4v", ".webm"}


class EndOfFile(Exception):
    pass


class FileSource:
    def __init__(self, path, repeat_frames=10, max_width=1920):
        self.path = Path(path)
        self.is_image = self.path.suffix.lower() in IMAGE_EXT
        self.repeat, self.max_width = max(1, int(repeat_frames)), max_width
        self.t0 = time.time()
        self.idx, self.frame = -1, None
        if self.is_image:
            img = cv2.imread(str(self.path))
            if img is None:
                raise ValueError(f"cannot read image {self.path.name}")
            self.still = self._fit(img)
            self.fps, self.total = 5.0, self.repeat          # an image = N identical frames 0.2 s apart
        else:
            self.cap = cv2.VideoCapture(str(self.path))
            if not self.cap.isOpened():
                raise ValueError(f"cannot open video {self.path.name} (OpenCV/FFmpeg could not decode it)")
            fps = self.cap.get(cv2.CAP_PROP_FPS)
            self.fps = fps if 1 <= fps <= 240 else 25.0
            self.total = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    def _fit(self, img):
        h, w = img.shape[:2]
        if w > self.max_width:
            img = cv2.resize(img, (self.max_width, int(h * self.max_width / w)), interpolation=cv2.INTER_AREA)
        return img

    # --- Picamera2-compatible surface used by main.py ---
    def create_video_configuration(self, main, lores, controls=None):
        return {"main": main, "lores": lores}

    def configure(self, conf):
        self.lores_size = tuple(conf["lores"]["size"])

    def start(self):
        pass

    def stop(self):
        if not self.is_image:
            self.cap.release()

    def _next(self):
        self.idx += 1
        if self.is_image:
            if self.idx >= self.total:
                raise EndOfFile
            self.frame = self.still
        else:
            ok, img = self.cap.read()
            if not ok:
                raise EndOfFile
            self.frame = self._fit(img)

    def capture_array(self, stream="main"):
        if stream == "lores":           # main.py calls lores first on every loop iteration -> advance one frame
            self._next()
            lw, lh = self.lores_size
            g = cv2.cvtColor(cv2.resize(self.frame, (lw, lh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
            return np.vstack([g, np.full((lh // 2, lw), 128, np.uint8)])
        return self.frame.copy()

    def clock(self):
        return self.t0 + max(0, self.idx) / self.fps

    @property
    def progress(self):
        return {"frame": min(self.idx + 1, self.total) if self.total else self.idx + 1, "total": self.total, "fps": round(self.fps, 2),
                "video_time": round(max(0, self.idx) / self.fps, 2), "kind": "image" if self.is_image else "video"}
