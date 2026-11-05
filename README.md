# Pi Motion Cam: modular smart camera (Raspberry Pi 5 + browser)

A smart camera made of separate modules that you switch on one at a time: attendance, in/out counting, restricted areas, fall and fight detection, farm/perimeter intruders, and more.
It comes in two versions with the same modules:

- **Raspberry Pi 5** with a Camera Module (Python + OpenCV, runs 24/7 as a service)
- **Browser web app** at **https://vibhvesh.github.io/pi-motion-cam/**. It runs on a phone or laptop with all processing done locally, and is handy for trying modules and drawing zones.

📘 **Operating guide:** see [SOP.md](SOP.md) for the Standard Operating Procedure & best practices (placement, enrollment, checklists, privacy/DPDP, security, troubleshooting).

## Modules

| # | Module | What it does | Web | Pi |
|---|---|---|---|---|
| 1 | **Attendance** | Face recognition with IN/OUT log, bulk photo enrollment and an unknown-face labeling queue | face-api.js | face_recognition (`--face`) |
| 2 | **In/Out counter** | Multi-person tracking with IDs, counts crossings of a virtual line | ✅ | ✅ |
| 3 | **Restricted area** | Polygon zones; alerts when a person's feet enter; optional active hours | ✅ (tap to draw) | ✅ |
| 4 | **Fall detection** | Upright → lying (pose torso angle, or box shape) plus a sudden drop, then stays down N s | MoveNet | box heuristic, MoveNet TFLite optional (`--pose`) |
| 5 | **Fight / violence** ⚠️ *experimental* | 2+ people close together with high limb/motion energy for N s | MoveNet | pose or motion energy |
| 6 | **Perimeter / farm** | Tripwire line and/or zones for people **and animals**; night-friendly | COCO-SSD | MobileNet-SSD (`--dnn`) |
| 7 | **Loitering** | Same person in a zone (or in view) longer than N s | ✅ | ✅ |
| 8 | **Crowd / occupancy** | Live count, alert above a limit | ✅ | ✅ |
| 9 | **Animal detection** | Logs animals (cow, dog, horse, sheep, bird, cat, …) | ✅ | `--dnn` |
| 10 | **Vehicle log** | Logs cars, trucks, buses, motorcycles, bicycles (web) | ✅ | via after_hours / `--dnn` |
| 14 | **Number plates (ANPR)** | Per tracked vehicle: finds the plate in the box, OCRs it, normalizes to Indian format (e.g. `WB06F5977`), logs IN/OUT time + snapshot, "vehicles currently inside" table, watchlist alerts, CSV. Also "read plate from photo". | tesseract.js (vendored) | pytesseract (`--ocr`) |
| 11 | **After-hours activity** | Any person or vehicle during a night window (default 20:00–06:00) | ✅ | ✅ |
| 12 | **Camera tamper** | Covered or dark, blurred (Laplacian sharpness), moved (scene change) | ✅ | ✅ |
| 13 | **Fire / smoke** ⚠️ *experimental* | Color + flicker heuristic. **Not a smoke alarm.** | ✅ | ✅ |
| — | **Motion snapshots** | The original behaviour: snapshot on motion (+ person) | ✅ | ✅ `motion_alert` |
| — | **Daily summary** | Counts per module, attendance, vehicles and alerts; export it, or send it to Telegram at a set time | ✅ | ✅ `summaries/` |

Shared across all modules: a single **event bus**. Every event goes into one log (time, module, type, message, snapshot),
which you can export as CSV. Each module has its own **Telegram on/off switch and cooldown**.

**Not included: PPE (helmet/vest) detection.** No small, openly licensed model that runs in the browser or on the Pi CPU is readily available.

### Number plates: how it works and limits
Vehicles come from the detector (COCO-SSD on web, `--dnn` on Pi). For each new vehicle track the module searches the box for the plate (bright rectangular blob + edge-dense windows), segments the characters, estimates the tilt and deskews, then runs Tesseract (a few throttled attempts per vehicle, keeping the best). Results are normalized to `A-Z0-9` with Indian-format repair (e.g. `O→0` in digit positions, `NB→WB`). Direction: optional IN line; otherwise first read = IN and "not seen for N min" = OUT.
Limits: this is generic OCR, not a trained ANPR model. It needs a fairly close, sharp, daylight, front/rear view (plate ≥ ~100 px wide). Expect misreads at night, at an angle, with motion blur, with fancy fonts or two-line plates. Treat reads as hints and check the snapshot.

