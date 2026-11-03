# Pi Motion Cam: modular smart camera (Raspberry Pi 5 + browser)

A smart camera made of separate modules that you switch on one at a time: attendance, in/out counting, restricted areas, fall and fight detection, farm/perimeter intruders, and more.
It comes in two versions with the same modules:

- **Raspberry Pi 5** with a Camera Module (Python + OpenCV, runs 24/7 as a service)
- **Browser web app** at **https://vibhvesh.github.io/pi-motion-cam/**. It runs on a phone or laptop with all processing done locally, and is handy for trying modules and drawing zones.

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

## Web app

Open https://vibhvesh.github.io/pi-motion-cam/ (it must be HTTPS for camera access) → **Start camera** → switch modules on in the **Modules** tab.
- Tap a module to see its settings, its live stats and its last 5 events. To draw a line or zone, tap **Draw**, then tap points on the video.
- **Events** shows the unified log with thumbnails and has CSV export. **Summary** shows today's numbers, exports JSON or CSV, and sends to Telegram (optionally every day at a set time).
- **Settings** covers detection confidence, motion sensitivity, detection rate, night mode (brightens frames and lowers the threshold), Telegram, and config export/import.
- **Export Pi config (YAML)** turns the lines, zones and settings you made in the web app into the `modules:` section of the Pi `config.yaml`.
- Performance: the object detector is throttled (fast while something moves, slow when idle). Pose runs only when a pose module is on **and** a person is in view (≤ 3 people, ~4/s), and never blocks detection. Faces run at ≤ 2/s.
- All models (TF.js, COCO-SSD, MoveNet, face-api) are served from this site. tfjs picks WebGL, then WASM, then CPU. Append `?backend=wasm` or `?backend=cpu` to the URL to force one.

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

The installer clones the repo to `~/pi-motion-cam` and creates a venv (`--system-site-packages`, so apt's picamera2/OpenCV are visible).

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
  fall: { enabled: true, down_seconds: 5 }
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
  To label one, rename and move it, e.g. `mv unknown_faces/unknown_20261103_191502_1.jpg known_faces/alice_3.jpg`. `known_faces/` is re-scanned automatically, so there's no restart.

### 6. Output files
| Path | Contents |
|---|---|
| `events/YYYY-MM-DD.csv` | Unified event log: timestamp, module, type, severity, message, track_id, snapshot |
| `captures/` | Annotated snapshots (boxes, IDs, lines, zones) for every event, plus face crops |
| `attendance/YYYY-MM-DD.csv` | Attendance |
| `summaries/YYYY-MM-DD.json` | Daily summary |
| `plates/YYYY-MM-DD.csv` | Number plates: plate, IN/OUT, time, confidence, snapshot |

### 7. Autostart service
`install.sh` generates `pi-motion-cam.local.service` with your user and path filled in:
```bash
sudo cp pi-motion-cam.local.service /etc/systemd/system/pi-motion-cam.service   # add Telegram env lines if you use env vars
sudo systemctl daemon-reload
sudo systemctl enable --now pi-motion-cam
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
docs/                   the web app (GitHub Pages): js/core.js, js/ui.js, js/modules/*.js
```
