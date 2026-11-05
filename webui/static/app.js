/* Pi Motion Cam dashboard. Inputs are created once and never rebuilt while focused (see web v7 Edge fix). */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (m, err) => { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = m; $('toasts').appendChild(t); setTimeout(() => t.remove(), 4000); };
async function api(url, opt = {}) {
  if (opt.json !== undefined) { opt.body = JSON.stringify(opt.json); opt.headers = { 'Content-Type': 'application/json' }; opt.method = opt.method || 'POST'; }
  const r = await fetch(url, opt);
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.output || r.statusText);
  return j;
}
const saveCfg = (path, value, extra = {}) => api('/api/config', { method: 'PUT', json: { path, value, ...extra } });
let CFG = {};

// ---- tabs ----
const loaders = {};
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(s => s.hidden = s.id !== 't_' + b.dataset.t);
  $('live').src = b.dataset.t === 'live' ? '/stream.mjpg' : '';   // only stream while visible
  loaders[b.dataset.t]?.();
});
$('live').src = '/stream.mjpg';

// ---- modules ----
const GEOM = new Set(['line', 'zones', 'points']);
function fieldHTML(mod, k, v) {
  const id = `f_${mod}_${k}`;
  if (typeof v === 'boolean') return `<label class="chk"><input type="checkbox" id="${id}" data-k="${k}" data-t="bool" ${v ? 'checked' : ''}> ${esc(k)}</label>`;
  if (typeof v === 'number') return `<label>${esc(k)} <input type="number" step="any" id="${id}" data-k="${k}" data-t="num" value="${v}"></label>`;
  if (Array.isArray(v) && v.every(x => typeof x !== 'object')) return `<label>${esc(k)} (comma separated) <input type="text" id="${id}" data-k="${k}" data-t="list" value="${esc(v.join(', '))}"></label>`;
  if (v === null || typeof v === 'object') return `<label>${esc(k)} (JSON) <textarea rows="2" id="${id}" data-k="${k}" data-t="json">${esc(JSON.stringify(v))}</textarea></label>`;
  return `<label>${esc(k)} <input type="text" id="${id}" data-k="${k}" data-t="str" value="${esc(v)}"></label>`;
}
function readFields(box) {
  const out = {};
  for (const el of box.querySelectorAll('[data-k]')) {
    const k = el.dataset.k, t = el.dataset.t;
    if (t === 'bool') out[k] = el.checked;
    else if (t === 'num') out[k] = el.value === '' ? null : Number(el.value);
    else if (t === 'list') out[k] = el.value.split(',').map(s => s.trim()).filter(Boolean);
    else if (t === 'json') { try { out[k] = JSON.parse(el.value); } catch { throw new Error(`${k}: invalid JSON`); } }
    else out[k] = el.value;
  }
  return out;
}
loaders.modules = async () => {
  CFG = await api('/api/config'); const list = $('modList'); list.innerHTML = '';
  for (const [name, c0] of Object.entries(CFG.modules || {})) {
    const c = c0 || {}, d = document.createElement('details'); d.className = 'mod' + (c.enabled ? ' on' : '');
    const keys = Object.keys(c).filter(k => k !== 'enabled' && !GEOM.has(k));
    d.innerHTML = `<summary><b>${esc(name)}</b><label class="chk" onclick="event.stopPropagation()"><input type="checkbox" class="en" ${c.enabled ? 'checked' : ''}> on</label></summary>
      <div class="body">${keys.map(k => fieldHTML(name, k, c[k])).join('')}
      ${Object.keys(c).some(k => GEOM.has(k)) ? '<p class="hint">Lines/zones: edit in the ✏️ Zones tab.</p>' : ''}
      <div class="row"><button class="primary sv">Save</button><button class="svr">Save &amp; restart service</button></div></div>`;
    d.querySelector('.en').onchange = async e => {
      try { await saveCfg(`modules.${name}`, { enabled: e.target.checked }); d.classList.toggle('on', e.target.checked); toast(`${name} ${e.target.checked ? 'enabled' : 'disabled'}`); }
      catch (err) { toast(err.message, 1); e.target.checked = !e.target.checked; }
    };
    const save = restart => async () => { try { await saveCfg(`modules.${name}`, readFields(d.querySelector('.body')), { restart }); toast(`${name} saved${restart ? ', restarting…' : ''}`); } catch (e) { toast(e.message, 1); } };
    d.querySelector('.sv').onclick = save(false); d.querySelector('.svr').onclick = save(true);
    list.appendChild(d);
  }
};

