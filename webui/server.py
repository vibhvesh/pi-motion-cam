#!/usr/bin/env python3
"""Pi Motion Cam — local management dashboard (Flask). Run: ./venv/bin/python -m webui.server  ->  http://<pi-ip>:8080

Talks to the camera service (main.py) only through files: config.yaml (hot-reloaded by main.py), the live frame +
status in /dev/shm/pi-motion-cam/, and the data folders (events/, captures/, attendance/, plates/, known_faces/, unknown_faces/).
"""
import csv
import io
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import Flask, Response, abort, jsonify, redirect, request, send_file, send_from_directory, session

BASE = Path(os.environ.get("PMC_BASE", Path(__file__).resolve().parent.parent))
CONFIG = BASE / "config.yaml"
SERVICE = os.environ.get("PMC_SERVICE", "pi-motion-cam")
IMG_EXT = (".jpg", ".jpeg", ".png")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# ---------- config (comment-preserving with ruamel.yaml when available) ----------
try:
    from ruamel.yaml import YAML

    def _ry():  # YAML() objects are not thread-safe -> one per call
        y = YAML()
        y.preserve_quotes = True
        y.width = 4096
        return y

    def _load_rt():
        with open(CONFIG) as f:
            return _ry().load(f) or {}

    def _dump_rt(data):
        buf = io.StringIO()
        _ry().dump(data, buf)
        return buf.getvalue()
except ImportError:  # pragma: no cover
    import yaml as _y

    def _load_rt():
        with open(CONFIG) as f:
            return _y.safe_load(f) or {}

    def _dump_rt(data):
        return _y.safe_dump(data, sort_keys=False, allow_unicode=True)


