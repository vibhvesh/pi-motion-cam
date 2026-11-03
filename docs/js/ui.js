/* Pi Motion Cam web — UI: tabs, module cards (auto-generated settings), event log, daily summary, settings, Pi config export */
(() => {
  const { $, esc, G, S, modules } = SC;
  const fmtT = t => new Date(t).toLocaleString();
  UI.download = (name, text, type = 'text/plain') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  UI.setBadge = n => { $('unkCount').textContent = n; $('unkBadge').hidden = !n; };
  UI.onRunning = on => { $('startBtn').hidden = on; $('stopBtn').hidden = !on; $('stage').classList.toggle('live', on); };

  // ---------- tabs ----------
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== b.dataset.tab);
    if (b.dataset.tab === 'tabEvents') renderEvents(); if (b.dataset.tab === 'tabSummary') renderSummary();
  });

  // ---------- module cards ----------
  function field(m, f) {
    const v = m.cfg[f.k], id = `f_${m.id}_${f.k}`;
    if (f.type === 'check') return `<label class="chk"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
    if (f.type === 'range') return `<label>${esc(f.label)}: <b id="${id}_v">${v}</b><input type="range" id="${id}" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}"></label>`;
    if (f.type === 'select') return `<label>${esc(f.label)} <select id="${id}">${f.options.map(([o, l]) => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    if (f.type === 'classes') return `<div class="lbl">${esc(f.label)}</div><div class="chips" id="${id}">${f.options.map(o => `<label class="chip"><input type="checkbox" value="${o}" ${v.includes(o) ? 'checked' : ''}>${o}</label>`).join('')}</div>`;
    if (f.type === 'text') return `<label>${esc(f.label)} <input id="${id}" value="${esc(v || '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
    return '';
  }
  function bindField(m, f) {
    const el = $(`f_${m.id}_${f.k}`); if (!el) return;
    const set = val => { m.cfg[f.k] = val; m.save(); };
    if (f.type === 'check') el.onchange = () => set(el.checked);
    else if (f.type === 'range') el.oninput = () => { set(+el.value); $(el.id + '_v').textContent = el.value; };
    else if (f.type === 'select' || f.type === 'text') el.onchange = () => set(el.value);
    else if (f.type === 'classes') el.onchange = () => set([...el.querySelectorAll('input:checked')].map(i => i.value));
  }
  function geomHTML(m) {
    if (!m.geometry) return '';
    let h = '<div class="geo">';
    if (m.geometry.includes('line')) h += `<div class="row"><button data-g="line">✏️ ${m.cfg.line ? 'Redraw' : 'Draw'} line</button>${m.cfg.line ? '<button data-g="noline" class="small">Remove line</button>' : ''}</div>`;
    if (m.geometry.includes('zones')) {
      h += `<div class="zones">${m.cfg.zones.map((z, i) => `<span class="chip">${esc(z.name)} <button data-z="${i}" class="x">✕</button></span>`).join('') || '<span class="hint">No zones yet' + (m.id === 'loiter' || m.id === 'occupancy' ? ' (whole view is used)' : '') + '</span>'}</div>`;
      h += `<div class="row"><button data-g="zone">➕ Draw zone</button></div>`;
    }
    return h + '</div>';
  }
  function buildCard(m) {
    const card = document.createElement('details'); card.className = 'mod' + (m.cfg.enabled ? ' on' : ''); card.id = 'mod_' + m.id;
    card.innerHTML = `<summary><span class="ico">${m.icon}</span><span class="mname">${esc(m.name)}${m.experimental ? ' <em class="exp">experimental</em>' : ''}</span>
      <span class="mstat" id="ms_${m.id}"></span><label class="sw" onclick="event.stopPropagation()"><input type="checkbox" id="en_${m.id}" ${m.cfg.enabled ? 'checked' : ''}><i></i></label></summary>
      <div class="mbody"><p class="hint">${esc(m.desc)}</p><div class="mpanel" id="mp_${m.id}"></div>
      <div id="mg_${m.id}"></div>${(m.fields || []).map(f => field(m, f)).join('')}
      ${m.schedule ? `<label>Active hours <input id="f_${m.id}_schedule" value="${esc(m.cfg.schedule)}" placeholder="always, or e.g. 22:00-06:00"></label>` : ''}
      <div class="common"><label class="chk"><input type="checkbox" id="f_${m.id}_telegram" ${m.cfg.telegram ? 'checked' : ''}> Telegram alerts</label>
      <label>Alert cooldown: <b id="f_${m.id}_cooldown_v">${m.cfg.cooldown}</b>s<input type="range" id="f_${m.id}_cooldown" min="0" max="600" step="5" value="${m.cfg.cooldown}"></label></div>
      <div class="mstats" id="mx_${m.id}"></div>
      <div class="lbl">Recent events <button class="small" data-reset>Reset counts</button></div><div class="mlog" id="ml_${m.id}"></div></div>`;
    $('modList').appendChild(card);
    $('en_' + m.id).onchange = e => { m.cfg.enabled = e.target.checked; m.save(); card.classList.toggle('on', m.cfg.enabled); if (m.cfg.enabled) { m.onEnable?.(); if (m.needsPose && S.running) SC.loadPose(); } };
    for (const f of [...(m.fields || []), { k: 'telegram', type: 'check' }, { k: 'cooldown', type: 'range' }, ...(m.schedule ? [{ k: 'schedule', type: 'text' }] : [])]) bindField(m, f);
    card.querySelector('[data-reset]').onclick = () => { SC.resetCounts(m); renderStats(m); };
    if (m.panel) m.panel($('mp_' + m.id));
    renderGeom(m); renderModLog(m); renderStats(m);
    if (m.cfg.enabled) m.onEnable?.();
  }
  function renderGeom(m) {
    const el = $('mg_' + m.id); if (!el) return; el.innerHTML = geomHTML(m);
    el.querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
      const g = b.dataset.g;
      if (g === 'noline') { m.cfg.line = null; m.save(); return renderGeom(m); }
      if (!S.running) SC.toast('Tip: start the camera first so you can see where to draw', 'warning');
      SC.startEdit(m, g, pts => {
        if (g === 'line') m.cfg.line = pts;
        else m.cfg.zones.push({ name: prompt('Zone name?', `zone ${m.cfg.zones.length + 1}`) || `zone ${m.cfg.zones.length + 1}`, points: pts });
        m.save(); renderGeom(m);
      });
    });
    el.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { m.cfg.zones.splice(+b.dataset.z, 1); m.save(); renderGeom(m); });
  }
  function renderStats(m) {
    const st = m.stats ? m.stats() : {}, el = $('mx_' + m.id);
    if (el) el.innerHTML = Object.entries(st).map(([k, v]) => `<span><b>${esc(v)}</b> ${esc(k)}</span>`).join('');
    const first = Object.entries(st)[0]; $('ms_' + m.id).textContent = first ? `${first[1]}` : '';
  }
  function evRow(e, withModule = true) {
    const m = modules.find(x => x.id === e.module);
    return `<div class="ev ${e.sev}">${e.thumb ? `<img src="${e.thumb}" loading="lazy">` : '<div class="noimg"></div>'}<div><div class="evt">${new Date(e.t).toLocaleTimeString()}${withModule ? ` · ${m ? m.icon + ' ' + esc(m.name) : esc(e.module)}` : ''} · ${esc(e.type)}</div><div>${esc(e.msg)}</div></div></div>`;
  }
  function renderModLog(m) { const el = $('ml_' + m.id); if (el) el.innerHTML = S.events.filter(e => e.module === m.id).slice(-5).reverse().map(e => evRow(e, false)).join('') || '<span class="hint">No events yet.</span>'; }
  UI.onEvent = (e, m) => { renderModLog(m); renderStats(m); $('evCount').textContent = S.events.length; if (!$('tabEvents').hidden) renderEvents(); };
  setInterval(() => { for (const m of modules) if (m.cfg.enabled) renderStats(m); }, 1000);

  // ---------- events tab ----------
  function renderEvents() {
    const f = $('evFilter').value, list = S.events.filter(e => !f || e.module === f).slice(-200).reverse();
    $('evList').innerHTML = list.map(e => evRow(e)).join('') || '<p class="hint">No events yet.</p>';
  }
  $('evFilter').onchange = renderEvents;
  $('evCsv').onclick = () => {
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    UI.download(`events_${new Date().toISOString().slice(0, 10)}.csv`, 'time,module,type,severity,message,track_id\n' + S.events.map(e => [new Date(e.t).toISOString(), e.module, e.type, e.sev, e.msg, e.track].map(q).join(',')).join('\n'), 'text/csv');
  };
  $('evClear').onclick = () => { if (confirm('Clear the event log?')) { S.events = []; SC.saveEvents(); renderEvents(); modules.forEach(renderModLog); $('evCount').textContent = 0; } };

  // ---------- daily summary ----------
  function buildSummary() {
    const today = new Date().toDateString(), ev = S.events.filter(e => new Date(e.t).toDateString() === today);
    const by = {}; for (const e of ev) { by[e.module] ||= {}; by[e.module][e.type] = (by[e.module][e.type] || 0) + 1; }
    return { date: new Date().toISOString().slice(0, 10), generated: new Date().toISOString(), events_total: ev.length, alerts: ev.filter(e => e.sev === 'alert').length,
      modules: Object.fromEntries(modules.filter(m => m.cfg.enabled || by[m.id]).map(m => [m.id, { name: m.name, enabled: m.cfg.enabled, stats: m.stats ? m.stats() : {}, events: by[m.id] || {} }])) };
  }
  function summaryText(s) {
    const lines = [`📊 Daily summary ${s.date}`, `Events: ${s.events_total} (alerts: ${s.alerts})`];
    for (const [id, m] of Object.entries(s.modules)) { const st = Object.entries(m.stats).filter(([k]) => k !== 'Live').map(([k, v]) => `${k} ${v}`).join(', '); lines.push(`• ${modules.find(x => x.id === id)?.icon || ''} ${m.name}: ${st || Object.entries(m.events).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`); }
    return lines.join('\n');
  }
  function renderSummary() {
    const s = buildSummary();
    $('sumBody').innerHTML = `<div class="kpis"><div><b>${s.events_total}</b>events today</div><div><b>${s.alerts}</b>alerts</div><div><b>${Object.keys(s.modules).length}</b>modules</div></div>` +
      Object.entries(s.modules).map(([id, m]) => `<div class="sumrow"><div class="lbl">${modules.find(x => x.id === id)?.icon || ''} ${esc(m.name)}${m.enabled ? '' : ' (off)'}</div><div>${Object.entries(m.stats).map(([k, v]) => `<span><b>${esc(v)}</b> ${esc(k)}</span>`).join('')}</div></div>`).join('');
  }
  $('sumJson').onclick = () => UI.download(`summary_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(buildSummary(), null, 2), 'application/json');
  $('sumCsv').onclick = () => { const s = buildSummary(), rows = [['module', 'metric', 'value']]; for (const [id, m] of Object.entries(s.modules)) for (const [k, v] of Object.entries({ ...m.stats, ...Object.fromEntries(Object.entries(m.events).map(([k, v]) => ['events:' + k, v])) })) rows.push([id, k, v]); UI.download(`summary_${s.date}.csv`, rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv'); };
  $('sumTg').onclick = async () => { if (!G.tgToken) return alert('Set Telegram bot token + chat id in Settings'); if (await SC.telegram(summaryText(buildSummary()))) SC.toast('Summary sent'); };
  $('sumAuto').checked = G.summaryAuto; $('sumTime').value = G.summaryTime;
  $('sumAuto').onchange = e => { G.summaryAuto = e.target.checked; SC.saveG(); }; $('sumTime').onchange = e => { G.summaryTime = e.target.value; SC.saveG(); };
  setInterval(() => { const d = new Date(), k = d.toDateString(); if (G.summaryAuto && G.tgToken && d.toTimeString().slice(0, 5) >= G.summaryTime && SC.LS.get('sumSent') !== k) { SC.LS.set('sumSent', k); SC.telegram(summaryText(buildSummary())); } }, 30000);
  UI.summaryText = () => summaryText(buildSummary());

  // ---------- settings ----------
  const gset = [['conf', 'Detection confidence', 0.2, 0.9, 0.05], ['motionThr', 'Motion threshold (% pixels)', 0.2, 20, 0.1], ['pixThr', 'Pixel sensitivity', 5, 100, 1], ['detFast', 'Detect every (ms) when active', 80, 1000, 10], ['detIdle', 'Detect every (ms) when idle', 300, 5000, 100]];
  $('gFields').innerHTML = gset.map(([k, l, a, b, s]) => `<label>${l}: <b id="g_${k}_v">${G[k]}</b><input type="range" id="g_${k}" min="${a}" max="${b}" step="${s}" value="${G[k]}"></label>`).join('');
  gset.forEach(([k]) => $('g_' + k).oninput = e => { G[k] = +e.target.value; $('g_' + k + '_v').textContent = e.target.value; SC.saveG(); });
  $('gNight').value = G.night; $('gNight').onchange = e => { G.night = e.target.value; SC.saveG(); };
  $('gSound').checked = G.sound; $('gSound').onchange = e => { G.sound = e.target.checked; SC.saveG(); };
  $('tgToken').value = G.tgToken; $('tgChat').value = G.tgChat;
  $('tgToken').onchange = e => { G.tgToken = e.target.value.trim(); SC.saveG(); }; $('tgChat').onchange = e => { G.tgChat = e.target.value.trim(); SC.saveG(); };
  $('tgTest').onclick = async () => { if (await SC.telegram('Pi Motion Cam web: test message ✅')) SC.toast('Telegram test sent'); };
  $('cfgExport').onclick = () => UI.download('pi-motion-cam-web-config.json', JSON.stringify({ version: SC.VERSION, global: { ...G, tgToken: undefined, tgChat: undefined }, modules: Object.fromEntries(modules.map(m => [m.id, m.cfg])) }, null, 2), 'application/json');
  $('cfgImport').onchange = async e => { try { const j = JSON.parse(await e.target.files[0].text()); for (const [id, c] of Object.entries(j.modules || {})) SC.LS.set('mod_' + id, c); Object.assign(G, j.global || {}); SC.saveG(); location.reload(); } catch (err) { alert('Import failed: ' + err.message); } };
  $('cfgPi').onclick = () => UI.download('config-modules.yaml', piYaml(), 'text/yaml');
  $('cfgReset').onclick = () => { if (confirm('Reset all module settings (keeps faces & logs)?')) { modules.forEach(m => localStorage.removeItem('mod_' + m.id)); location.reload(); } };

  // web module config -> Pi config.yaml `modules:` section
  function piYaml() {
    const c = id => modules.find(m => m.id === id).cfg, pts = p => JSON.stringify(p), zs = z => z.length ? '\n' + z.map(x => `      - name: ${JSON.stringify(x.name)}\n        points: ${pts(x.points)}`).join('\n') : ' []';
    const common = m => `    enabled: ${!!m.enabled}\n    telegram: ${!!m.telegram}\n    cooldown_seconds: ${m.cooldown}`;
    const cls = l => JSON.stringify(l.map(x => x === 'motorcycle' ? 'motorbike' : x));
    const a = c('attendance'), ct = c('counter'), z = c('zone'), f = c('fall'), fi = c('fight'), p = c('perimeter'), l = c('loiter'), o = c('occupancy'), an = c('animal'), t = c('tamper'), fs = c('fire'), ah = c('afterhours'), mo = c('motion');
    return `# Generated by the Pi Motion Cam web app v${SC.VERSION} — paste over the modules: section of config.yaml
modules:
  motion_alert:
${common(mo)}
    require_person: ${!!mo.personOnly}
  attendance:
${common(a)}
    relog_gap_minutes: ${a.gap}
  counter:
${common(ct)}
    line: ${pts(ct.line || [[0.5, 0], [0.5, 1]])}
    in_side: ${ct.invert ? 'positive' : 'negative'}
    classes: ${cls(ct.classes)}
  zone_intrusion:
${common(z)}
    zones:${zs(z.zones)}
    classes: ${cls(z.classes)}
    active_hours: ${JSON.stringify(z.schedule || '')}
  fall:
${common(f)}
    down_seconds: ${f.downSec}
    drop_fraction: ${f.dropFrac}
  fight:
${common(fi)}
    hold_seconds: ${fi.holdSec}
    proximity: ${fi.proximity}
  perimeter:
${common(p)}
    classes: ${cls(p.classes)}
    line: ${p.line ? pts(p.line) : 'null'}
    direction: ${p.direction === 'pos' ? 'positive' : p.direction === 'neg' ? 'negative' : 'both'}
    zones:${zs(p.zones)}
    active_hours: ${JSON.stringify(p.schedule || '')}
  loitering:
${common(l)}
    max_seconds: ${l.maxSec}
    zones:${zs(l.zones)}
    active_hours: ${JSON.stringify(l.schedule || '')}
  occupancy:
${common(o)}
    max_people: ${o.max}
    hold_seconds: ${o.holdSec}
    zones:${zs(o.zones)}
  animal:
${common(an)}
    classes: ${cls(an.classes)}
  tamper:
${common(t)}
    dark_threshold: ${t.dark}
    hold_seconds: ${t.holdSec}
  fire_smoke:
${common(fs)}
    hold_seconds: ${fs.holdSec}
  plates:
${common(c('plates'))}
    classes: ${cls(c('plates').classes)}
    line: ${c('plates').line ? pts(c('plates').line) : 'null'}
    tries: ${c('plates').tries}
    min_confidence: ${c('plates').minConf}
    indian_only: ${!!c('plates').indianOnly}
    out_after_minutes: ${c('plates').outMin}
    watchlist: ${JSON.stringify(c('plates').watchlist.toUpperCase().split(/[\s,;]+/).filter(Boolean))}
  after_hours:
${common(ah)}
    active_hours: ${JSON.stringify(ah.schedule || '20:00-06:00')}
    classes: ${cls(ah.classes)}
`;
  }
  UI.piYaml = piYaml;

  // ---------- boot ----------
  SC.init();
  $('ver').textContent = 'v' + SC.VERSION;
  $('evFilter').innerHTML = '<option value="">All modules</option>' + modules.map(m => `<option value="${m.id}">${m.icon} ${esc(m.name)}</option>`).join('');
  modules.forEach(buildCard);
  $('evCount').textContent = S.events.length;
  $('startBtn').onclick = () => SC.start(); $('stopBtn').onclick = () => SC.stop(); $('flipBtn').onclick = () => SC.switchCamera();
  $('snapBtn').onclick = () => { const m = modules.find(x => x.id === 'motion'); m.emit('manual', 'Manual snapshot', {}); };
  $('unkBadge').onclick = () => { document.querySelector('[data-tab=tabModules]').click(); const c = $('mod_attendance'); c.open = true; c.scrollIntoView({ behavior: 'smooth' }); };
  UI.setBadge(modules.find(m => m.id === 'attendance')?.unknownCount?.() || 0);
})();