// ---- draw zones/lines ----
const DR = { pts: [] }; const cv = $('drawCv'), cx = cv.getContext('2d');
const geomMods = () => Object.entries(CFG.modules || {}).filter(([, c]) => c && ('line' in c || 'zones' in c)).map(([n]) => n);
function redraw() {
  const img = $('snap'); cv.width = img.naturalWidth || 640; cv.height = img.naturalHeight || 360; const W = cv.width, H = cv.height;
  cx.clearRect(0, 0, W, H); cx.lineWidth = 3; cx.font = '16px sans-serif';
  const c = CFG.modules?.[$('drawMod').value] || {};
  const poly = (p, col, close, label) => { if (!p?.length) return; cx.strokeStyle = cx.fillStyle = col; cx.beginPath(); p.forEach(([x, y], i) => i ? cx.lineTo(x * W, y * H) : cx.moveTo(x * W, y * H)); if (close) cx.closePath(); cx.stroke(); p.forEach(([x, y]) => cx.fillRect(x * W - 4, y * H - 4, 8, 8)); if (label) cx.fillText(label, p[0][0] * W + 4, p[0][1] * H + 18); };
  if (c.line) poly(c.line, '#ff9e64', false, 'line');
  (c.zones || []).forEach(z => poly(z.points, '#f7768e', true, z.name));
  poly(DR.pts, '#9ece6a', $('drawKind').value === 'zone', 'new');
}
function renderGeomList() {
  const name = $('drawMod').value, c = CFG.modules?.[name] || {}, el = $('geomList');
  el.innerHTML = `<p class="hint">${c.line ? 'Line: ' + esc(JSON.stringify(c.line)) + ' <button class="small" id="rmLine">Remove line</button>' : 'No line'}</p>` +
    (c.zones || []).map((z, i) => `<div class="row">🟥 ${esc(z.name)} (${z.points.length} pts) <button class="small" data-rz="${i}">Delete</button></div>`).join('');
  $('rmLine') && ($('rmLine').onclick = async () => { await saveCfg(`modules.${name}.line`, null, { replace: true }); await refreshCfg(); });
  el.querySelectorAll('[data-rz]').forEach(b => b.onclick = async () => { const zs = [...c.zones]; zs.splice(+b.dataset.rz, 1); await saveCfg(`modules.${name}.zones`, zs, { replace: true }); await refreshCfg(); });
}
async function refreshCfg() { CFG = await api('/api/config'); renderGeomList(); redraw(); }
loaders.draw = async () => {
  CFG = await api('/api/config'); const sel = $('drawMod'), cur = sel.value;
  sel.innerHTML = geomMods().map(n => `<option ${n === cur ? 'selected' : ''}>${n}</option>`).join('');
  $('snap').onload = redraw; $('snap').src = '/snapshot.jpg?t=' + Date.now(); renderGeomList();
};
$('drawMod').onchange = () => { DR.pts = []; renderGeomList(); redraw(); }; $('drawKind').onchange = () => { DR.pts = []; redraw(); };
$('drawSnap').onclick = () => { $('snap').src = '/snapshot.jpg?t=' + Date.now(); };
cv.addEventListener('pointerdown', e => {
  const r = cv.getBoundingClientRect(); DR.pts.push([+((e.clientX - r.left) / r.width).toFixed(3), +((e.clientY - r.top) / r.height).toFixed(3)]);
  if ($('drawKind').value === 'line' && DR.pts.length > 2) DR.pts = DR.pts.slice(-2); redraw();
});
$('drawUndo').onclick = () => { DR.pts.pop(); redraw(); }; $('drawClear').onclick = () => { DR.pts = []; redraw(); };
$('drawSave').onclick = async () => {
  const name = $('drawMod').value, c = CFG.modules?.[name] || {}, kind = $('drawKind').value;
  try {
    if (kind === 'line') { if (DR.pts.length !== 2) return toast('A line needs exactly 2 points', 1); await saveCfg(`modules.${name}.line`, DR.pts, { replace: true }); }
    else { if (DR.pts.length < 3) return toast('A zone needs 3+ points', 1); const zs = [...(c.zones || []), { name: $('zoneName').value.trim() || `zone ${(c.zones || []).length + 1}`, points: DR.pts }]; await saveCfg(`modules.${name}.zones`, zs, { replace: true }); }
    DR.pts = []; toast('Saved'); await refreshCfg();
  } catch (e) { toast(e.message, 1); }
};

