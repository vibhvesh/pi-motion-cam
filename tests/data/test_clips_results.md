# Pi Motion Cam: YouTube test dataset and results (2026-11-05)

All clips were run offline with `main.py --source` (FileSource, see `modules/filesource.py`). Environment: OpenCV 4.14 (venv), MobileNet-SSD detector (`detector.type: mobilenet_ssd`, confidence 0.35), no pose model, Telegram off.
- **Plates OCR caveat:** apt `tesseract-ocr` could not be installed on this box (the Debian mirror failed SSL). OCR therefore ran through a `pytesseract` shim backed by **tesserocr 2.x (Tesseract 5.5.3, LSTM)** with the repo's own `eng.traineddata` (`docs/models/tessdata-v6`), using the same `--oem 1 --psm 7` and whitelist as `modules/plates.py`. The real Pi uses Debian's `tesseract-ocr` CLI, so confidences may differ.
- **Ground truth:** estimated by eye from contact sheets and saved snapshots, not frame-by-frame labelling. Treat the numbers as indicative.
- Several vendor demo clips have **burned-in vendor overlays** (boxes and recognised plate text). The OCR may read the overlay label instead of the plate, so plate scores on P01–P03 are optimistic.
- Per-clip configs: `cfg/*.yaml`. Raw outputs: `results/<module>/<clip>/` (`result.json`, `events/`, `captures/`).

## Plates (8 clips, `plates/clips/`)
| Clip | Scenario | Readable plates (est.) | Plate events (min_conf 40) | Correct (verified) | min_conf 0 extra reads |
|---|---|---|---|---|---|
| P01_india_traffic_day | Hyderabad traffic, front view (CC-BY) | ~12 | 1: `AP29BW12` (plate cut at frame edge, partial) | 0 full / 1 partial | `AP10RR0656` (true AP10AR0658: 2 char errors), `L51356` |
| P02_india_overhead_day | high pole, rear plates (some are Brazilian-format plates) | ~8 | 3: `AKANE`, `APV8600`, `AP53175` | 1 (`APV8600`, also printed in the overlay) | `G11D8`, `EF4258` (junk) |
| P03_india_road_level_day | road-level camera | ~6 | 2: `DL7CM3702` ✅, `RJ22TPB0345` (true RJ27PB0345) | 1 | – |
| P04_india_gate_boom_barrier | gate/boom barrier, handheld promo footage | ~4 | 0 | 0 | – |
| P05_india_truck_gate | warehouse truck gate, large yellow plate `WRP 3975` | 1 | 0 (truck not a MobileNet class; detected as bus/car only in some frames) | 0 | `WENRP` (wrong) |
| P06_india_dashcam | Bangalore dashcam, car close ahead | 1–2 | 0 | 0 | – |
| P07_night_lpr_gate | night, headlight glare, non-Indian plates | ~3 | 0 | 0 | – |
| P08_highway_overhead_far | high highway camera, plates tiny | 0 | 0 | 0 (correctly no false plates) | – |
| **Total** | | **~35** | **6 events** | **2 exact + 1 partial (~6–9 %)** | |

Frame-level check (24 sharp frames, `plates/frames/`, diagnosis in `plates/diag/diag.json`):
- MobileNet found vehicles in 19 of 24 frames.
- The plate-candidate step produced crops for most cars, but Tesseract returned empty text for about 70 % of the crops.
- Several correct-looking reads came back with **confidence 0** (Tesseract LSTM with a whitelist), so the `min_confidence` gate threw them away.

### Why reads fail (most to least important)
1. **Plate too small:** plates under about 100 px wide (P01 far cars, P02, P08) are too small for Tesseract; it needs about 20–30 px character height.
2. **Plate localisation:** the Sobel/morphology candidate finder often picks grilles, bumpers, stickers or the vendor's overlay box. The fallback whole-lower-box crop is far too large for `--psm 7`.
3. **Confidence 0 on good reads:** Tesseract LSTM with a whitelist often reports conf 0 for correct text (`TS09EGB5531`, `AP10RR0656`), so `min_confidence` is not a reliable gate on its own.
4. **Detector classes:** MobileNet-SSD (VOC) has **no truck class** and labels SUVs and trucks as `bus` or nothing (P05). Motorbike plates are small and two-line.
5. **Two-line and non-standard plates:** commercial yellow plates, two-line bike plates and foreign formats don't fit `psm 7` or the Indian regex.
6. **Night glare (P07):** headlights blow out the plate; IR or a shutter-speed and exposure change is needed.
7. **Motion blur and compression:** YouTube 720p re-encodes smear the characters.

### Recommendations (plates)
- **Camera placement matters most:** ≤ 30° off-axis, plate ≥ 120–150 px wide, fast shutter, mount at the gate where cars slow down. Do not expect reads from overview or highway cameras.
- In `config.yaml`:
  - `plates.min_confidence: 40` (down from 55), and accept conf-0 reads only when `normalize()` returns an Indian-format match.
  - `tries: 6–8`.
  - `indian_only: true` at Indian sites, to drop junk like `AKANE`/`EF4258`.
  - `detector.confidence: 0.35`.
- **Code improvements (not done here):**
  - Upscale crops so character height is about 32 px.
  - Try `--psm 8/13` and a two-line split for bikes and commercial plates.
  - Use adaptive threshold or CLAHE instead of global equalisation.
  - Majority-vote the plate text across tracker frames instead of keeping the best single read.
  - Map MobileNet `bus` boxes to plate search too.
  - Treat conf 0 as "unknown", not "bad".
