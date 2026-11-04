"""Flask test-client checks for webui/server.py against a temp copy of the repo data layout."""
import csv, io, json, os, shutil, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp())
shutil.copy(ROOT / "config.yaml", tmp / "config.yaml")
os.environ["PMC_BASE"] = str(tmp)
sys.path.insert(0, str(ROOT))
import cv2, numpy as np
from webui import server as S

S.app.testing = True
c = S.app.test_client()
jpg = cv2.imencode(".jpg", np.zeros((40, 40, 3), np.uint8))[1].tobytes()
day = __import__("datetime").datetime.now().strftime("%Y-%m-%d")
(tmp / "unknown_faces").mkdir(); (tmp / "unknown_faces/unknown_1.jpg").write_bytes(jpg); (tmp / "unknown_faces/unknown_2.jpg").write_bytes(jpg)
(tmp / "events").mkdir(); (tmp / "captures").mkdir(); (tmp / "captures/a.jpg").write_bytes(jpg)
with open(tmp / f"events/{day}.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["timestamp", "module", "type", "severity", "message", "track_id", "snapshot"])
    w.writerow([f"{day} 10:00:00", "zone_intrusion", "intrusion", "alert", "Person in restricted", 3, str(tmp / "captures/a.jpg")])
    w.writerow([f"{day} 10:01:00", "counter", "in", "info", "IN", 4, ""])
(tmp / "plates").mkdir()
(tmp / f"plates/{day}.csv").write_text("plate,direction,time,confidence\nMH12AB1234,in,10:00,80\nDL3CAB0001,in,10:01,70\nDL3CAB0001,out,10:05,70\n")
(tmp / "attendance").mkdir(); (tmp / f"attendance/{day}.csv").write_text("name,first_seen_in,last_seen_out,photo\nalice,09:00:00,09:30:00,\n")

def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.data[:300]); return r

ok(c.get("/")); assert b"Pi Motion Cam" in c.get("/").data
st = ok(c.get("/api/status")).json; assert "disk_free" in st and "url" in st
assert ok(c.get("/snapshot.jpg")).mimetype == "image/jpeg"
r = c.get("/stream.mjpg"); assert r.status_code == 200 and "multipart" in r.mimetype; r.close()
cfg = ok(c.get("/api/config")).json; assert "modules" in cfg
# module toggle + settings (comments preserved)
ok(c.put("/api/config", json={"path": "modules.counter", "value": {"enabled": True, "classes": ["person", "car"]}}))
txt = (tmp / "config.yaml").read_text(); assert "# 2. people in/out counter" in txt
cfg = c.get("/api/config").json; assert cfg["modules"]["counter"]["enabled"] is True and cfg["modules"]["counter"]["classes"] == ["person", "car"]
assert cfg["modules"]["counter"]["line"] == [[0.5, 0.0], [0.5, 1.0]]
ok(c.put("/api/config", json={"path": "modules.zone_intrusion.zones", "value": [{"name": "door", "points": [[0.1, 0.1], [0.3, 0.1], [0.3, 0.4]]}], "replace": True}))
assert c.get("/api/config").json["modules"]["zone_intrusion"]["zones"][0]["name"] == "door"
ok(c.put("/api/config", json={"path": "../etc", "value": 1}), 400)
# telegram: masked token never overwrites the real one
ok(c.put("/api/config", json={"path": "events.telegram", "value": {"bot_token": "123:SECRETTOKEN", "chat_id": "42"}}))
assert c.get("/api/config").json["events"]["telegram"]["bot_token"] == "••••OKEN"
ok(c.put("/api/config", json={"path": "events.telegram", "value": {"bot_token": "••••OKEN", "chat_id": "43"}}))
import yaml; raw = yaml.safe_load((tmp / "config.yaml").read_text()); assert raw["events"]["telegram"]["bot_token"] == "123:SECRETTOKEN" and raw["events"]["telegram"]["chat_id"] == "43"
# unknown queue: label + discard
assert len(ok(c.get("/api/unknown")).json) == 2
ok(c.get("/api/unknown/unknown_1.jpg"))
j = ok(c.post("/api/unknown/unknown_1.jpg/label", json={"name": "Rahul Sharma"})).json
assert (tmp / "known_faces/Rahul Sharma/Rahul Sharma_1.jpg").exists() and not (tmp / "unknown_faces/unknown_1.jpg").exists()
ok(c.post("/api/unknown/unknown_2.jpg/label", json={"name": ""}), 400)
ok(c.get("/api/unknown/..%2Fconfig.yaml"), 404)
ok(c.delete("/api/unknown/unknown_2.jpg")); assert c.get("/api/unknown").json == []
# enrollment bulk upload
r = ok(c.post("/api/people", data={"name": "bob", "photos": [(io.BytesIO(jpg), "b1.jpg"), (io.BytesIO(jpg), "b2.png"), (io.BytesIO(b"x"), "x.txt")]}, content_type="multipart/form-data")).json
assert r["ok"] == 2, r
ppl = {p["name"]: p for p in ok(c.get("/api/people")).json}; assert set(ppl) == {"Rahul Sharma", "bob"} and len(ppl["bob"]["photos"]) == 2
ok(c.get("/api/people/photo/" + ppl["bob"]["photos"][0]))
ok(c.delete("/api/people/bob")); assert "bob" not in {p["name"] for p in c.get("/api/people").json}
# attendance, events, plates
assert ok(c.get("/api/attendance")).json["rows"][0]["name"] == "alice"
assert b"alice" in ok(c.get("/api/attendance.csv")).data
ev = ok(c.get("/api/events?severity=alert")).json; assert len(ev["rows"]) == 1 and ev["rows"][0]["snapshot"] == "a.jpg"
assert len(c.get("/api/events?module=counter").json["rows"]) == 1 and len(c.get("/api/events?q=restricted").json["rows"]) == 1
ok(c.get("/captures/a.jpg")); ok(c.get("/api/events.csv"))
pl = ok(c.get("/api/plates")).json; assert [r["plate"] for r in pl["inside"]] == ["MH12AB1234"]
ok(c.post("/api/plates/watchlist", json={"watchlist": "mh12ab1234, dl-3c-ab-0001"}))
assert c.get("/api/plates").json["watchlist"] == ["DL3CAB0001", "MH12AB1234"]
ok(c.get("/api/plates.csv")); ok(c.get("/api/logs")); ok(c.get("/api/date-bad"), 404); ok(c.get("/api/events?date=x"), 400)
ok(c.post("/api/service/reboot"), 400)
assert c.post("/api/telegram/test").status_code in (200, 400, 502)
# password
ok(c.put("/api/config", json={"path": "web", "value": {"password": "pw123"}}))
c2 = S.app.test_client(); ok(c2.get("/api/status"), 401); assert c2.get("/").status_code == 302
ok(c2.post("/login", data={"password": "nope"}), 401); assert c2.post("/login", data={"password": "pw123"}).status_code == 302; ok(c2.get("/api/status"))
print("webui tests PASS")