### Honest limitations
- **Fight** and **fire/smoke** are hand-written heuristics, not trained classifiers. Expect false alarms (dancing, sports, sunsets, red clothes) and missed events. Never rely on them for safety.
- **Fall** works best with a side or elevated view of the whole body. Lying down on purpose looks like a fall, so tune *Must stay down (s)*.
- The person detectors are lightweight (COCO-SSD lite / HOG / MobileNet-SSD), so small, distant or heavily occluded people and animals get missed. Tracking is simple centroid/IoU matching, so IDs can swap when people cross close together.
- On the Pi, HOG detects **people only**. Animals and vehicles need `--dnn`. MobileNet-SSD (VOC classes) knows bird, cat, cow, dog, horse, sheep, car, bus, motorbike and bicycle, but not bear or elephant.

### v9 tuning (from a 34-clip YouTube test, see `tests/data/test_clips_results.md`)
- **Plates:** crops upscaled so characters are ~32 px tall, CLAHE, edge + white/yellow colour + aspect-ratio plate search, two-line plate mode (top/bottom OCR'd separately), Indian-format reads accepted at any Tesseract confidence, majority vote per vehicle (`votes: 2`), trucks/buses searched too, defaults `min_confidence: 40`, `tries: 8`. Optional `./install.sh --alpr`: `plate_detector: onnx` (YOLOv9-t plate detector, finds plates even when the vehicle detector misses the truck) and `ocr_engine: fast_plate_ocr`.
- **Detector:** `detector.night.confidence: 0.3` at night (night enhancement kept); `track_lost_seconds: 3.5`.
- **Fall:** `down_seconds: 2.5`, `drop_fraction: 0.15`; without pose a box that gets wider than tall, or shrinks below 55 % height while dropping, counts as "down".
- **Fight (experimental):** `energy_threshold: 0.08`.
- **Tamper:** `hold_seconds: 1.5`, `scene_change: 0.3`, plus layout similarity (`structure_change`) and relative blur (`blur_ratio`) against a reference frame.

## Web app

Open https://vibhvesh.github.io/pi-motion-cam/ (it must be HTTPS for camera access) → **Start camera** → switch modules on in the **Modules** tab.
- Tap a module to see its settings, its live stats and its last 5 events. To draw a line or zone, tap **Draw**, then tap points on the video.
- **Events** shows the unified log with thumbnails and has CSV export. **Summary** shows today's numbers, exports JSON or CSV, and sends to Telegram (optionally every day at a set time).
- **Settings** covers detection confidence, motion sensitivity, detection rate, night mode (brightens frames and lowers the threshold), Telegram, and config export/import.
- **Export Pi config (YAML)** turns the lines, zones and settings you made in the web app into the `modules:` section of the Pi `config.yaml`.
- Performance: the object detector is throttled (fast while something moves, slow when idle). Pose runs only when a pose module is on **and** a person is in view (≤ 3 people, ~4/s), and never blocks detection. Faces run at ≤ 2/s.
- All models (TF.js, COCO-SSD, MoveNet, face-api) are served from this site. tfjs picks WebGL, then WASM, then CPU. Append `?backend=wasm` or `?backend=cpu` to the URL to force one.

### Test with a photo or video (web app v9)
Click **📁 Test with file** under the video, or drag and drop a file onto the video area.
- **Images:** run through all enabled modules. *Repeat frames* (default 10) feeds the same frame several times, so tracking, hold timers and occupancy can trigger.
- **Videos** (mp4, webm, and mov where the browser can decode it): play through exactly the same per-frame pipeline as the camera. You get play/pause, seek and 0.25–2× speed.
- You get the same overlays and toasts as live, plus a result panel with objects, counts per module and the events triggered.
- Events are tagged `source=file:<name>` in the Events tab and CSV.
- Telegram is **off** for test files unless you tick *Send Telegram alerts for test files*.
- **📷 Back to camera** returns to the live camera.

## Pi dashboard (local web GUI)

The Pi serves its own management dashboard at **http://&lt;pi-ip&gt;:8080** (the installer prints the exact URL; `http://<hostname>.local:8080` usually works too). Open it from a phone or PC on the same Wi‑Fi/LAN.

| Tab | What you can do |
|---|---|
| 🎥 Live | MJPEG live stream with the same overlays as snapshots (boxes, IDs, lines, zones, face names) |
| 🧩 Modules | Turn each module on/off and edit its settings. Saving writes `config.yaml` (comments kept, `.bak` backup) and the camera service **hot-reloads** it within ~2 s; "Save & restart" restarts the service |
| ✏️ Zones | Tap on a fresh snapshot to draw restricted zones / loitering / occupancy polygons and counter / perimeter / plate lines; delete existing ones |
| 🧑‍💼 Attendance | **Unknown faces queue**: thumbnails from `unknown_faces/` with a name box → Enter or Save moves the photo to `known_faces/<name>/` (re-encoded automatically), or Discard. Bulk-upload enrollment photos for a name, list/delete known people, today's (or any day's) attendance log + CSV export |
| 📜 Events | Unified event log with snapshots; filter by date, module, severity, text; CSV |
| 🚗 Plates | Plate log, vehicles currently inside, watchlist editor, CSV |
| 🧪 Test file | Upload an image or video (jpg/png/mp4/avi/mov/mkv/webm, ≤ 200 MB). It runs through the same `main.py` pipeline (`--source`, `modules/filesource.py` replaces picamera2) in a separate `nice`/`ionice` low-priority process. The live camera keeps running. You see an annotated MJPEG progress view, a result summary, events and annotated snapshots. Outputs go to a temp folder (the last 5 runs are kept), never to your real logs. Telegram is optional and off by default |
| ⚙️ Settings | Telegram bot token / chat id + **Send test**, camera/motion/detector settings, dashboard password |
| 🖥️ System | CPU temperature, disk, memory, load, uptime, start/stop/restart the camera service, view its logs |