// ---- attendance ----
const unkNodes = new Map();
async function loadUnknown() {
  const items = await api('/api/unknown'), list = $('unkList'), live = new Set(items.map(i => i.file));
  const b = $('unkBadge'); b.textContent = items.length; b.hidden = !items.length;
  for (const [f, n] of unkNodes) if (!live.has(f)) { n.remove(); unkNodes.delete(f); }
  if (!items.length && !unkNodes.size) list.innerHTML = '<p class="hint">No unknown faces waiting. 🎉</p>'; else list.querySelector('p.hint')?.remove();
  for (const it of [...items].reverse()) {
    if (unkNodes.has(it.file)) continue;           // existing row: untouched (keeps focus + typed text)
    const row = document.createElement('div'); row.className = 'unk';
    row.innerHTML = `<img alt="unknown face" src="/api/unknown/${encodeURIComponent(it.file)}"><form autocomplete="off"><div class="hint" style="width:100%">${esc(it.time)}</div>
      <input type="text" name="person_name" placeholder="Type name, press Enter" list="knownNames" autocomplete="off" spellcheck="false">
      <button class="primary" type="submit">Save</button><button type="button" class="danger">Discard</button></form>`;
    const form = row.querySelector('form'), inp = row.querySelector('input');
    form.onsubmit = async e => {
      e.preventDefault(); const name = inp.value.trim(); if (!name) { inp.focus(); return toast('Enter a name', 1); }
      try { const j = await api(`/api/unknown/${encodeURIComponent(it.file)}/label`, { json: { name } }); toast(`Saved as ${j.name}`); if (j.warning) toast(j.warning, 1); row.remove(); unkNodes.delete(it.file); loadPeople(); loadUnknown(); }
      catch (err) { toast(err.message, 1); }
    };
    row.querySelector('.danger').onclick = async () => { await api(`/api/unknown/${encodeURIComponent(it.file)}`, { method: 'DELETE' }); row.remove(); unkNodes.delete(it.file); loadUnknown(); };
    list.prepend(row); unkNodes.set(it.file, row);
  }
}
async function loadPeople() {
  const ppl = await api('/api/people'), el = $('people');
  $('knownNames').innerHTML = ppl.map(p => `<option value="${esc(p.name)}">`).join('');
  el.innerHTML = ppl.length ? '' : '<p class="hint">Nobody enrolled yet.</p>';
  for (const p of ppl) {
    const d = document.createElement('div'); d.className = 'person';
    d.innerHTML = `<img alt="" src="/api/people/photo/${p.photos[0].split('/').map(encodeURIComponent).join('/')}"><span>${esc(p.name)} · ${p.photos.length} photo(s)</span><button class="danger small">Delete</button>`;
    d.querySelector('button').onclick = async () => { if (!confirm(`Delete ${p.name} and all photos?`)) return; await api(`/api/people/${encodeURIComponent(p.name)}`, { method: 'DELETE' }); loadPeople(); };
    el.appendChild(d);
  }
}
async function loadAtt() {
  const j = await api('/api/attendance' + ($('attDate').value ? '?date=' + $('attDate').value : ''));
  fillDates($('attDate'), j.dates, j.date); $('attCsv').href = '/api/attendance.csv?date=' + j.date;
  $('attBody').innerHTML = j.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.first_seen_in)}</td><td>${esc(r.last_seen_out)}</td></tr>`).join('') || '<tr><td colspan=3 class="hint">No attendance rows.</td></tr>';
}
function fillDates(sel, dates, cur) { const all = [...new Set([cur, ...dates])]; if (sel.options.length !== all.length) sel.innerHTML = all.map(d => `<option ${d === cur ? 'selected' : ''}>${d}</option>`).join(''); }
loaders.att = () => { loadUnknown(); loadPeople(); loadAtt(); };
$('attDate').onchange = loadAtt; $('unkRefresh').onclick = loadUnknown;
$('enrollForm').onsubmit = async e => {
  e.preventDefault(); const fd = new FormData(e.target); $('enRes').textContent = 'Uploading…';
  try { const j = await api('/api/people', { method: 'POST', body: fd }); $('enRes').innerHTML = `${j.ok} of ${j.results.length} photos saved for ${esc(j.name)}<br>` + j.results.map(r => `${esc(r.file)}: ${r.ok ? '✅' : '❌ ' + esc(r.error)}`).join('<br>'); e.target.reset(); loadPeople(); }
  catch (err) { $('enRes').textContent = err.message; }
};

// ---- events ----
async function loadEvents() {
  const q = new URLSearchParams({ date: $('evDate').value || '', module: $('evMod').value, severity: $('evSev').value, q: $('evQ').value });
  if (!$('evDate').value) q.delete('date');
  const j = await api('/api/events?' + q); fillDates($('evDate'), j.dates, j.date); $('evCsv').href = '/api/events.csv?date=' + j.date;
  const sel = $('evMod'), cur = sel.value; sel.innerHTML = '<option value="">All modules</option>' + j.modules.map(m => `<option ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('');
  $('evList').innerHTML = j.rows.map(r => `<div class="ev ${esc(r.severity)}">${r.snapshot ? `<a href="/captures/${encodeURIComponent(r.snapshot)}" target="_blank"><img loading="lazy" src="/captures/${encodeURIComponent(r.snapshot)}" alt=""></a>` : ''}
    <div><b>${esc(r.module)}</b> · ${esc(r.type)} · <span class="hint">${esc(r.timestamp)}</span><br>${esc(r.message)}</div></div>`).join('') || `<p class="hint">No events (${j.total} total that day).</p>`;
}
loaders.events = loadEvents;
['evDate', 'evMod', 'evSev'].forEach(id => $(id).onchange = loadEvents);
let evT; $('evQ').oninput = () => { clearTimeout(evT); evT = setTimeout(loadEvents, 300); };

