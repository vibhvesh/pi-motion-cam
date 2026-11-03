"""Optional MoveNet SinglePose Lightning (TFLite) per person crop. Install: see README (pose section)."""
import logging
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger("motioncam")
# COCO keypoint order used by MoveNet
KP = ["nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_sho", "r_sho", "l_elb", "r_elb", "l_wri", "r_wri",
      "l_hip", "r_hip", "l_knee", "r_knee", "l_ank", "r_ank"]


class PoseEstimator:
    def __init__(self, c, base):
        path = base / c.get("model", "models/movenet_lightning.tflite")
        if not path.exists():
            raise FileNotFoundError(f"{path} missing (run ./install.sh --pose)")
        try:
            from ai_edge_litert.interpreter import Interpreter
        except ImportError:
            try:
                from tflite_runtime.interpreter import Interpreter
            except ImportError:
                from tensorflow.lite import Interpreter  # type: ignore
        self.it = Interpreter(model_path=str(path), num_threads=c.get("threads", 2))
        self.it.allocate_tensors()
        self.inp, self.out = self.it.get_input_details()[0], self.it.get_output_details()[0]
        self.size = int(self.inp["shape"][1])
        self.max_people = c.get("max_people", 3)

    def estimate(self, bgr, box):
        """Returns 17 (x, y, score) in full-frame pixel coords for a person box."""
        x, y, w, h = box
        s = max(w, h) * 1.2
        cx, cy = x + w / 2, y + h / 2
        x0, y0 = int(cx - s / 2), int(cy - s / 2)
        H, W = bgr.shape[:2]
        crop = np.zeros((int(s), int(s), 3), np.uint8)
        sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(W, x0 + int(s)), min(H, y0 + int(s))
        if sx1 <= sx0 or sy1 <= sy0:
            return None
        crop[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = bgr[sy0:sy1, sx0:sx1]
        img = cv2.cvtColor(cv2.resize(crop, (self.size, self.size)), cv2.COLOR_BGR2RGB)
        img = np.expand_dims(img, 0).astype(self.inp["dtype"])
        self.it.set_tensor(self.inp["index"], img)
        self.it.invoke()
        kps = self.it.get_tensor(self.out["index"])[0, 0]  # 17 x (y, x, score), normalized to crop
        return [(x0 + float(k[1]) * s, y0 + float(k[0]) * s, float(k[2])) for k in kps]


def torso_angle(kps, min_score=0.3):
    """Angle of shoulder-mid -> hip-mid from vertical, degrees (0 = upright, 90 = lying). None if unsure."""
    if not kps:
        return None
    ls, rs, lh, rh = kps[5], kps[6], kps[11], kps[12]
    if min(ls[2], rs[2], lh[2], rh[2]) < min_score:
        return None
    sx, sy = (ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2
    hx, hy = (lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2
    return float(np.degrees(np.arctan2(abs(hx - sx), abs(hy - sy) + 1e-6)))


def make_pose(c, base):
    if not c.get("enabled", False):
        return None
    try:
        return PoseEstimator(c, base)
    except Exception as e:
        log.warning("Pose disabled: %s (fall/fight use box heuristics)", e)
        return None