- Runs as its own systemd service `pi-motion-cam-web` (so it stays up while the camera service restarts). The installer adds a narrow sudoers rule so it can only start/stop/restart `pi-motion-cam` and read its journal.
- Password: set `web.password` in `config.yaml` (or in Settings, or env `PMC_WEB_PASSWORD`). Empty = no login; anyone on your LAN can then open it. It's plain HTTP: don't port-forward it to the internet.
- The camera process shares frames with the dashboard via `/dev/shm/pi-motion-cam/` (`live.jpg`, `status.json`, ~5 fps, 960 px; tune `web.live_fps` / `live_width`).
- Run it by hand: `./venv/bin/python -m webui.server [--port 8080]`.
- Offline file test from the shell: `./venv/bin/python main.py --source clip.mp4 --out /tmp/test1 [--frames 10] [--telegram]`. This writes `result.json`, plus `events/`, `captures/` and so on under `--out`.
- There is no helmet/vest (PPE) module, so file tests can't check for PPE either.

## Raspberry Pi install

### 1. Camera
Bookworm auto-detects official cameras. Connect the ribbon cable with the Pi off, boot, then test with
`rpicam-hello -t 2000`. If the camera isn't detected, add `camera_auto_detect=1` (or e.g. `dtoverlay=imx708`) to `/boot/firmware/config.txt` and reboot.

### 2. One-line install
```bash
curl -sSL https://raw.githubusercontent.com/vibhvesh/pi-motion-cam/main/get.sh | bash
# with options (any combination):
curl -sSL https://raw.githubusercontent.com/vibhvesh/pi-motion-cam/main/get.sh | bash -s -- --dnn --pose --face
```
| Option | Adds | Size / time |
|---|---|---|
| `--dnn` | MobileNet-SSD detector (people + animals + vehicles) → set `detector.type: mobilenet_ssd` | ~23 MB |
| `--pose` | MoveNet Lightning TFLite + `ai-edge-litert` → set `pose.enabled: true` | ~3 MB |
| `--face` | `face_recognition` (dlib) for attendance | 30+ min build |
| `--ocr` | `tesseract-ocr` + `pytesseract` for the number plate module → set `modules.plates.enabled: true` | ~30 MB |
| `--alpr` | optional `onnxruntime` + open-image-models YOLOv9-t plate detector + fast-plate-ocr (MIT) → `plates.plate_detector: onnx`, `plates.ocr_engine: fast_plate_ocr` | ~60 MB |

