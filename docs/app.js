'use strict';
const $ = id => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
const small = document.createElement('canvas'); small.width = 160; small.height = 120;
const sctx = small.getContext('2d', { willReadFrequently: true });
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem(k, JSON.stringify(v)) };
const FACE_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js';
const FACE_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/';

let stream = null, running = false, cocoModel = null, faceReady = false, faceapi = null;
let prevGray = null, lastSnap = 0, lastDet = [], lastFaces = [], busy = false, frameNo = 0;
let counts = LS.get('counts', { in: 0, out: 0 }), track = null;
let faces = LS.get('faces', []);           // [{name, desc:[128 floats]}]
let attendance = LS.get('attendance', []); // [{name, in, out}]
const status = t => $('status').textContent = t;

// ---------- settings ----------
const sliders = { motionThr: v => v + '%', pixThr: v => v, conf: v => v, cool: v => v + 's', linePos: v => Math.round(v * 100) + '%' };
const saved = LS.get('settings', {});
for (const id of ['motionThr', 'pixThr', 'conf', 'cool', 'linePos', 'lineOri', 'inDir', 'gap']) if (saved[id] != null) $(id).value = saved[id];
for (const id of ['personOnly', 'lineOn', 'tgOn']) if (saved[id] != null) $(id).checked = saved[id];
function saveSettings() {
  const s = {}; for (const id of ['motionThr', 'pixThr', 'conf', 'cool', 'linePos', 'lineOri', 'inDir', 'gap']) s[id] = $(id).value;
  for (const id of ['personOnly', 'lineOn', 'tgOn']) s[id] = $(id).checked; LS.set('settings', s);
  for (const k in sliders) $(k + 'Lbl').textContent = sliders[k]($(k).value);
}
document.querySelectorAll('input,select').forEach(e => e.addEventListener('input', saveSettings)); saveSettings();
$('tgToken').value = LS.get('tgToken', ''); $('tgChat').value = LS.get('tgChat', '');
$('tgToken').oninput = e => LS.set('tgToken', e.target.value.trim()); $('tgChat').oninput = e => LS.set('tgChat', e.target.value.trim());

// ---------- camera ----------
$('startBtn').onclick = async () => {
  if (!window.isSecureContext) return alert('Camera requires HTTPS.');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
  } catch (e) { return alert('Camera error: ' + e.message); }
  video.srcObject = stream; await video.play();
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  running = true; $('startBtn').disabled = true; $('stopBtn').disabled = false; $('snapBtn').disabled = false;
  if (faceReady) $('enrollBtn').disabled = false;
  if (!cocoModel) { status('Loading person detector…'); cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' }); }
  status('Running'); loop();
};
$('stopBtn').onclick = () => {
  running = false; stream?.getTracks().forEach(t => t.stop()); stream = null; prevGray = null;
  $('startBtn').disabled = false; $('stopBtn').disabled = true; $('snapBtn').disabled = true; $('enrollBtn').disabled = true; status('Stopped');
};