// ---- plates ----
async function loadPlates() {
  const j = await api('/api/plates' + ($('plDate').value ? '?date=' + $('plDate').value : ''));
  fillDates($('plDate'), j.dates, j.date); $('plCsv').href = '/api/plates.csv?date=' + j.date;
  $('plInside').innerHTML = j.inside.map(r => `<span class="pill">${esc(r.plate)} · ${esc(r.time)}</span> `).join('') || '<p class="hint">None.</p>';
  if (document.activeElement !== $('wl')) $('wl').value = j.watchlist.join(', ');
  $('plBody').innerHTML = j.rows.map(r => `<tr><td>${j.watchlist.includes(r.plate) ? '🚨 ' : ''}${esc(r.plate)}</td><td>${esc(r.direction)}</td><td>${esc(r.time)}</td><td>${esc(r.confidence)}</td></tr>`).join('') || '<tr><td colspan=4 class="hint">No plates.</td></tr>';
}
loaders.plates = loadPlates; $('plDate').onchange = loadPlates;
$('wlForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/plates/watchlist', { json: { watchlist: $('wl').value } }); toast('Watchlist saved'); loadPlates(); } catch (err) { toast(err.message, 1); } };

// ---- settings ----
const GLOBAL = [['camera', ['framerate', 'main_size', 'lores_size']], ['motion', ['min_area', 'pixel_threshold']], ['detector', ['type', 'confidence', 'interval_seconds', 'idle_interval_seconds']], ['summary', ['enabled', 'send_time']]];
loaders.settings = async () => {
  CFG = await api('/api/config'); const tg = CFG.events?.telegram || {};
  $('tgOn').checked = !!tg.enabled; $('tgTok').value = tg.bot_token || ''; $('tgChat').value = tg.chat_id || '';
  $('webPw').value = CFG.web?.password || '';
  const el = $('globalCfg'); el.innerHTML = '';
  for (const [sec, keys] of GLOBAL) {
    const c = CFG[sec] || {}, box = document.createElement('div'); box.innerHTML = `<h4>${sec}</h4>` + keys.filter(k => k in c).map(k => fieldHTML(sec, k, c[k])).join('') + '<div class="row"><button class="sv">Save</button><button class="svr">Save &amp; restart</button></div>';
    const save = restart => async () => { try { await saveCfg(sec, readFields(box), { restart }); toast(`${sec} saved`); } catch (e) { toast(e.message, 1); } };
    box.querySelector('.sv').onclick = save(false); box.querySelector('.svr').onclick = save(true); el.appendChild(box);
  }
};
$('tgForm').onsubmit = async e => { e.preventDefault(); try { await saveCfg('events.telegram', { enabled: $('tgOn').checked, bot_token: $('tgTok').value.trim(), chat_id: $('tgChat').value.trim() }); toast('Telegram saved'); } catch (err) { toast(err.message, 1); } };
$('tgTest').onclick = async () => { try { await api('/api/telegram/test', { method: 'POST' }); toast('Test message sent ✅'); } catch (e) { toast('Telegram: ' + e.message, 1); } };
$('webPwSave').onclick = async () => { try { await saveCfg('web', { password: $('webPw').value }); toast('Password saved'); } catch (e) { toast(e.message, 1); } };

