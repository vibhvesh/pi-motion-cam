/* 1. Attendance — face recognition (face-api.js), enroll from camera or photos, unknown-face labeling queue, IN/OUT log */
(() => {
  const { $, LS, esc, S } = SC;
  let FA = null, ready = false, loading = null, busy = false, lastRun = 0, lastFaces = [];
  let faces = LS.get('faces', []);           // [{name, desc, thumb}]
  let unknowns = LS.get('unknowns', []);     // [{id, desc, thumb, firstSeen, lastSeen, count}]
  let att = LS.get('attendance', []);        // [{name, in, out}]
  const MATCH = 0.55, DEDUPE = 0.5, UMAX = 20;
  const saveFaces = () => { if (!LS.set('faces', faces)) { faces.forEach(f => delete f.thumb); LS.set('faces', faces); } };
  const saveUnk = () => { if (!LS.set('unknowns', unknowns)) { unknowns = unknowns.slice(-10); LS.set('unknowns', unknowns); } };
  const saveAtt = () => LS.set('attendance', att.slice(-2000));
  const opts = (size = 320) => new FA.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: 0.45 });

  const M = SC.register({
    id: 'attendance', name: 'Attendance (faces)', icon: '🧑‍💼', needsFaces: true,
    desc: 'Recognizes enrolled faces and logs IN (first seen) / OUT (last seen) times. Unknown faces go into a labeling queue. Loads ~7 MB of face models when enabled.',
    defaults: { gap: 30, cooldown: 10 },
    fields: [{ k: 'gap', label: 'New IN row after absence of (min)', type: 'range', min: 1, max: 240, step: 1 }],
    onEnable() { load(); },
    onDetect(F) {
      if (!ready || busy || !F.people.length || F.now - lastRun < 500) return;
      lastRun = F.now; busy = true;
      recognize().catch(e => console.warn('faces', e)).finally(() => busy = false);
    },
    draw(c) {
      for (const f of lastFaces) if (performance.now() - f.t < 1500) {
        const b = f.box; c.strokeStyle = f.name === 'Unknown' ? '#f7768e' : '#7aa2f7'; c.strokeRect(b.x, b.y, b.width, b.height);
        c.fillStyle = c.strokeStyle; c.fillText(f.label, b.x, b.y - 5);
      }
    },
    stats() {
      const today = new Date().toDateString(), rows = att.filter(a => new Date(a.in).toDateString() === today);
      return { 'People today': new Set(rows.filter(r => !r.name.startsWith('Unknown')).map(r => r.name)).size, 'Unknown waiting': unknowns.length, Enrolled: new Set(faces.map(f => f.name)).size };
    },
    panel(el) {
      el.innerHTML = `
        <div class="err" id="faceErr" hidden></div><button id="faceRetry" hidden>Retry loading face models</button>
        <div class="row"><input id="enrollName" placeholder="Name"><button id="enrollBtn">Enroll from camera</button></div>
        <label class="hint">Bulk enroll (up to 10 photos). Uses the name above, or the filename prefix if blank (alice_1.jpg → alice).
          <input type="file" id="bulkFiles" accept="image/*" multiple></label>
        <div id="bulkResults"></div>
        <div id="unkCard" hidden><h4>⚠️ Unknown faces — needs label</h4><datalist id="knownNames"></datalist><div id="unkList"></div></div>
        <h4>Enrolled people</h4><div id="faceList"></div>
        <h4>Attendance</h4>
        <div class="tablewrap"><table><thead><tr><th>Name</th><th>IN</th><th>OUT</th></tr></thead><tbody id="attBody"></tbody></table></div>
        <div class="row"><button id="attCsv">Export CSV</button><button id="attClear">Clear</button></div>`;
      $('faceRetry').onclick = () => load();
      $('enrollBtn').onclick = enrollCam;
      $('bulkFiles').onchange = bulk;
      $('attCsv').onclick = exportCsv;
      $('attClear').onclick = () => { if (confirm('Clear attendance log?')) { att = []; saveAtt(); renderAtt(); } };
      renderFaces(); renderUnk(); renderAtt();
    },
  });
  M.unknownCount = () => unknowns.length;
  M.attendance = () => att;

  async function load() {
    if (ready) return true; if (loading) return loading;
    const err = $('faceErr'); if (err) err.hidden = true; $('faceRetry') && ($('faceRetry').hidden = true);
    SC.status('Loading face models…');
    loading = (async () => {
      try {
        await SC.initBackend();
        try { FA = await import(new URL(SC.PATHS.faceJs, location.href).href); } catch (e) { throw new Error('could not load face-api: ' + (e?.message || e)); }
        await FA.nets.tinyFaceDetector.loadFromUri(SC.PATHS.face);
        await FA.nets.faceLandmark68Net.loadFromUri(SC.PATHS.face);
        await FA.nets.faceRecognitionNet.loadFromUri(SC.PATHS.face);
        ready = true; SC.status((S.running ? 'Running' : 'Ready') + ' · faces on · ' + S.backend); return true;
      } catch (e) {
        const msg = `Face model load failed [${S.backend || 'no backend'}]: ${e?.message || e}`; console.error(e); SC.status(msg);
        if ($('faceErr')) { $('faceErr').textContent = msg; $('faceErr').hidden = false; $('faceRetry').hidden = false; }
        return false;
      } finally { loading = null; }
    })();
    return loading;
  }

  function thumb(src, box, sx = 1, sy = 1) {
    const c = document.createElement('canvas'); c.width = c.height = 64; const p = box.width * 0.2;
    c.getContext('2d').drawImage(src, (box.x - p) * sx, (box.y - p) * sy, (box.width + 2 * p) * sx, (box.height + 2 * p) * sy, 0, 0, 64, 64);
    return c.toDataURL('image/jpeg', 0.7);
  }

  async function recognize() {
    const res = await FA.detectAllFaces(S.video, opts()).withFaceLandmarks().withFaceDescriptors();
    const sx = S.W / S.video.videoWidth, now = performance.now();
    lastFaces = res.map(r => {
      let best = 'Unknown', bd = MATCH;
      for (const f of faces) { const d = FA.euclideanDistance(r.descriptor, f.desc); if (d < bd) { bd = d; best = f.name; } }
      const b = r.detection.box, box = { x: b.x * sx, y: b.y * sx, width: b.width * sx, height: b.height * sx };
      let label = best;
      if (best === 'Unknown' && r.detection.score > 0.6) { const id = noteUnknown(r.descriptor, b); if (id) label = 'Unknown ' + id; }
      return { name: best, label, box, t: now };
    });
    for (const f of lastFaces) if (f.label !== 'Unknown') logAtt(f.label);
  }

  function noteUnknown(desc, box) {
    let best = null, bd = DEDUPE;
    for (const u of unknowns) { const d = FA.euclideanDistance(desc, u.desc); if (d < bd) { bd = d; best = u; } }
    const now = Date.now();
    if (best) { best.lastSeen = now; best.count++; saveUnk(); const n = unkNodes.get(best.id); if (n) n.meta.textContent = `${best.id} · seen ${best.count}× · ${new Date(now).toLocaleTimeString()}`; return best.id; }
    if (unknowns.length >= UMAX) return null;
    const u = { id: 'U' + now.toString(36).slice(-5).toUpperCase(), desc: Array.from(desc), thumb: thumb(S.video, box), firstSeen: now, lastSeen: now, count: 1 };
    unknowns.push(u); saveUnk(); renderUnk();
    M.emit('unknown', `Unknown person (${u.id}) — please label in admin panel`, { severity: 'warning' });
    return u.id;
  }

  function logAtt(name) {
    const now = Date.now(), gap = M.cfg.gap * 60000;
    const last = [...att].reverse().find(a => a.name === name);
    if (last && now - last.out < gap) last.out = now;
    else { att.push({ name, in: now, out: now }); if (!name.startsWith('Unknown')) M.emit('arrival', `${name} arrived (IN)`, {}); }
    saveAtt(); renderAtt();
  }

  async function enrollCam() {
    const name = $('enrollName').value.trim(); if (!name) return alert('Enter a name first');
    if (!S.running) return alert('Start the camera first');
    if (!(await load())) return;
    const r = await FA.detectSingleFace(S.video, opts()).withFaceLandmarks().withFaceDescriptor();
    if (!r) return alert('No face found — face the camera and try again');
    faces.push({ name, desc: Array.from(r.descriptor), thumb: thumb(S.video, r.detection.box) }); saveFaces(); $('enrollName').value = ''; renderFaces();
    SC.toast(`Enrolled ${name} (${faces.filter(f => f.name === name).length} sample(s)) — add 2–3 for accuracy`);
  }

  const nameFromFile = fn => fn.replace(/\.[^.]+$/, '').replace(/[_\-\s]*\(?\d+\)?$/, '').replace(/[_\-]+/g, ' ').trim();
  async function bulk(e) {
    let files = [...e.target.files]; const out = $('bulkResults'); out.innerHTML = ''; if (!files.length) return;
    if (files.length > 10) { out.innerHTML = `<p class="hint">Only the first 10 of ${files.length} photos are used.</p>`; files = files.slice(0, 10); }
    const typed = $('enrollName').value.trim();
    if (!(await load())) { out.innerHTML += '<p class="err">Face models failed to load.</p>'; return; }
    let ok = 0;
    for (const f of files) {
      const row = document.createElement('div'); row.className = 'bres'; const msg = document.createElement('span'); out.appendChild(row);
      const name = typed || nameFromFile(f.name);
      try {
        if (!name) throw new Error('no name');
        const url = URL.createObjectURL(f), im = new Image();
        await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error('cannot decode image')); im.src = url; });
        const th = new Image(); th.src = url; row.append(th, msg); msg.textContent = `${f.name} → ${name}: processing…`;
        const sc = Math.min(1, 1024 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.round(im.naturalWidth * sc); c.height = Math.round(im.naturalHeight * sc); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        const dets = await FA.detectAllFaces(c, opts(608)).withFaceLandmarks().withFaceDescriptors();
        if (!dets.length) throw new Error('no face found');
        const best = dets.reduce((a, b) => a.detection.box.area > b.detection.box.area ? a : b);
        faces.push({ name, desc: Array.from(best.descriptor), thumb: thumb(c, best.detection.box) }); ok++;
        msg.textContent = `${f.name} → ${name}: ✅ ok${dets.length > 1 ? ` (${dets.length} faces, used largest)` : ''}`; row.classList.add('ok');
      } catch (err) { if (!row.contains(msg)) row.appendChild(msg); msg.textContent = `${f.name} → ${name || '?'}: ❌ ${err.message}`; row.classList.add('bad'); }
    }
    saveFaces(); renderFaces(); e.target.value = '';
    out.insertAdjacentHTML('afterbegin', `<p class="hint">${ok} of ${files.length} photos enrolled.</p>`);
  }

  function renderFaces() {
    const el = $('faceList'); if (!el) return;
    const names = [...new Set(faces.map(f => f.name))];
    $('knownNames').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
    el.innerHTML = names.length ? '' : '<p class="hint">No faces enrolled.</p>';
    for (const n of names) {
      const mine = faces.filter(f => f.name === n), d = document.createElement('div'); d.className = 'person';
      const t = mine.find(f => f.thumb); if (t) { const im = new Image(); im.src = t.thumb; d.appendChild(im); }
      const s = document.createElement('span'); s.textContent = `${n} · ${mine.length} photo${mine.length > 1 ? 's' : ''}`; d.appendChild(s);
      const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Delete';
      b.onclick = () => { if (confirm(`Delete ${n}?`)) { faces = faces.filter(f => f.name !== n); saveFaces(); renderFaces(); } };
      d.appendChild(b); el.appendChild(d);
    }
  }
  // Unknown-face queue: keyed, incremental rendering. Each item's <form>/<input> is created ONCE and never
  // rebuilt while it exists, so focus + typed text survive new unknowns arriving and every recognition tick
  // (v6 wiped list.innerHTML on every new unknown, which stole focus/typed text, worst on Edge).
  const unkNodes = new Map(), drafts = {};
  function renderUnk() {
    UI.setBadge?.(unknowns.length);
    const list = $('unkList'); if (!list) return;
    $('unkCard').hidden = !unknowns.length;
    const live = new Set(unknowns.map(u => u.id));
    for (const [id, n] of unkNodes) if (!live.has(id) || !list.contains(n.el)) { n.el.remove(); unkNodes.delete(id); }
    for (const u of unknowns) {
      let n = unkNodes.get(u.id);
      if (!n) {
        const c = document.createElement('div'); c.className = 'unk'; c.dataset.id = u.id;
        const im = new Image(); im.src = u.thumb; im.alt = u.id; c.appendChild(im);
        const info = document.createElement('div'); info.className = 'unkinfo';
        const meta = document.createElement('div'); meta.className = 'hint';
        const form = document.createElement('form'); form.className = 'row unkform'; form.autocomplete = 'off';
        const inp = document.createElement('input'); inp.type = 'text'; inp.name = 'unk_' + u.id; inp.placeholder = 'Type name, press Enter';
        inp.setAttribute('list', 'knownNames'); inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('aria-label', 'Name for ' + u.id);
        inp.value = drafts[u.id] || ''; inp.addEventListener('input', () => { drafts[u.id] = inp.value; });
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = 'Save';
        const ign = document.createElement('button'); ign.type = 'button'; ign.textContent = 'Ignore';
        form.addEventListener('submit', e => { e.preventDefault(); label(u.id, inp.value.trim()); });
        ign.onclick = () => { unknowns = unknowns.filter(x => x.id !== u.id); delete drafts[u.id]; att = att.filter(a => a.name !== 'Unknown ' + u.id); saveAtt(); saveUnk(); renderUnk(); renderAtt(); };
        form.append(inp, save, ign); info.append(meta, form); c.appendChild(info);
        list.prepend(c);   // newest on top, existing nodes untouched
        n = { el: c, meta, inp }; unkNodes.set(u.id, n);
      }
      n.meta.textContent = `${u.id} · seen ${u.count}× · ${new Date(u.lastSeen).toLocaleTimeString()}`;
    }
  }
  function label(id, name) {
    if (!name) { const n = unkNodes.get(id); SC.toast('Enter a name first', 'warning'); n?.inp.focus(); return; }
    const u = unknowns.find(x => x.id === id); if (!u) return;
    faces.push({ name, desc: u.desc, thumb: u.thumb }); saveFaces();
    let n = 0; for (const a of att) if (a.name === 'Unknown ' + id) { a.name = name; n++; }
    saveAtt(); unknowns = unknowns.filter(x => x.id !== id); delete drafts[id]; saveUnk();
    renderFaces(); renderUnk(); renderAtt(); SC.status(`Labeled ${id} as ${name}${n ? ` (${n} attendance row${n > 1 ? 's' : ''} updated)` : ''}`);
  }
  const fmt = t => new Date(t).toLocaleString();
  function renderAtt() {
    const b = $('attBody'); if (!b) return; b.innerHTML = '';
    for (const a of [...att].reverse().slice(0, 100)) { const tr = document.createElement('tr'); for (const v of [a.name, fmt(a.in), fmt(a.out)]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } b.appendChild(tr); }
  }
  function exportCsv() {
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    UI.download(`attendance_${new Date().toISOString().slice(0, 10)}.csv`, 'name,first_seen_in,last_seen_out\n' + att.map(a => [a.name, new Date(a.in).toISOString(), new Date(a.out).toISOString()].map(q).join(',')).join('\n'), 'text/csv');
  }
})();
