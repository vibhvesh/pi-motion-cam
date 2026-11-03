"""Object detectors: OpenCV HOG (person only, no download) or MobileNet-SSD (Caffe, 20 VOC classes incl. animals/vehicles)."""
import logging
from pathlib import Path

import cv2
import numpy as np

from .tracker import Detection

log = logging.getLogger("motioncam")
VOC = ["background", "aeroplane", "bicycle", "bird", "boat", "bottle", "bus", "car", "cat", "chair", "cow",
       "diningtable", "dog", "horse", "motorbike", "person", "pottedplant", "sheep", "sofa", "train", "tvmonitor"]


def night_enhance(img):
    """CLAHE on luminance when the scene is dark (helps at night / IR)."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


class HOGDetector:
    classes = {"person"}

    def __init__(self, c):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        self.stride = tuple(c.get("win_stride", [8, 8]))
        self.scale = c.get("scale", 1.05)
        self.width = c.get("detect_width", 640)

    def detect(self, bgr, conf=0.0):
        h, w = bgr.shape[:2]
        r = self.width / float(w) if w > self.width else 1.0
        small = cv2.resize(bgr, (int(w * r), int(h * r))) if r != 1.0 else bgr
        rects, weights = self.hog.detectMultiScale(small, winStride=self.stride, padding=(8, 8), scale=self.scale)
        out = []
        for (x, y, bw, bh), wt in zip(rects, np.ravel(weights) if len(rects) else []):
            if float(wt) >= conf:
                out.append(Detection("person", float(wt), (int(x / r), int(y / r), int(bw / r), int(bh / r))))
        return out


class MobileNetSSD:
    classes = set(VOC[1:])

    def __init__(self, c, base):
        d = base / c.get("model_dir", "models")
        proto, model = d / "MobileNetSSD_deploy.prototxt", d / "MobileNetSSD_deploy.caffemodel"
        if not (proto.exists() and model.exists()):
            raise FileNotFoundError(f"MobileNet-SSD files missing in {d} (run ./install.sh --dnn)")
        self.net = cv2.dnn.readNetFromCaffe(str(proto), str(model))

    def detect(self, bgr, conf=0.4):
        h, w = bgr.shape[:2]
        blob = cv2.dnn.blobFromImage(cv2.resize(bgr, (300, 300)), 0.007843, (300, 300), 127.5)
        self.net.setInput(blob)
        out = []
        for d in self.net.forward()[0, 0]:
            score, idx = float(d[2]), int(d[1])
            if score < conf or idx <= 0 or idx >= len(VOC):
                continue
            x1, y1, x2, y2 = (d[3:7] * np.array([w, h, w, h])).astype(int)
            x1, y1 = max(0, x1), max(0, y1)
            out.append(Detection(VOC[idx], score, (int(x1), int(y1), int(x2 - x1), int(y2 - y1))))
        return out


def make_detector(c, base):
    kind = c.get("type", "hog")
    if kind == "mobilenet_ssd":
        try:
            return MobileNetSSD(c, base)
        except Exception as e:  # fall back so the camera still works
            log.error("%s -> falling back to HOG person detector", e)
    return HOGDetector(c)