// ---- test with file ----
let testId = null, testTimer = null;
async function runTest(fd) {
  $('tRes').innerHTML = ''; $('tProg').textContent = 'Uploading…';
  try {
    const j = await api('/api/test', { method: 'POST', body: fd }); testId = j.id;
    $('tLive').hidden = false; $('tLive').src = `/api/test/${j.id}/stream.mjpg`; $('tStop').hidden = false; $('tRun').disabled = true;
    clearInterval(testTimer); testTimer = setInterval(pollTest, 1000);
  } catch (e) { $('tProg').textContent = '❌ ' + e.message; }
}
async function pollTest() {
  const s = await api('/api/test/' + testId).catch(() => null); if (!s) return;
  const p = s.progress; $('tProg').textContent = `${esc(s.name)} · ` + (p ? `${p.kind} frame ${p.frame}${p.total ? '/' + p.total : ''} · ${p.video_time}s` : 'starting…') + (s.running ? ' · running' : ' · finished');
  $('tLog').textContent = s.log;
  if (s.running) return;
  clearInterval(testTimer); $('tStop').hidden = true; $('tRun').disabled = false; $('tLive').src = `/api/test/${testId}/last.jpg?t=${Date.now()}`;
  if (!s.result) { $('tRes').innerHTML = '<p class="hint">❌ Test failed — see the process log.</p>'; return; }
  const r = s.result, sum = Object.entries(r.summary || {}).map(([m, o]) => `<span class="pill">${esc(m)}: ${esc(Object.entries(o).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', '))}</span>`).join(' ');
  $('tRes').innerHTML = `<h3>Result: ${r.events.length} event(s)</h3><p>${sum || '<span class="hint">No module counts.</span>'}</p>
    ${r.modules.length ? '' : '<p class="hint">No modules are enabled in config.yaml — enable some in 🧩 Modules first.</p>'}` +
    r.events.slice().reverse().map(e => `<div class="ev ${esc(e.severity)}">${e.snapshot ? `<a href="/api/test/${testId}/captures/${encodeURIComponent(e.snapshot)}" target="_blank"><img src="/api/test/${testId}/captures/${encodeURIComponent(e.snapshot)}" alt=""></a>` : ''}
      <div><b>${esc(e.module)}</b> · ${esc(e.type)} · <span class="hint">${esc(e.timestamp)} · source=${esc(e.source)}</span><br>${esc(e.message)}</div></div>`).join('');
}
$('testForm').onsubmit = e => { e.preventDefault(); runTest(new FormData(e.target)); };
$('tStop').onclick = () => testId && api(`/api/test/${testId}/stop`, { method: 'POST' });
const tDrop = $('tDrop');
tDrop.ondragover = e => { e.preventDefault(); tDrop.style.background = '#1d2a3a'; }; tDrop.ondragleave = () => { tDrop.style.background = ''; };
tDrop.ondrop = e => { e.preventDefault(); tDrop.style.background = ''; const f = e.dataTransfer.files[0]; if (!f) return; const fd = new FormData($('testForm')); fd.set('file', f); runTest(fd); };