def plain(o):
    """ruamel CommentedMap/Seq -> plain dict/list for JSON."""
    if isinstance(o, dict):
        return {str(k): plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [plain(v) for v in o]
    return o


_lock = threading.RLock()
_cache = {"key": None, "cfg": None}


def load_cfg():
    with _lock:
        st = CONFIG.stat()
        key = (st.st_mtime_ns, st.st_size)
        if _cache["key"] != key:
            _cache["cfg"], _cache["key"] = plain(_load_rt()), key
        return json.loads(json.dumps(_cache["cfg"]))


def merge_into(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            merge_into(dst[k], v)
        else:
            dst[k] = v


def save_cfg_patch(path, value, replace=False):
    """Set/merge `value` at dotted `path` in config.yaml, keeping comments. Atomic write + .bak backup."""
    with _lock:
        _save_patch(path, value, replace)


def _save_patch(path, value, replace):
    data = _load_rt()
    node, keys = data, [k for k in path.split(".") if k]
    for k in keys[:-1]:
        if node.get(k) is None:
            node[k] = {}
        node = node[k]
    last = keys[-1]
    if not replace and isinstance(value, dict) and isinstance(node.get(last), dict):
        merge_into(node[last], value)
    else:
        node[last] = value
    text = _dump_rt(data)
    import yaml
    yaml.safe_load(text)  # validate before writing
    shutil.copy2(CONFIG, CONFIG.with_suffix(".yaml.bak"))
    tmp = CONFIG.with_suffix(".yaml.tmp")
    tmp.write_text(text)
    os.replace(tmp, CONFIG)


def wcfg():
    return load_cfg().get("web", {}) or {}


def mcfg(name):
    return (load_cfg().get("modules", {}) or {}).get(name) or {}


def folder(rel, default):
    p = Path(rel or default)
    return p if p.is_absolute() else BASE / p


def live_dir():
    d = Path(wcfg().get("live_dir", "/dev/shm/pi-motion-cam"))
    return d if d.exists() else BASE / ".live"


def safe_name(name):
    """Person name -> folder-safe name (letters, digits, space, - _ .), no traversal."""
    name = re.sub(r"[^\w .\-]", "", (name or "").strip(), flags=re.UNICODE).strip(" .")
    return name[:60]


def safe_file(d, fn):
    p = (d / fn).resolve()
    if p.parent != d.resolve() or not p.is_file():
        abort(404)
    return p


# ---------- app ----------
app = Flask(__name__, static_folder=str(Path(__file__).parent / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("PMC_MAX_UPLOAD_MB", 200)) * 1024 * 1024  # test-file uploads
_secret = BASE / ".web_secret"
try:
    if not _secret.exists():
        _secret.write_text(secrets.token_hex(32))
        os.chmod(_secret, 0o600)
    app.secret_key = _secret.read_text().strip()
except OSError:
    app.secret_key = secrets.token_hex(32)


def password():
    return os.environ.get("PMC_WEB_PASSWORD") or str(wcfg().get("password") or "")


def auth(f):
    @wraps(f)
    def w(*a, **k):
        if password() and not session.get("ok"):
            if request.path.startswith("/api/") or request.path.endswith((".mjpg", ".jpg", ".csv")):
                return jsonify(error="login required"), 401
            return redirect("/login")
        return f(*a, **k)
    return w


LOGIN_HTML = """<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Pi Motion Cam login</title>
<style>body{font-family:system-ui;background:#0f1419;color:#e6e6e6;display:grid;place-items:center;height:90vh}form{background:#161d26;padding:24px;border-radius:12px}
input,button{font-size:16px;padding:10px;border-radius:8px;border:1px solid #2a3442;margin:6px 0;width:100%;box-sizing:border-box}button{background:#7aa2f7;border:0;color:#000}</style>
<form method=post><h3>📷 Pi Motion Cam</h3>{MSG}<input type=password name=password placeholder=Password autofocus><button>Log in</button></form>"""


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        if not password() or secrets.compare_digest(request.form.get("password", ""), password()):
            session["ok"] = True
            session.permanent = True
            return redirect("/")
        time.sleep(1)
        return LOGIN_HTML.replace("{MSG}", "<p style=color:#f7768e>Wrong password</p>"), 401
    return LOGIN_HTML.replace("{MSG}", "")


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


@app.route("/")
@auth
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------- live ----------
_placeholder = None


def placeholder_jpeg(text="Camera service not running"):
    global _placeholder
    if _placeholder is None:
        try:
            import cv2
            import numpy as np
            img = np.full((360, 640, 3), 30, np.uint8)
            cv2.putText(img, text, (40, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (200, 200, 200), 2)
            _placeholder = cv2.imencode(".jpg", img)[1].tobytes()
        except Exception:
            _placeholder = b""
    return _placeholder


def live_frame(max_age=10):
    p = live_dir() / "live.jpg"
    try:
        if time.time() - p.stat().st_mtime < max_age:
            return p.read_bytes(), p.stat().st_mtime
    except OSError:
        pass
    return placeholder_jpeg(), 0


@app.route("/stream.mjpg")
@auth
def stream():
    def gen():
        last, t_end = None, time.time() + 3600
        while time.time() < t_end:
            data, mt = live_frame()
            if mt != last or mt == 0:
                last = mt
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n"
            time.sleep(0.1 if mt else 2)
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame", headers={"Cache-Control": "no-store"})


@app.route("/snapshot.jpg")
@auth
def snapshot():
    data, _ = live_frame(max_age=10 ** 9)
    return Response(data, mimetype="image/jpeg", headers={"Cache-Control": "no-store"})


# ---------- system ----------
def sh(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:
        return 1, str(e)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


@app.route("/api/status")
@auth
def api_status():
    temp = None
    try:
        temp = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
    except (OSError, ValueError):
        pass
    du = shutil.disk_usage(BASE)
    try:
        up = float(Path("/proc/uptime").read_text().split()[0])
    except OSError:
        up = None
    mem = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":")
            mem[k] = int(v.split()[0])
    except OSError:
        pass
    cam = {}
    try:
        cam = json.loads((live_dir() / "status.json").read_text())
    except (OSError, ValueError):
        pass
    _, active = sh(["systemctl", "is-active", SERVICE])
    return jsonify(cpu_temp=temp, disk_total=du.total, disk_free=du.free, uptime=up, load=os.getloadavg(),
                   mem_total_kb=mem.get("MemTotal"), mem_avail_kb=mem.get("MemAvailable"), service=SERVICE,
                   service_state=active.splitlines()[-1] if active else "unknown", camera=cam,
                   camera_age=(time.time() - cam["ts"]) if cam.get("ts") else None,
                   url=f"http://{lan_ip()}:{wcfg().get('port', 8080)}", hostname=socket.gethostname())


@app.route("/api/service/<action>", methods=["POST"])
@auth
def api_service(action):
    if action not in ("start", "stop", "restart"):
        abort(400)
    code, out = sh(["sudo", "-n", "systemctl", action, SERVICE], timeout=30)
    if code:
        code, out = sh(["systemctl", action, SERVICE], timeout=30)
    return jsonify(ok=code == 0, output=out), (200 if code == 0 else 500)


@app.route("/api/logs")
@auth
def api_logs():
    n = max(10, min(2000, request.args.get("n", 200, type=int)))
    cmd = ["journalctl", "-u", SERVICE, "-n", str(n), "--no-pager", "-o", "short-iso"]
    code, out = sh(cmd)
    if code or "No journal files" in out or "not seeing messages" in out:
        c2, o2 = sh(["sudo", "-n"] + cmd)
        if c2 == 0:
            out = o2
    return jsonify(text=out)


# ---------- config ----------
SECRET_KEYS = ("bot_token", "password")


def masked(cfg):
    c = json.loads(json.dumps(cfg))
    tg = c.get("events", {}).get("telegram", {})
    if tg.get("bot_token"):
        tg["bot_token"] = "••••" + str(tg["bot_token"])[-4:]
    if c.get("web", {}).get("password"):
        c["web"]["password"] = "••••"
    return c


@app.route("/api/config")
@auth
def api_config():
    return jsonify(masked(load_cfg()))


@app.route("/api/config", methods=["PUT", "POST"])
@auth
def api_config_set():
    body = request.get_json(force=True, silent=True) or {}
    path, value = str(body.get("path", "")), body.get("value")
    if not re.fullmatch(r"[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*", path):
        return jsonify(error="bad path"), 400

    def strip_masked(v):  # never write the masked placeholder back
        if isinstance(v, dict):
            return {k: strip_masked(x) for k, x in v.items() if not (k in SECRET_KEYS and isinstance(x, str) and x.startswith("••••"))}
        return v
    value = strip_masked(value)
    try:
        save_cfg_patch(path, value, replace=bool(body.get("replace")))
    except Exception as e:
        return jsonify(error=f"could not save: {e}"), 400
    out = {"ok": True, "note": "Saved. The camera service hot-reloads config.yaml within ~2 s."}
    if body.get("restart"):
        code, msg = sh(["sudo", "-n", "systemctl", "restart", SERVICE], timeout=30)
        out.update(restarted=code == 0, restart_output=msg)
    return jsonify(out)


@app.route("/api/telegram/test", methods=["POST"])
@auth
def api_tg_test():
    import requests
    tg = load_cfg().get("events", {}).get("telegram", {})
    tok = os.environ.get("TELEGRAM_BOT_TOKEN") or tg.get("bot_token")
    chat = os.environ.get("TELEGRAM_CHAT_ID") or tg.get("chat_id")
    if not tok or not chat:
        return jsonify(ok=False, error="Set bot token and chat id first"), 400
    try:
        r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                          data={"chat_id": chat, "text": f"✅ Pi Motion Cam test from {socket.gethostname()} at {datetime.now():%H:%M:%S}"}, timeout=10)
        j = r.json()
        return jsonify(ok=bool(j.get("ok")), error=j.get("description")), (200 if j.get("ok") else 400)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 502


# ---------- csv helpers ----------
def read_csv(p):
    try:
        with open(p, newline="") as f:
            return list(csv.DictReader(f))
    except OSError:
        return []


def day_arg():
    d = request.args.get("date") or datetime.now().strftime("%Y-%m-%d")
    if not DATE_RE.match(d):
        abort(400)
    return d


def dates_in(d):
    return sorted((p.stem for p in d.glob("*.csv") if DATE_RE.match(p.stem)), reverse=True)


def csv_response(rows, fields, name):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    return Response(buf.getvalue(), mimetype="text/csv", headers={"Content-Disposition": f"attachment; filename={name}"})


# ---------- attendance ----------
def att_dir():
    return folder(mcfg("attendance").get("dir"), "attendance")


def known_dir():
    return folder(mcfg("attendance").get("known_faces_dir"), "known_faces")


def unknown_dir():
    return folder(mcfg("attendance").get("unknown_faces_dir"), "unknown_faces")


@app.route("/api/attendance")
@auth
def api_att():
    d = day_arg()
    return jsonify(date=d, rows=read_csv(att_dir() / f"{d}.csv"), dates=dates_in(att_dir()))


@app.route("/api/attendance.csv")
@auth
def api_att_csv():
    d = day_arg()
    return csv_response(read_csv(att_dir() / f"{d}.csv"), ["name", "first_seen_in", "last_seen_out", "photo"], f"attendance_{d}.csv")


def people():
    kd = known_dir()
    kd.mkdir(parents=True, exist_ok=True)
    out = {}
    for p in sorted(kd.rglob("*")):
        if p.is_file() and p.suffix.lower() in IMG_EXT:
            name = p.parent.name if p.parent != kd else re.sub(r"[_-]\d+$", "", p.stem)
            out.setdefault(name, []).append(str(p.relative_to(kd)))
    return out


@app.route("/api/people")
@auth
def api_people():
    return jsonify([{"name": n, "photos": ph} for n, ph in people().items()])


@app.route("/api/people/photo/<path:rel>")
@auth
def api_people_photo(rel):
    kd = known_dir().resolve()
    p = (kd / rel).resolve()
    if kd not in p.parents or not p.is_file():
        abort(404)
    return send_file(p)


def face_check(path):
    """Return None if OK / not checkable, else an error string. Uses face_recognition if installed."""
    try:
        import face_recognition as fr
    except ImportError:
        return None
    try:
        return None if fr.face_encodings(fr.load_image_file(str(path))) else "no face found"
    except Exception as e:
        return str(e)


def person_dir(name):
    d = known_dir() / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def next_path(d, name, ext=".jpg"):
    i = 1
    while (d / f"{name}_{i}{ext}").exists():
        i += 1
    return d / f"{name}_{i}{ext}"


@app.route("/api/people", methods=["POST"])
@auth
def api_people_add():
    name = safe_name(request.form.get("name"))
    if not name:
        return jsonify(error="Enter a name"), 400
    results = []
    for f in request.files.getlist("photos"):
        ext = Path(f.filename or "").suffix.lower()
        if ext not in IMG_EXT:
            results.append({"file": f.filename, "ok": False, "error": "not a jpg/png"})
            continue
        dst = next_path(person_dir(name), name, ".jpg" if ext == ".jpeg" else ext)
        f.save(dst)
        err = face_check(dst)
        if err:
            dst.unlink(missing_ok=True)
        results.append({"file": f.filename, "ok": not err, "error": err, "saved": dst.name if not err else None})
    return jsonify(name=name, results=results, ok=sum(r["ok"] for r in results))


@app.route("/api/people/<name>", methods=["DELETE"])
@auth
def api_people_del(name):
    kd = known_dir()
    n = 0
    for rel in people().get(name, []):
        p = (kd / rel).resolve()
        if kd.resolve() in p.parents:
            p.unlink(missing_ok=True)
            n += 1
    sub = kd / safe_name(name)
    if safe_name(name) and sub.is_dir() and not any(sub.iterdir()):
        sub.rmdir()
    return jsonify(ok=n > 0, deleted=n)


@app.route("/api/unknown")
@auth
def api_unknown():
    ud = unknown_dir()
    ud.mkdir(parents=True, exist_ok=True)
    files = sorted((p for p in ud.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXT), key=lambda p: -p.stat().st_mtime)
    return jsonify([{"file": p.name, "time": datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")} for p in files[:200]])


@app.route("/api/unknown/<fn>")
@auth
def api_unknown_img(fn):
    return send_file(safe_file(unknown_dir(), fn))


@app.route("/api/unknown/<fn>/label", methods=["POST"])
@auth
def api_unknown_label(fn):
    src = safe_file(unknown_dir(), fn)
    name = safe_name((request.get_json(silent=True) or {}).get("name") or request.form.get("name"))
    if not name:
        return jsonify(error="Enter a name"), 400
    dst = next_path(person_dir(name), name, src.suffix.lower())
    shutil.move(str(src), dst)
    os.utime(dst)  # change signature -> camera service re-encodes known faces on its next attendance tick
    warn = face_check(dst)
    return jsonify(ok=True, name=name, saved=str(dst.relative_to(known_dir())),
                   warning=f"saved, but face_recognition says: {warn} (crop may be too small)" if warn else None)


@app.route("/api/unknown/<fn>", methods=["DELETE"])
@auth
def api_unknown_del(fn):
    safe_file(unknown_dir(), fn).unlink()
    return jsonify(ok=True)


# ---------- events ----------
def events_dir():
    return folder(load_cfg().get("events", {}).get("events_dir"), "events")


def snap_dir():
    return folder(load_cfg().get("events", {}).get("snapshot_dir"), "captures")


@app.route("/api/events")
@auth
def api_events():
    d = day_arg()
    rows = read_csv(events_dir() / f"{d}.csv")
    mod, sev, q = request.args.get("module"), request.args.get("severity"), (request.args.get("q") or "").lower()
    out = []
    for r in reversed(rows):
        if mod and r.get("module") != mod or sev and r.get("severity") != sev or q and q not in json.dumps(r).lower():
            continue
        r["snapshot"] = Path(r["snapshot"]).name if r.get("snapshot") else ""
        out.append(r)
    return jsonify(date=d, rows=out[:1000], total=len(rows), dates=dates_in(events_dir()),
                   modules=sorted({r.get("module", "") for r in rows}))


@app.route("/api/events.csv")
@auth
def api_events_csv():
    d = day_arg()
    return csv_response(read_csv(events_dir() / f"{d}.csv"), ["timestamp", "module", "type", "severity", "message", "track_id", "snapshot"], f"events_{d}.csv")


@app.route("/captures/<fn>")
@auth
def capture(fn):
    return send_file(safe_file(snap_dir(), fn))


# ---------- plates ----------
def plates_dir():
    return folder(mcfg("plates").get("dir"), "plates")


@app.route("/api/plates")
@auth
def api_plates():
    d = day_arg()
    rows = read_csv(plates_dir() / f"{d}.csv")
    state = {}
    for r in rows:
        state[r.get("plate")] = r
    inside = [r for r in state.values() if (r.get("direction") or "").lower() == "in"]
    wl = [str(x).upper() for x in (mcfg("plates").get("watchlist") or [])]
    return jsonify(date=d, rows=list(reversed(rows)), inside=inside, watchlist=wl, dates=dates_in(plates_dir()))


@app.route("/api/plates.csv")
@auth
def api_plates_csv():
    d = day_arg()
    return csv_response(read_csv(plates_dir() / f"{d}.csv"), ["plate", "direction", "time", "confidence"], f"plates_{d}.csv")


@app.route("/api/plates/watchlist", methods=["PUT", "POST"])
@auth
def api_watchlist():
    items = (request.get_json(silent=True) or {}).get("watchlist", [])
    if isinstance(items, str):
        items = re.split(r"[\s,;]+", items)
    wl = sorted({re.sub(r"[^A-Z0-9]", "", str(x).upper()) for x in items} - {""})
    save_cfg_patch("modules.plates.watchlist", wl, replace=True)
    return jsonify(ok=True, watchlist=wl)


# ---------- test with a file (offline run of main.py's pipeline in a separate, low-priority process) ----------
import sys
import tempfile
import uuid

TEST_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".mp4", ".avi", ".mov", ".mkv", ".m4v", ".webm"}
TEST_ROOT = Path(os.environ.get("PMC_TEST_DIR", Path(tempfile.gettempdir()) / "pi-motion-cam-tests"))
_tests = {}  # id -> Popen


def test_dir(tid):
    if not re.fullmatch(r"[0-9a-f]{12}", tid or ""):
        abort(404)
    d = TEST_ROOT / tid
    if not d.is_dir():
        abort(404)
    return d


def _running():
    return [t for t, p in _tests.items() if p.poll() is None]


def _cleanup(keep=5):
    if not TEST_ROOT.exists():
        return
    runs = sorted((d for d in TEST_ROOT.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)
    for d in runs[keep:]:
        if d.name not in _running():
            shutil.rmtree(d, ignore_errors=True)


@app.route("/api/test", methods=["POST"])
@auth
def api_test_start():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="Choose an image or video file"), 400
    ext = Path(f.filename).suffix.lower()
    if ext not in TEST_EXT:
        return jsonify(error=f"Unsupported file type {ext or '?'} (use jpg/png/mp4/avi/mov/mkv/webm)"), 400
    if _running():
        return jsonify(error="A test is already running — wait for it or stop it"), 409
    tid = uuid.uuid4().hex[:12]
    d = TEST_ROOT / tid
    d.mkdir(parents=True)
    src = d / ("input" + ext)  # never trust the uploaded filename for paths
    f.save(src)
    display = re.sub(r"[^\w .\-]", "_", Path(f.filename).name)[:80]
    (d / "meta.json").write_text(json.dumps({"name": display, "size": src.stat().st_size, "started": time.time()}))
    frames = max(1, min(100, request.form.get("frames", 10, type=int)))
    cmd = [os.environ.get("PMC_PYTHON", sys.executable), str(Path(__file__).resolve().parent.parent / "main.py"), "--source", str(src), "--out", str(d / "out"), "--frames", str(frames)]
    if request.form.get("telegram") in ("1", "true", "on"):
        cmd.append("--telegram")
    if shutil.which("nice"):
        cmd = ["nice", "-n", "15"] + cmd
    if shutil.which("ionice"):
        cmd = ["ionice", "-c", "3"] + cmd
    log = open(d / "log.txt", "w")
    _tests[tid] = subprocess.Popen(cmd, cwd=BASE, stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, PMC_CONFIG=str(CONFIG)))
    _cleanup()
    return jsonify(id=tid, name=display)


@app.route("/api/test/<tid>")
@auth
def api_test_status(tid):
    d = test_dir(tid)
    out = d / "out"
    p = _tests.get(tid)
    running = bool(p and p.poll() is None)
    meta = json.loads((d / "meta.json").read_text())
    st = {}
    try:
        st = json.loads((out / "live" / "status.json").read_text())
    except (OSError, ValueError):
        pass
    res = None
    if (out / "result.json").exists():
        res = json.loads((out / "result.json").read_text())
        for e in res.get("events", []):
            e["snapshot"] = Path(e["snapshot"]).name if e.get("snapshot") else ""
            e["source"] = "file:" + meta["name"]
    log_tail = (d / "log.txt").read_text()[-3000:] if (d / "log.txt").exists() else ""
    rc = p.poll() if p else None
    return jsonify(id=tid, name=meta["name"], running=running, returncode=rc, progress=st.get("progress"),
                   counts=st.get("counts"), result=res, log=log_tail,
                   failed=(not running and res is None) or (rc not in (None, 0)))


@app.route("/api/test/<tid>/stop", methods=["POST"])
@auth
def api_test_stop(tid):
    test_dir(tid)
    p = _tests.get(tid)
    if p and p.poll() is None:
        p.terminate()
    return jsonify(ok=True)


@app.route("/api/test/<tid>/stream.mjpg")
@auth
def api_test_stream(tid):
    d = test_dir(tid)
    live = d / "out" / "live" / "live.jpg"

    def gen():
        last, idle = None, 0
        while idle < 50:
            try:
                mt = live.stat().st_mtime
                if mt != last:
                    last, idle = mt, 0
                    data = live.read_bytes()
                    yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n"
            except OSError:
                pass
            p = _tests.get(tid)
            if not (p and p.poll() is None):
                idle += 10  # finished: send the last frame, then end the stream soon
            time.sleep(0.1)
            idle += 1
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame", headers={"Cache-Control": "no-store"})


@app.route("/api/test/<tid>/last.jpg")
@auth
def api_test_last(tid):
    p = test_dir(tid) / "out" / "live" / "live.jpg"
    return send_file(p) if p.exists() else (placeholder_jpeg("No frame yet"), 200, {"Content-Type": "image/jpeg"})


@app.route("/api/test/<tid>/captures/<fn>")
@auth
def api_test_capture(tid, fn):
    return send_file(safe_file(test_dir(tid) / "out" / "captures", fn))


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=None)
    ap.add_argument("--port", type=int, default=None)
    a = ap.parse_args()
    w = wcfg()
    host, port = a.host or w.get("host", "0.0.0.0"), a.port or int(w.get("port", 8080))
    print(f"Pi Motion Cam dashboard: http://{lan_ip()}:{port}", flush=True)
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=8)
    except ImportError:
        app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