// ---------- motion ----------
function motion() {
  sctx.drawImage(video, 0, 0, 160, 120);
  const d = sctx.getImageData(0, 0, 160, 120).data, n = 160 * 120, g = new Uint8Array(n);
  for (let i = 0; i < n; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  let changed = 0, sx = 0, sy = 0, minx = 160, miny = 120, maxx = 0, maxy = 0;
  if (prevGray) {
    const thr = +$('pixThr').value;
    for (let i = 0; i < n; i++) if (Math.abs(g[i] - prevGray[i]) > thr) {
      changed++; const x = i % 160, y = (i / 160) | 0; sx += x; sy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  prevGray = g;
  const pct = changed / n * 100;
  return { pct, cx: changed ? sx / changed / 160 : null, cy: changed ? sy / changed / 120 : null, box: changed ? [minx / 160, miny / 120, (maxx - minx) / 160, (maxy - miny) / 120] : null };
}

// ---------- line counting ----------
function updateLine(m, people) {
  if (!$('lineOn').checked) return null;
  let c = null;
  if (people.length) { const p = people.reduce((a, b) => a.bbox[2] * a.bbox[3] > b.bbox[2] * b.bbox[3] ? a : b);
    c = [(p.bbox[0] + p.bbox[2] / 2) / overlay.width, (p.bbox[1] + p.bbox[3] / 2) / overlay.height]; }
  else if (m.pct > +$('motionThr').value && m.cx != null) c = [m.cx, m.cy];
  if (!c) { if (track && performance.now() - track.t > 1500) track = null; return null; }
  const vert = $('lineOri').value === 'v', pos = +$('linePos').value, v = vert ? c[0] : c[1];
  const side = v < pos ? -1 : 1; let ev = null;
  if (track && track.side !== side) {
    const dir = side > track.side ? 'pos' : 'neg', isIn = dir === $('inDir').value;
    isIn ? counts.in++ : counts.out++; LS.set('counts', counts); ev = isIn ? 'IN' : 'OUT';
  }
  track = { side, t: performance.now(), c }; return ev;
}
$('resetCounts').onclick = () => { counts = { in: 0, out: 0 }; LS.set('counts', counts); };

// ---------- main loop ----------
async function loop() {
  if (!running) return;
  frameNo++;
  const m = motion(); const moving = m.pct > +$('motionThr').value;
  if (!busy && (moving || frameNo % 15 === 0)) {
    busy = true;
    try {
      const preds = await cocoModel.detect(video, 10, +$('conf').value);
      lastDet = preds.filter(p => p.class === 'person');
      if (faceReady && lastDet.length && faces.length) lastFaces = await recognize(); else if (!lastDet.length) lastFaces = [];
    } catch (e) { console.warn(e); }
    busy = false;
  }
  const ev = updateLine(m, lastDet);
  draw(m, moving);
  $('motionVal').textContent = m.pct.toFixed(1); $('peopleVal').textContent = lastDet.length;
  $('inVal').textContent = counts.in; $('outVal').textContent = counts.out;
  const now = Date.now();
  if (moving && (!$('personOnly').checked || lastDet.length) && now - lastSnap > +$('cool').value * 1000) { lastSnap = now; snapshot(ev); }
  else if (ev) snapshot(ev);
  requestAnimationFrame(loop);
}

function draw(m, moving) {
  const W = overlay.width, H = overlay.height; octx.clearRect(0, 0, W, H); octx.lineWidth = Math.max(2, W / 320);
  octx.font = `${Math.max(14, W / 45)}px system-ui`;
  if (moving && m.box) { octx.strokeStyle = '#e0af68'; octx.setLineDash([6, 6]); octx.strokeRect(m.box[0] * W, m.box[1] * H, m.box[2] * W, m.box[3] * H); octx.setLineDash([]); }
  for (const p of lastDet) { const [x, y, w, h] = p.bbox; octx.strokeStyle = '#9ece6a'; octx.strokeRect(x, y, w, h);
    octx.fillStyle = '#9ece6a'; octx.fillText(`person ${(p.score * 100) | 0}%`, x + 4, y + 18); }
  for (const f of lastFaces) { const b = f.box; octx.strokeStyle = f.name === 'Unknown' ? '#f7768e' : '#7aa2f7'; octx.strokeRect(b.x, b.y, b.width, b.height);
    octx.fillStyle = octx.strokeStyle; octx.fillText(f.name, b.x, b.y - 6); }
  if ($('lineOn').checked) { const pos = +$('linePos').value; octx.strokeStyle = '#bb9af7'; octx.beginPath();
    if ($('lineOri').value === 'v') { octx.moveTo(pos * W, 0); octx.lineTo(pos * W, H); } else { octx.moveTo(0, pos * H); octx.lineTo(W, pos * H); }
    octx.stroke(); octx.fillStyle = '#bb9af7'; octx.fillText(`IN ${counts.in}  OUT ${counts.out}`, 10, H - 12); }
}

// ---------- snapshots ----------
let snaps = [];
function snapshot(ev) {
  const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
  const x = c.getContext('2d'); x.drawImage(video, 0, 0); x.drawImage(overlay, 0, 0);
  const ts = new Date(); x.fillStyle = 'rgba(0,0,0,.5)'; x.fillRect(0, 0, c.width, 30); x.fillStyle = '#fff'; x.font = '18px system-ui';
  x.fillText(ts.toLocaleString(), 8, 21);
  const names = lastFaces.map(f => f.name).filter(n => n !== 'Unknown');
  const cap = `${ts.toLocaleString()} · ${lastDet.length} person(s)${names.length ? ' · ' + names.join(', ') : ''}${ev ? ' · ' + ev : ''}`;
  c.toBlob(blob => {
    const url = URL.createObjectURL(blob); snaps.unshift(url);
    const fig = document.createElement('figure'); fig.innerHTML = `<a href="${url}" download="motion_${ts.toISOString().replace(/[:.]/g, '-')}.jpg"><img src="${url}"></a><figcaption></figcaption>`;
    fig.querySelector('figcaption').textContent = cap; $('gallery').prepend(fig);
    while ($('gallery').children.length > 60) { URL.revokeObjectURL(snaps.pop()); $('gallery').lastChild.remove(); }
    if ($('tgOn').checked) sendTelegram(blob, 'Motion detected: ' + cap);
  }, 'image/jpeg', 0.85);
}
$('snapBtn').onclick = () => snapshot(null);
$('clearSnaps').onclick = () => { snaps.forEach(URL.revokeObjectURL); snaps = []; $('gallery').innerHTML = ''; };

// ---------- telegram ----------
async function sendTelegram(blob, caption) {
  const t = LS.get('tgToken', ''), chat = LS.get('tgChat', ''); if (!t || !chat) return;
  const fd = new FormData(); fd.append('chat_id', chat); fd.append('caption', caption);
  let method = 'sendMessage'; if (blob) { fd.append('photo', blob, 'motion.jpg'); method = 'sendPhoto'; } else fd.append('text', caption);
  try { const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, { method: 'POST', body: fd }); const j = await r.json(); if (!j.ok) throw new Error(j.description); return true; }
  catch (e) { status('Telegram error: ' + e.message); return false; }
}
$('tgTest').onclick = async () => { if (await sendTelegram(null, 'Pi Motion Cam web: test message ✅')) alert('Sent!'); };

// ---------- faces ----------
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
$('faceOn').onchange = async e => {
  if (!e.target.checked || faceReady) return;
  status('Loading face models…');
  try {
    await loadScript(FACE_CDN); faceapi = window.faceapi;
    await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS), faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS), faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS)]);
    faceReady = true; if (running) $('enrollBtn').disabled = false; status(running ? 'Running (faces on)' : 'Face models ready');
  } catch (err) { status('Face model load failed'); e.target.checked = false; console.error(err); }
};
const faceOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
async function recognize() {
  if (!$('faceOn').checked) return [];
  const res = await faceapi.detectAllFaces(video, faceOpts()).withFaceLandmarks().withFaceDescriptors();
  const out = res.map(r => {
    let best = 'Unknown', bd = 0.55;
    for (const f of faces) { const d = faceapi.euclideanDistance(r.descriptor, f.desc); if (d < bd) { bd = d; best = f.name; } }
    return { name: best, box: r.detection.box };
  });
  out.forEach(f => f.name !== 'Unknown' && logAttendance(f.name));
  return out;
}
$('enrollBtn').onclick = async () => {
  const name = $('enrollName').value.trim(); if (!name) return alert('Enter a name first');
  const r = await faceapi.detectSingleFace(video, faceOpts()).withFaceLandmarks().withFaceDescriptor();
  if (!r) return alert('No face found — face the camera and try again');
  faces.push({ name, desc: Array.from(r.descriptor) }); LS.set('faces', faces); $('enrollName').value = ''; renderFaces();
  alert(`Enrolled ${name} (${faces.filter(f => f.name === name).length} sample(s)). Add 2–3 samples for best accuracy.`);
};
function renderFaces() {
  const names = [...new Set(faces.map(f => f.name))];
  $('faceList').innerHTML = names.length ? '' : '<p class="hint">No faces enrolled.</p>';
  for (const n of names) { const s = document.createElement('span'); s.className = 'face'; s.textContent = `${n} (${faces.filter(f => f.name === n).length})`;
    const b = document.createElement('button'); b.textContent = '✕'; b.onclick = () => { faces = faces.filter(f => f.name !== n); LS.set('faces', faces); renderFaces(); };
    s.appendChild(b); $('faceList').appendChild(s); }
}

// ---------- attendance ----------
function logAttendance(name) {
  const now = Date.now(), gap = +$('gap').value * 60000;
  const last = [...attendance].reverse().find(a => a.name === name);
  if (last && now - last.out < gap) last.out = now; else attendance.push({ name, in: now, out: now });
  LS.set('attendance', attendance); renderAtt();
}
const fmt = t => new Date(t).toLocaleString();
function renderAtt() {
  $('attBody').innerHTML = '';
  for (const a of [...attendance].reverse().slice(0, 100)) { const tr = document.createElement('tr');
    for (const v of [a.name, fmt(a.in), fmt(a.out)]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } $('attBody').appendChild(tr); }
}
$('csvBtn').onclick = () => {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const csv = 'name,first_seen_in,last_seen_out\n' + attendance.map(a => [a.name, new Date(a.in).toISOString(), new Date(a.out).toISOString()].map(q).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `attendance_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
};
$('clearAtt').onclick = () => { if (confirm('Clear attendance log?')) { attendance = []; LS.set('attendance', attendance); renderAtt(); } };
renderFaces(); renderAtt();