// ---- system ----
const fmtB = b => (b / 1e9).toFixed(1) + ' GB', fmtUp = s => s == null ? '?' : `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
async function loadStatus() {
  try {
    const s = await api('/api/status'); const p = $('svc'); p.textContent = `${s.service}: ${s.service_state}`; p.className = 'pill ' + (s.service_state === 'active' ? 'ok' : 'bad');
    $('liveInfo').textContent = s.camera_age != null && s.camera_age < 10 ? `Modules: ${(s.camera.modules || []).join(', ') || 'none'} · detector ${s.camera.detector || '-'} · ${s.camera.motion ? 'motion' : 'still'}` : 'No live frames — is the camera service running?';
    $('sys').innerHTML = [['CPU temp', s.cpu_temp != null ? s.cpu_temp.toFixed(1) + ' °C' : '?'], ['Disk free', `${fmtB(s.disk_free)} / ${fmtB(s.disk_total)}`], ['Uptime', fmtUp(s.uptime)],
      ['Load', s.load.map(x => x.toFixed(2)).join(' ')], ['Memory free', s.mem_avail_kb ? (s.mem_avail_kb / 1e6).toFixed(2) + ' GB' : '?'], ['Service', s.service_state], ['Dashboard', s.url], ['Host', s.hostname]]
      .map(([k, v]) => `<div><span class="hint">${k}</span><b>${esc(v)}</b></div>`).join('');
  } catch (e) { $('svc').textContent = 'offline'; }
}
loaders.system = loadStatus;
document.querySelectorAll('[data-svc]').forEach(b => b.onclick = async () => { try { await api('/api/service/' + b.dataset.svc, { method: 'POST' }); toast(`Service ${b.dataset.svc} OK`); } catch (e) { toast(e.message, 1); } setTimeout(loadStatus, 1500); });
$('logBtn').onclick = async () => { const j = await api('/api/logs?n=' + $('logN').value); $('logs').textContent = j.text || '(no logs)'; $('logs').scrollTop = 1e9; };

loadStatus(); setInterval(loadStatus, 10000);
api('/api/config').then(c => CFG = c);
loadUnknown().catch(() => {}); setInterval(() => loadUnknown().catch(() => {}), 15000);
