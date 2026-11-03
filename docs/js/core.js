/* Pi Motion Cam web — core: camera, detection, tracking, pose, event bus, Telegram, module registry. */
'use strict';
const SC = (() => {
  const VERSION = '5';
  const $ = id => document.getElementById(id);
  const LS = {
    get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn('storage', k, e); return false; } },
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PATHS = {
    coco: 'models/coco-v3/model.json',
    movenet: 'models/movenet-v5/model.json',
    face: 'models/face-v3/',
    faceJs: 'vendor/face-api.esm-nobundle.js?v=' + VERSION,
  };
  const ANIMALS = ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'];
  const VEHICLES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle'];

  // ---------- global settings ----------
  const G = Object.assign({
    facing: 'environment', conf: 0.5, motionThr: 1.5, pixThr: 30, night: 'auto', detFast: 150, detIdle: 800,
    tgToken: '', tgChat: '', summaryTime: '21:00', summaryAuto: false, sound: true,
  }, LS.get('sc_global', {}));
  const saveG = () => LS.set('sc_global', G);

  // ---------- state ----------
  const S = {
    running: false, stream: null, video: null, overlay: null, octx: null,
    small: null, sctx: null, SW: 160, SH: 120, prevGray: null, gray: null, rgba: null, mask: null,
    motionPct: 0, motionBox: null, dets: [], tracks: new Map(), nextId: 1,
    coco: null, poseDet: null, poseLoading: null, backend: null, detBusy: false, poseBusy: false, lastDet: 0, lastPose: 0,
    dark: false, brightness: 128, fps: 0, frames: 0, fpsT: 0, edit: null, events: LS.get('sc_events', []), lastSent: {},
  };
  const modules = [];
  const status = t => { $('status').textContent = t; $('status').title = t; };

  // ---------- tfjs backend: webgl -> wasm -> cpu ----------
  let backendP = null;
  function initBackend() {
    if (backendP) return backendP;
    backendP = (async () => {
      const errs = [], forced = new URLSearchParams(location.search).get('backend');
      if (tf.wasm?.setWasmPaths) tf.wasm.setWasmPaths(new URL('vendor/', location.href).href);
      const order = forced ? [forced, ...['webgl', 'wasm', 'cpu'].filter(x => x !== forced)] : ['webgl', 'wasm', 'cpu'];
      for (const b of order) {
        try {
          status('Initialising ' + b + '…');
          if (!(await tf.setBackend(b))) throw new Error('setBackend returned false');
          await tf.ready();
          if (b === 'webgl') tf.tidy(() => tf.ones([2, 2]).add(1).dataSync());
          S.backend = b; return b;
        } catch (e) { errs.push(b + ': ' + (e?.message || e)); }
      }
      throw new Error('No TF backend (' + errs.join('; ') + ')');
    })();
    backendP.catch(() => { backendP = null; });
    return backendP;
  }

  // ---------- geometry helpers ----------
  const geo = {
    inPoly(p, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; },
    side(p, a, b) { return Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])); },
    foot(t) { const [x, y, w, h] = t.box; return [(x + w / 2) / S.W, (y + h) / S.H]; },       // normalized
    center(t) { const [x, y, w, h] = t.box; return [(x + w / 2) / S.W, (y + h / 2) / S.H]; },
    inSchedule(spec, d = new Date()) {
      if (!spec || !spec.trim()) return true;
      const t = d.toTimeString().slice(0, 5);
      return spec.split(',').some(r => { const [a, b] = r.trim().split('-'); if (!a || !b) return false; return a <= b ? (t >= a && t < b) : (t >= a || t < b); });
    },
  };
  Object.defineProperty(S, 'W', { get: () => S.overlay?.width || 640 });
  Object.defineProperty(S, 'H', { get: () => S.overlay?.height || 480 });

  // ---------- tracker (greedy IoU + distance, stable IDs) ----------
  function iou(a, b) { const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])); const i = ix * iy, u = a[2] * a[3] + b[2] * b[3] - i; return u ? i / u : 0; }
  function track(dets, now) {
    const pairs = [], W = S.W;
    for (const [di, d] of dets.entries()) for (const t of S.tracks.values()) {
      if (t.cls !== d.cls) continue;
      const dist = Math.hypot(d.box[0] + d.box[2] / 2 - (t.box[0] + t.box[2] / 2), d.box[1] + d.box[3] / 2 - (t.box[1] + t.box[3] / 2));
      const ov = iou(d.box, t.box); if (dist > 0.25 * W && !ov) continue;
      pairs.push([ov - dist / W, di, t.id]);
    }
    pairs.sort((a, b) => b[0] - a[0]);
    const usedD = new Set(), usedT = new Set();
    const assign = (t, d) => { t.box = d.box; t.score = d.score; t.last = now; t.hist.push([now, t.box[0] + t.box[2] / 2, t.box[1] + t.box[3] / 2, t.box[2], t.box[3]]); if (t.hist.length > 60) t.hist.shift(); d.id = t.id; };
    for (const [, di, tid] of pairs) { if (usedD.has(di) || usedT.has(tid)) continue; usedD.add(di); usedT.add(tid); assign(S.tracks.get(tid), dets[di]); }
    dets.forEach((d, di) => { if (usedD.has(di)) return; const t = { id: S.nextId++, cls: d.cls, box: d.box, first: now, last: now, hist: [], flags: {}, pose: null, poseHist: [] }; S.tracks.set(t.id, t); assign(t, d); });
    for (const [id, t] of S.tracks) if (now - t.last > 2000) S.tracks.delete(id);
    return [...S.tracks.values()].filter(t => t.last === now);
  }

  // ---------- motion + small-frame stats (every frame, cheap) ----------
  function fastFrame() {
    const { sctx, SW, SH } = S;
    sctx.drawImage(S.video, 0, 0, SW, SH);
    const d = sctx.getImageData(0, 0, SW, SH).data, n = SW * SH, g = new Uint8Array(n), m = new Uint8Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; sum += g[i]; }
    let changed = 0, minx = SW, miny = SH, maxx = 0, maxy = 0;
    if (S.prevGray) {
      const thr = G.pixThr;
      for (let i = 0; i < n; i++) if (Math.abs(g[i] - S.prevGray[i]) > thr) { m[i] = 1; changed++; const x = i % SW, y = (i / SW) | 0; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    }
    S.prevGray = g; S.gray = g; S.rgba = d; S.mask = m;
    S.motionPct = changed / n * 100; S.brightness = sum / n;
    S.dark = G.night === 'on' || (G.night === 'auto' && S.brightness < 60);
    S.motionBox = changed ? [minx / SW, miny / SH, (maxx - minx) / SW, (maxy - miny) / SH] : null;
  }
  const moving = () => S.motionPct > G.motionThr;

  // ---------- pose (MoveNet SinglePose Lightning on person crops) ----------
  async function loadPose() {
    if (S.poseDet) return S.poseDet; if (S.poseLoading) return S.poseLoading;
    S.poseLoading = (async () => {
      try {
        await initBackend();
        S.poseDet = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet,
          { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING, modelUrl: PATHS.movenet, enableSmoothing: false });
        toast('Pose model ready'); return S.poseDet;
      } catch (e) { console.error(e); toast('Pose model failed: ' + e.message, 'alert'); return null; } finally { S.poseLoading = null; }
    })();
    return S.poseLoading;
  }
  const cropC = document.createElement('canvas'); cropC.width = cropC.height = 192;
  async function runPose(people, now) {
    if (!S.poseDet || S.poseBusy) return;
    S.poseBusy = true;
    try {
      const cx = cropC.getContext('2d');
      for (const t of people.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]).slice(0, 3)) {
        const [x, y, w, h] = t.box, s = Math.max(w, h) * 1.2, x0 = x + w / 2 - s / 2, y0 = y + h / 2 - s / 2;
        cx.fillStyle = '#000'; cx.fillRect(0, 0, 192, 192);
        cx.drawImage(S.video, x0 * S.vx, y0 * S.vy, s * S.vx, s * S.vy, 0, 0, 192, 192);
        const r = await S.poseDet.estimatePoses(cropC);
        if (r[0]) { t.pose = r[0].keypoints.map(k => ({ x: x0 + k.x / 192 * s, y: y0 + k.y / 192 * s, s: k.score ?? 0 })); t.poseHist.push([now, t.pose]); if (t.poseHist.length > 20) t.poseHist.shift(); }
      }
    } catch (e) { console.warn('pose', e); } finally { S.poseBusy = false; }
  }
  function torsoAngle(kp) {
    if (!kp) return null; const [ls, rs, lh, rh] = [kp[5], kp[6], kp[11], kp[12]];
    if (Math.min(ls.s, rs.s, lh.s, rh.s) < 0.3) return null;
    const sx = (ls.x + rs.x) / 2, sy = (ls.y + rs.y) / 2, hx = (lh.x + rh.x) / 2, hy = (lh.y + rh.y) / 2;
    return Math.atan2(Math.abs(hx - sx), Math.abs(hy - sy) + 1e-6) * 180 / Math.PI;
  }

  // ---------- detection tick ----------
  const nightC = document.createElement('canvas'), nightX = nightC.getContext('2d');
  async function detectTick(now) {
    S.detBusy = true;
    try {
      let src = S.video;
      if (S.dark) { // night-friendly: brighten + boost contrast before detection
        nightC.width = S.video.videoWidth; nightC.height = S.video.videoHeight;
        nightX.filter = 'brightness(1.8) contrast(1.4)'; nightX.drawImage(S.video, 0, 0); src = nightC;
      }
      const minConf = S.dark ? G.conf * 0.75 : G.conf;
      const preds = await S.coco.detect(src, 20, Math.min(minConf, 0.3));
      const dets = preds.map(p => ({ cls: p.class, score: p.score, box: [p.bbox[0] / S.vx, p.bbox[1] / S.vy, p.bbox[2] / S.vx, p.bbox[3] / S.vy] }))
        .filter(d => d.score >= (d.cls === 'person' ? minConf : minConf * 0.9));
      S.dets = dets;
      const tracks = track(dets, now);
      const people = tracks.filter(t => t.cls === 'person');
      const wantPose = modules.some(m => m.cfg.enabled && m.needsPose);
      if (wantPose && people.length) { if (!S.poseDet) loadPose(); else if (!S.poseBusy && now - S.lastPose > 250) { S.lastPose = now; runPose(people, now); } } // concurrent: never blocks detection
      const F = { now, tracks, people, dets, moving: moving(), dark: S.dark };
      for (const m of modules) if (m.cfg.enabled && m.onDetect) { try { m.onDetect(F); } catch (e) { console.error(m.id, e); } }
    } catch (e) { console.error('detect', e); status('Detection error: ' + e.message); }
    S.detBusy = false;
  }

  // ---------- main loop ----------
  function loop() {
    if (!S.running) return;
    const now = performance.now();
    S.frames++; if (now - S.fpsT > 1000) { S.fps = S.frames; S.frames = 0; S.fpsT = now; }
    fastFrame();
    for (const m of modules) if (m.cfg.enabled && m.onFast) { try { m.onFast(S, now); } catch (e) { console.error(m.id, e); } }
    const active = moving() || S.tracks.size > 0;
    if (S.coco && !S.detBusy && now - S.lastDet > (active ? G.detFast : G.detIdle)) { S.lastDet = now; detectTick(now); }
    draw();
    $('liveStats').textContent = `${S.fps} fps · motion ${S.motionPct.toFixed(1)}% · ${S.dets.length} obj · ${S.backend || ''}${S.dark ? ' · 🌙 night' : ''}`;
    requestAnimationFrame(loop);
  }

  function draw() {
    const { octx: c } = S, W = S.W, H = S.H;
    c.clearRect(0, 0, W, H);
    c.lineWidth = Math.max(2, W / 320); c.font = `${Math.max(13, W / 48)}px system-ui`;
    for (const d of S.dets) {
      const [x, y, w, h] = d.box, col = d.cls === 'person' ? '#9ece6a' : ANIMALS.includes(d.cls) ? '#e0af68' : VEHICLES.includes(d.cls) ? '#7dcfff' : '#c0caf5';
      c.strokeStyle = col; c.strokeRect(x, y, w, h); c.fillStyle = col;
      c.fillText(`${d.cls} #${d.id} ${(d.score * 100) | 0}%`, x + 3, Math.max(14, y - 4));
    }
    for (const t of S.tracks.values()) if (t.pose && t.cls === 'person' && performance.now() - t.last < 600) drawPose(c, t.pose);
    for (const m of modules) if (m.cfg.enabled && m.draw) { try { m.draw(c, W, H); } catch (e) { console.error(m.id, e); } }
    if (S.edit) drawEdit(c, W, H);
  }
  const BONES = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];
  function drawPose(c, kp) {
    c.strokeStyle = '#bb9af7';
    for (const [a, b] of BONES) if (kp[a].s > 0.3 && kp[b].s > 0.3) { c.beginPath(); c.moveTo(kp[a].x, kp[a].y); c.lineTo(kp[b].x, kp[b].y); c.stroke(); }
  }
  function drawPoly(c, pts, W, H, color, label, closed = true) {
    if (!pts?.length) return;
    c.strokeStyle = color; c.fillStyle = color + '33'; c.beginPath();
    pts.forEach(([x, y], i) => i ? c.lineTo(x * W, y * H) : c.moveTo(x * W, y * H));
    if (closed) { c.closePath(); c.fill(); } c.stroke();
    if (label) { c.fillStyle = color; c.fillText(label, pts[0][0] * W + 4, pts[0][1] * H + 16); }
  }
  function drawEdit(c, W, H) {
    const e = S.edit; drawPoly(c, e.pts, W, H, '#ffffff', null, false);
    c.fillStyle = '#fff'; for (const [x, y] of e.pts) { c.beginPath(); c.arc(x * W, y * H, Math.max(5, W / 120), 0, 7); c.fill(); }
  }

  // ---------- geometry editor (touch friendly) ----------
  function startEdit(m, kind, done) {
    S.edit = { m, kind, pts: [], done };
    $('editBar').hidden = false;
    $('editMsg').textContent = kind === 'line' ? `${m.name}: tap 2 points for the line` : `${m.name}: tap the zone corners (3+), then Done`;
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function finishEdit(ok) {
    const e = S.edit; S.edit = null; $('editBar').hidden = true;
    if (ok && e && ((e.kind === 'line' && e.pts.length === 2) || (e.kind === 'zone' && e.pts.length >= 3))) e.done(e.pts.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]));
    else if (ok) toast(e?.kind === 'line' ? 'A line needs 2 points' : 'A zone needs at least 3 points', 'warning');
  }
  function overlayPoint(ev) {
    const r = S.overlay.getBoundingClientRect(), W = S.W, H = S.H, sc = Math.min(r.width / W, r.height / H);
    const ox = r.left + (r.width - W * sc) / 2, oy = r.top + (r.height - H * sc) / 2;
    return [Math.min(1, Math.max(0, (ev.clientX - ox) / sc / W)), Math.min(1, Math.max(0, (ev.clientY - oy) / sc / H))];
  }

  // ---------- event bus ----------
  const snapC = document.createElement('canvas');
  function snapshot(maxW = 960) {
    if (!S.video?.videoWidth) return null;
    const sc = Math.min(1, maxW / S.video.videoWidth); snapC.width = S.video.videoWidth * sc; snapC.height = S.video.videoHeight * sc;
    const x = snapC.getContext('2d'); x.drawImage(S.video, 0, 0, snapC.width, snapC.height); x.drawImage(S.overlay, 0, 0, snapC.width, snapC.height);
    x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, 0, snapC.width, 24); x.fillStyle = '#fff'; x.font = '15px system-ui'; x.fillText(new Date().toLocaleString(), 6, 17);
    return snapC;
  }
  function thumbOf(c, w = 160) { const t = document.createElement('canvas'); t.width = w; t.height = Math.round(c.height * w / c.width); t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); return t.toDataURL('image/jpeg', 0.6); }
  function saveEvents() {
    S.events = S.events.slice(-500);
    const copy = S.events.map((e, i) => i < S.events.length - 60 ? { ...e, thumb: null } : e);
    if (!LS.set('sc_events', copy)) LS.set('sc_events', copy.map(e => ({ ...e, thumb: null })));
  }
  function emit(m, type, msg, opt = {}) {
    const snap = opt.canvas || snapshot();
    const ev = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t: Date.now(), module: m.id, type, msg, sev: opt.severity || 'info', track: opt.trackId ?? null, thumb: snap ? thumbOf(snap) : null };
    S.events.push(ev); saveEvents();
    m.counts[type] = (m.counts[type] || 0) + 1; saveCounts(m);
    toast(`${m.icon} ${msg}`, ev.sev);
    if (ev.sev === 'alert') { if (G.sound) beep(); navigator.vibrate?.(200); }
    UI.onEvent?.(ev, m);
    const key = m.id + ':' + type, cd = (m.cfg.cooldown ?? 30) * 1000;
    if (m.cfg.telegram && G.tgToken && G.tgChat && Date.now() - (S.lastSent[key] || 0) >= cd) {
      S.lastSent[key] = Date.now();
      const cap = `${m.icon} [${m.name}] ${msg}\n${new Date().toLocaleString()}`;
      if (snap) snap.toBlob(b => telegram(cap, b), 'image/jpeg', 0.85); else telegram(cap);
    }
    return ev;
  }
  let actx = null;
  function beep() { try { actx = actx || new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.25); } catch { } }
  async function telegram(text, blob) {
    if (!G.tgToken || !G.tgChat) return false;
    const fd = new FormData(); fd.append('chat_id', G.tgChat);
    let method = 'sendMessage';
    if (blob) { method = 'sendPhoto'; fd.append('photo', blob, 'event.jpg'); fd.append('caption', text.slice(0, 1024)); } else fd.append('text', text.slice(0, 4000));
    try { const r = await fetch(`https://api.telegram.org/bot${G.tgToken}/${method}`, { method: 'POST', body: fd }); const j = await r.json(); if (!j.ok) throw new Error(j.description); return true; }
    catch (e) { toast('Telegram error: ' + e.message, 'warning'); return false; }
  }
  function toast(msg, sev = 'info') {
    const t = document.createElement('div'); t.className = 'toast ' + sev; t.textContent = msg; $('toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), 3500); setTimeout(() => t.remove(), 4000);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  }

  // ---------- module registry ----------
  const COMMON = { enabled: false, telegram: true, cooldown: 30, schedule: '' };
  function register(m) {
    m.cfg = Object.assign({}, COMMON, m.defaults || {}, LS.get('mod_' + m.id, {}));
    const today = new Date().toDateString(), c = LS.get('cnt_' + m.id, {});
    m.counts = c.day === today ? c.counts : {};
    m.save = () => LS.set('mod_' + m.id, m.cfg);
    m.active = () => geo.inSchedule(m.cfg.schedule);
    m.emit = (type, msg, opt) => emit(m, type, msg, opt);
    modules.push(m);
    return m;
  }
  function saveCounts(m) { LS.set('cnt_' + m.id, { day: new Date().toDateString(), counts: m.counts }); }
  function resetCounts(m) { m.counts = {}; saveCounts(m); m.reset?.(); }

  // ---------- camera ----------
  async function start() {
    if (!window.isSecureContext) { alert('Camera needs HTTPS'); return; }
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: G.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) { status('Camera error: ' + e.message); alert('Camera error: ' + e.message); return; }
    S.video.srcObject = S.stream; await S.video.play();
    const vw = S.video.videoWidth, vh = S.video.videoHeight, sc = Math.min(1, 960 / vw);
    S.overlay.width = Math.round(vw * sc); S.overlay.height = Math.round(vh * sc);  // overlay space (<=960px wide) for drawing & geometry
    S.vx = vw / S.overlay.width; S.vy = vh / S.overlay.height;                     // overlay -> video pixel scale
    S.SH = Math.round(S.SW * vh / vw); S.small.width = S.SW; S.small.height = S.SH; S.prevGray = null;
    S.running = true; UI.onRunning?.(true);
    loop();
    if (!S.coco) {
      try { await initBackend(); status('Loading object detector (' + S.backend + ')…'); S.coco = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: PATHS.coco }); }
      catch (e) { status('Detector failed: ' + e.message); return; }
    }
    if (modules.some(m => m.cfg.enabled && m.needsPose)) loadPose();
    status('Running · ' + S.backend);
  }
  function stop() {
    S.running = false; S.stream?.getTracks().forEach(t => t.stop()); S.stream = null; S.dets = []; S.tracks.clear();
    S.octx?.clearRect(0, 0, S.W, S.H); UI.onRunning?.(false); status('Stopped');
  }
  async function switchCamera() { G.facing = G.facing === 'user' ? 'environment' : 'user'; saveG(); if (S.running) { stop(); await start(); } }

  function init() {
    S.video = $('video'); S.overlay = $('overlay'); S.octx = S.overlay.getContext('2d');
    S.small = document.createElement('canvas'); S.sctx = S.small.getContext('2d', { willReadFrequently: true });
    S.overlay.addEventListener('pointerdown', ev => {
      if (!S.edit) return; ev.preventDefault();
      S.edit.pts.push(overlayPoint(ev)); if (!S.running) draw();
      if (S.edit.kind === 'line' && S.edit.pts.length === 2) finishEdit(true);
    });
    $('editDone').onclick = () => finishEdit(true); $('editCancel').onclick = () => finishEdit(false);
    $('editUndo').onclick = () => { S.edit?.pts.pop(); if (!S.running) draw(); };
  }

  return { VERSION, $, LS, esc, G, saveG, S, PATHS, ANIMALS, VEHICLES, geo, torsoAngle, modules, register, resetCounts, emit, telegram, toast, status,
    start, stop, switchCamera, init, startEdit, drawPoly, snapshot, saveEvents, initBackend, loadPose, moving };
})();
const UI = {};