- For production-grade Indian ANPR, use a dedicated plate detector (for example a small YOLO plate model) plus an OCR model trained on Indian plates (for example PaddleOCR). Tesseract on Pi CPU is a best-effort baseline.

## Other modules (26 clips, `clips/<module>/`, auto-cut from 2 s to ≤ 62 s)
| Module (config) | Clip (YouTube id) | What's in it (by eye) | Events from our pipeline | Verdict |
|---|---|---|---|---|
| farm-perimeter (perimeter line y=0.6 + animal) | Mjs6xmGH3yw thermal solar farm | people walking at night (thermal) | 1 tripwire (person), 3 animal (bird ×3, false) | weak: thermal persons are mostly missed, and "bird" is a false class |
| | PChpZ_JCtlA dog vs night intruder (8 s) | dog, animal intruder, night | 4 animal (dog 2, bird 2) | partial |
| | j_b2w7MF994 cows walking | herd of cows | 17 tripwire (cow 16, sheep 1), 13 animal | **good** |
| | p48TWK_BTIQ perimeter night demo | screen-recorded vendor UI, tiny people | 0 | miss (unusable source) |
| intruder (zone lower 70 % + motion_alert) | 2MqPJjTc1Bo Ring window peeker | man at window, IR, close | 0 | miss |
| | PDIh1mhkgf8 construction site night | IR, small people far | 0 | miss |
| | k166HLaSznE TP-Link human alarm | IR yard, people mid-distance | 0 | miss |
| | sLXDVCt2Bvs construction site night | IR, trespassers | 4 intrusion | **detected** |
| fall (default down 5 s) | 18aTYzvL9DA Hanwha slip & fall | 1–2 falls | 0 | miss |
| | 5GJbyg-g-0c fall detection | several falls | 0 (1 with tuned config) | weak |
| | fVWjhwXmyds CCTV fall detection | about 5 falls | 0 | miss |
| loitering-crowd (loiter 10 s, occupancy >3) | 3wzyAknUDa4 Las Vegas crowd | very dense crowd, tiny people | 0 (peak 0) | miss: people far too small for MobileNet |
| | BSW8YTh-EuU loitering demo | 1–2 people lingering | 0 (peak 2) | miss: tracks break before 10 s |
| | riI2aIznZDE loitering demo | person lingering | 0 (peak 1) | miss |
| inout-counting (horizontal mid line) | HrHt2ZZqVfM footfall | several people crossing | 1 in / 2 out | under-counts |
| | I-qtfMrOoEo Isarsoft | people crossing | 1 in / 1 out | under-counts |
| | li6E2lYxcO4 occupancy | few people | 1 in / 1 out | plausible |
| fight (experimental, no pose) | 2BhQAk4MZxc snatching scuffle | struggle on the ground | 0 | miss |
| | lTWjOB9cy0g boda boda gang | robbery/assault | 0 | miss |
| | o95Q643QmLs mother fights kidnappers | scuffle | 0 | miss |
| fire-smoke (experimental) | BCxc9ap4NVg fire CCTV | flames | 1 fire | detected |
| | L4rT0xFbd94 AI smoke & fire | mostly vendor UI, small fire | 0 | miss |
| | oarsXZss2L8 CCTV fire detection | flames | 1 fire | detected |
| tamper | FetFl09y3Qg Davantis | camera covered/darkened | 0 | miss |
| | lctnR6CDlIc camera moved | camera repointed | 0 | miss |
| | oh-5sQzm1OI tampering demo | camera moved | 0 | miss |

Tuned fall run (`cfg/fall_tuned.yaml`: down_seconds 2, drop_fraction 0.15, detector conf 0.3) found 1 fall in 5GJbyg-g-0c and still 0 in the other two.

### Recommendations (other modules)
- **Detector is the bottleneck.** MobileNet-SSD at 300×300 misses small, IR or greyscale and lying-down people. On the Pi:
  - Crop or zoom to the area of interest.
  - Mount the camera closer.
  - Lower `detector.confidence` to about 0.3 at night.
  - Keep `detector.night.enhance: true`.
  - Consider a stronger detector (YOLOv8n/NCNN) as a future option.
- **Fall:** enable pose (`./install.sh --pose`, `pose.enabled: true`), set `down_seconds: 2–3` and `drop_fraction: 0.15`, and use a side or angled view. Lying people often lose their MobileNet box, which breaks the aspect-ratio rule.
- **Loitering:** lower `max_seconds` only for testing; in production, fix track stability first (`detector.track_lost_seconds: 3–4`), because tracks break and the timer resets.
- **Counter:** draw the line where people cross one at a time, in an overhead view. Our horizontal mid-line was a guess per clip. Use the dashboard's ✏️ Zones on a snapshot from the real camera.
- **Fight (experimental):** 0/3. Without pose the motion-energy heuristic isn't triggered by these clips. Enable pose and lower `energy_threshold` (for example 0.08) for testing, and don't rely on it.
- **Tamper:** 0/3. Covering or moving the camera in these demos lasts under 3 s, or the scene stays bright. Try `hold_seconds: 1–2` and `scene_change: 0.3`, and test it physically on the real camera.
- **Fire/smoke (experimental):** 2/3. The colour/flicker heuristic catches clear flames, not small or screen-recorded ones. Keep real smoke detectors.
- **Use realistic test data:** many YouTube "demo" clips are vendor screen recordings with overlays, picture-in-picture, or footage filmed off monitors. Record 15–60 s clips from your **own camera position** for real acceptance tests.