The installer clones the repo to `~/pi-motion-cam` and creates a venv (`--system-site-packages`, so apt's picamera2/OpenCV are visible). It installs and starts two systemd services, `pi-motion-cam` (camera) and `pi-motion-cam-web` (dashboard), and prints the dashboard URL at the end. Pass `--no-service` to skip the services.

**Upgrade an existing Pi:** run the same one-liner again (it does `git pull` and then re-runs the installer with your options). Your edited `config.yaml` is kept (the new upstream one is saved as `config.yaml.upstream` so you can compare).

### 3. Configure (`config.yaml`)
Enable modules under `modules:`. Every module accepts `enabled`, `telegram`, `cooldown_seconds` and `active_hours` (`""` = always, or `"22:00-06:00"`, which can wrap past midnight).
Lines and zones use **normalized** coordinates (`[x, y]` as fractions of width/height). The easiest way to get them is to draw in the web app and use *Export Pi config*.

```yaml
detector: { type: mobilenet_ssd }        # or hog (people only, no download)
pose: { enabled: true }                  # after ./install.sh --pose
modules:
  counter:  { enabled: true, line: [[0.5, 0], [0.5, 1]], in_side: negative }
  zone_intrusion:
    enabled: true
    zones: [{ name: store-room, points: [[0.6,0.5],[0.95,0.5],[0.95,0.95],[0.6,0.95]] }]
    active_hours: "19:00-08:00"
  perimeter: { enabled: true, classes: [person, cow, dog, horse, sheep], line: [[0, 0.7], [1, 0.7]] }
  fall: { enabled: true, down_seconds: 2.5 }
```
How the Pi loop works: the lores stream runs motion and tamper checks on every frame. Detection runs every `interval_seconds` while there's activity, or `idle_interval_seconds` when idle, and feeds the tracker, then pose (optional), then the modules, then the event bus.
When it's dark (`detector.night`), frames get a CLAHE contrast boost and a lower confidence threshold.

### 4. Telegram
1. In Telegram, message **@BotFather** → `/newbot` → copy the token.
2. Send any message to your new bot.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id": ...}`.
4. Put both under `events.telegram` in `config.yaml`, or set env vars `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (env wins).

Alerts are sent from a background thread with a per-module/type cooldown. The **daily summary** is written to `summaries/YYYY-MM-DD.json`
and sent at `summary.send_time`. To print today's summary at any time: `./venv/bin/python main.py --summary`.

### 5. Attendance & faces
Put clear photos in `known_faces/`, one or more per person: `alice.jpg`, `alice_1.jpg`, `alice_2.jpg` all count as *alice*. Each photo adds an encoding and matching uses the closest one, so 3–5 photos with different angles and lighting help.
- `attendance/YYYY-MM-DD.csv` gets `name, first_seen_in, last_seen_out`. Seeing someone again within `relog_gap_minutes` extends their OUT time.
- **Labeling unknown people:** each new unrecognized face is cropped to `unknown_faces/unknown_YYYYMMDD_HHMMSS_N.jpg`, and Telegram says *"Unknown person — please label in admin panel"*.
  The easiest way to label one is the dashboard's Attendance tab: type the name and press Enter. By hand, move the file to `known_faces/alice/` (or rename it to `known_faces/alice_3.jpg`). `known_faces/` and its subfolders are re-scanned automatically, so you don't need to restart.

### 6. Output files
| Path | Contents |
|---|---|
| `events/YYYY-MM-DD.csv` | Unified event log: timestamp, module, type, severity, message, track_id, snapshot |
| `captures/` | Annotated snapshots (boxes, IDs, lines, zones) for every event, plus face crops |
| `attendance/YYYY-MM-DD.csv` | Attendance |
| `summaries/YYYY-MM-DD.json` | Daily summary |
| `plates/YYYY-MM-DD.csv` | Number plates: plate, IN/OUT, time, confidence, snapshot |

### 7. Autostart service
`install.sh` installs and enables both services for you. To do it by hand (for example after `--no-service`):
```bash
sudo cp pi-motion-cam.local.service /etc/systemd/system/pi-motion-cam.service   # add Telegram env lines if you use env vars
sudo systemctl daemon-reload
sudo cp pi-motion-cam-web.local.service /etc/systemd/system/pi-motion-cam-web.service
sudo systemctl enable --now pi-motion-cam pi-motion-cam-web
journalctl -u pi-motion-cam -f
```

### Code layout
```
main.py                 camera loop, detector → tracker → pose → modules → event bus
modules/base.py         Module base class, Event, geometry & schedule helpers
modules/tracker.py      multi-object tracker (stable IDs)
modules/detectors.py    HOG / MobileNet-SSD, night enhancement
modules/pose.py         optional MoveNet TFLite
modules/events.py       event bus (CSV, snapshots, Telegram queue) + daily summary
modules/attendance.py   1  faces + unknown queue + attendance CSV
modules/counter.py      2  in/out line counter
modules/zones.py        3 6 7 8 9 11  zone intrusion, perimeter, loitering, occupancy, animal, after-hours
modules/behavior.py     4 5  fall, fight (experimental)
modules/scene.py        12 13  tamper, fire/smoke (experimental)
webui/server.py         Pi dashboard (Flask, port 8080); webui/static/ = its UI
modules/filesource.py   FileSource: image/video replacing picamera2 for --source tests
tests/                  Flask test-client, main.py mock-camera and Playwright tests
docs/                   the web app (GitHub Pages): js/core.js, js/ui.js, js/modules/*.js
```
