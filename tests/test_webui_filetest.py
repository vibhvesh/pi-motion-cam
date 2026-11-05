"""Flask test client: dashboard 🧪 Test file -> main.py --source pipeline (needs OpenCV 4.x with HOG, i.e. the Pi's apt OpenCV)."""
import io, os, shutil, sys, tempfile, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp())
cfg = (ROOT / "config.yaml").read_text()
cfg = cfg.replace("  counter:                   # 2. people in/out counter (multi-person tracking)\n    enabled: false", "  counter:                   # 2. people in/out counter (multi-person tracking)\n    enabled: true")
cfg = cfg.replace("  occupancy:                 # 8. crowd / occupancy limit\n    enabled: false\n    max_people: 5\n    hold_seconds: 5", "  occupancy:                 # 8. crowd / occupancy limit\n    enabled: true\n    max_people: 1\n    hold_seconds: 0.5")
(tmp / "config.yaml").write_text(cfg)
os.environ.update(PMC_BASE=str(tmp), PMC_TEST_DIR=str(tmp / "tests"))
sys.path.insert(0, str(ROOT))
from webui import server as S
c = S.app.test_client()
S1 = ROOT / "tests/samples"

def run(path, **form):
    r = c.post("/api/test", data={"file": (open(path, "rb"), path.name), **form}, content_type="multipart/form-data")
    assert r.status_code == 200, r.data
    tid = r.json["id"]
    for _ in range(300):
        s = c.get(f"/api/test/{tid}").json
        if not s["running"]:
            break
        time.sleep(0.2)
    assert s["result"], s["log"]
    return tid, s

tid, s = run(S1 / "people.mp4")
ev = s["result"]["events"]; print("video:", s["progress"], s["result"]["summary"], len(ev), "events")
assert ev and all(e["source"] == "file:people.mp4" for e in ev) and s["result"]["summary"]["counter"]["in"] >= 1
snap = next(e["snapshot"] for e in ev if e["snapshot"]); assert c.get(f"/api/test/{tid}/captures/{snap}").status_code == 200
assert c.get(f"/api/test/{tid}/last.jpg").mimetype == "image/jpeg"
r = c.get(f"/api/test/{tid}/stream.mjpg"); assert b"--frame" in next(r.response); r.close()
tid2, s2 = run(S1 / "people.jpg", frames="6")
print("image:", s2["progress"], s2["result"]["summary"], len(s2["result"]["events"]), "events")
assert s2["progress"]["total"] == 6 and s2["result"]["summary"]["occupancy"]["peak"] >= 1
# the live service's data folders were not touched
assert not (tmp / "events").exists() and not (tmp / "captures").exists()
# validation
assert c.post("/api/test", data={"file": (io.BytesIO(b"x"), "evil.exe")}, content_type="multipart/form-data").status_code == 400
assert c.post("/api/test", data={}, content_type="multipart/form-data").status_code == 400
S.app.config["MAX_CONTENT_LENGTH"] = 1000
assert c.post("/api/test", data={"file": (io.BytesIO(b"x" * 5000), "big.mp4")}, content_type="multipart/form-data").status_code == 413
assert c.get("/api/test/../../etc").status_code == 404 and c.get("/api/test/zzzzzzzzzzzz").status_code == 404
assert c.get(f"/api/test/{tid}/captures/..%2F..%2Fmeta.json").status_code == 404
print("filetest PASS")
