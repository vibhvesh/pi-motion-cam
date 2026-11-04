"""Run main.py for a few seconds with a fake picamera2: checks live.jpg/status.json publishing and config hot-reload."""
import json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp())
for n in ["main.py", "config.yaml"]: shutil.copy(ROOT / n, tmp / n)
shutil.copytree(ROOT / "modules", tmp / "modules")
live = tmp / "live"
cfg = (tmp / "config.yaml").read_text().replace("live_dir: /dev/shm/pi-motion-cam", f"live_dir: {live}").replace("warmup_seconds: 2", "warmup_seconds: 0").replace("motion_alert:              # classic: motion (+ person) -> photo alert\n    enabled: true", "motion_alert:\n    enabled: false")  # box OpenCV 5 has no HOG; Pi apt OpenCV 4 does
(tmp / "config.yaml").write_text(cfg)
fake = tmp / "fake"; (fake / "picamera2").mkdir(parents=True)
(fake / "picamera2/__init__.py").write_text('''
import numpy as np, time
class Picamera2:
    def create_video_configuration(self, main, lores, controls): return {"main": main, "lores": lores}
    def configure(self, c): self.c = c
    def start(self): self.i = 0
    def stop(self): pass
    def capture_array(self, s):
        time.sleep(0.02); self.i += 1
        if s == "lores":
            w, h = self.c["lores"]["size"]; a = np.random.randint(0, 255, (h * 3 // 2, w), np.uint8); return a
        w, h = self.c["main"]["size"]; return np.random.randint(0, 255, (h, w, 3), np.uint8)
''')
env = dict(os.environ, PYTHONPATH=str(fake))
p = subprocess.Popen([sys.executable, "main.py"], cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(6)
p.poll() is None or print(p.stdout.read()[-3000:])
assert (live / "live.jpg").exists() and (live / "status.json").exists(), "no live output"
st = json.loads((live / "status.json").read_text()); print("status:", st["modules"], st["detector"])
(tmp / "config.yaml").write_text((tmp / "config.yaml").read_text().replace("  tamper:                    # 9. camera covered / blurred / moved\n    enabled: false", "  tamper:                    # 9. camera covered / blurred / moved\n    enabled: true"))
time.sleep(6)
st = json.loads((live / "status.json").read_text()); print("after reload:", st["modules"])
p.terminate(); out = p.communicate(timeout=10)[0]
print(out[-1500:])
assert "tamper" in st["modules"] and "config.yaml reloaded" in out
print("main mock PASS")
