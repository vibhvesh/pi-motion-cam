"""v9 logic: plate majority vote, conf-0 Indian accept, tamper covered/moved/blur, fall without pose."""
import sys, types, pathlib
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.modules.setdefault("pytesseract", types.SimpleNamespace(Output=types.SimpleNamespace(DICT=1)))
from modules.plates import PlateModule
from modules.scene import TamperModule
from modules.behavior import FallModule

ctx = types.SimpleNamespace(base=pathlib.Path("/tmp/pmc_v9test"))

def track(i, box, cls="car"):
    x, y, w, h = box
    return types.SimpleNamespace(id=i, cls=cls, box=box, centroid=(x + w / 2, y + h / 2), flags={}, pose=None)

def test_plate_vote_and_conf0():
    m = PlateModule({"tries": 8, "votes": 2}, ctx)
    reads = iter([("MH12AB1234", True, 0.0), ("MH12AB1284", True, 10.0), ("MH12AB1234", True, 0.0)])
    m.read = lambda img, box: next(reads)
    t = track(1, (0, 0, 300, 200))
    evs = []
    for k in range(3):
        f = types.SimpleNamespace(size=(640, 480), tracks={1: t}, ts=float(k * 2 + 2), image=np.zeros((480, 640, 3), np.uint8))
        evs += m.process(f)
    assert len(evs) == 1 and "MH12AB1234" in evs[0].message, evs
    assert not m._accept(("JUNK1", False, 20.0))

def test_tamper():
    m = TamperModule({}, ctx)
    rng = np.random.default_rng(0)
    scene = (rng.random((240, 320)) * 255).astype(np.uint8)
    ev = []
    for i in range(10): ev += m.on_lores(scene, None, 0, i * 0.2)
    assert not ev
    for i in range(10): ev += m.on_lores(np.full((240, 320), 5, np.uint8), None, 0, 2 + i * 0.2)
    assert any(e.type == "covered" for e in ev)
    m2 = TamperModule({}, ctx); ev = []
    for i in range(5): ev += m2.on_lores(scene, None, 0, i * 0.2)
    moved = np.roll(scene[::-1], 100, axis=1)
    for i in range(12): ev += m2.on_lores(moved, None, 0, 1 + i * 0.2)
    assert any(e.type == "moved" for e in ev), ev

def test_fall_no_pose():
    m = FallModule({}, ctx); t = track(1, (100, 50, 60, 200), "person"); ev = []
    t.pose = None
    for k, box in enumerate([(100, 50, 60, 200)] * 3 + [(80, 200, 150, 70)] * 8):
        t.box = box; t.centroid = (box[0] + box[2] / 2, box[1] + box[3] / 2)
        ev += m.process(types.SimpleNamespace(tracks={1: t}, ts=k * 0.5))
    assert len(ev) == 1
