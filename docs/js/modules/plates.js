/* 14. Vehicles & number plates — per tracked vehicle: find plate region (edge-density search), OCR with tesseract.js, IN/OUT log */
(() => {
  const { $, LS, esc, S } = SC;
  const VEH = ['car', 'truck', 'bus', 'motorcycle'];
  let worker = null, loading = null, ocrBusy = false;
  let plates = LS.get('plates', {});   // plate -> {plate, first, last, in, out, inside, visits, thumb, conf}
  let log = LS.get('plateLog', []);    // [{plate, dir, t, conf}]
  const save = () => { LS.set('plates', plates) || (Object.values(plates).forEach(p => delete p.thumb), LS.set('plates', plates)); LS.set('plateLog', log.slice(-2000)); };

  // ---------- OCR engine (vendored, same-origin) ----------
  async function loadOCR() {
    if (worker) return worker; if (loading) return loading;
    loading = (async () => {
      try {
        SC.status('Loading plate OCR (~6 MB)…');
        const abs = p => new URL(p, location.href).href;
        const w = await Tesseract.createWorker('eng', 1, { workerPath: abs('vendor/tesseract/worker.min.js?v=' + SC.VERSION), corePath: abs('vendor/tesseract/core/'), langPath: abs('models/tessdata-v6'), gzip: true });
        // NB: no char whitelist — with the LSTM engine tesseract.js then reports confidence 0; we filter to A-Z0-9 ourselves
        await w.setParameters({ tessedit_pageseg_mode: '7' });
        worker = w; SC.status((S.running ? 'Running' : 'Ready') + ' · plate OCR on'); return w;
      } catch (e) { console.error(e); SC.toast('Plate OCR failed to load: ' + (e?.message || e), 'alert'); SC.status('Plate OCR failed: ' + (e?.message || e)); return null; }
      finally { loading = null; }
    })();
    return loading;
  }

  // ---------- plate text normalization (Indian format hint) ----------
  const L2D = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6', T: '7' }, D2L = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G', 7: 'T', 4: 'A' };
  const STATES = 'AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB'.split(' ');
  // shape: L=letter D=digit; Indian: SS DD [L{0,3}] DDDD  e.g. MH12AB1234, DL3CAF1234 ; BH series: DD BH DDDD L{1,2}
  const CONF = { N: 'WMH', W: 'NMV', M: 'NWH', H: 'NM', U: 'VW', V: 'UW', K: 'X', X: 'K', O: 'D', D: 'O', R: 'P', P: 'R', T: 'J', J: 'T', C: 'G', G: 'C', L: 'I', I: 'L' };
  function fixState(v) {   // repair a confusable letter in the 2-letter state code (e.g. NB -> WB)
    if (STATES.includes(v.slice(0, 2))) return v;
    for (let i = 0; i < 2; i++) for (const r of CONF[v[i]] || '') { const t = i ? v[0] + r + v.slice(2) : r + v.slice(1); if (STATES.includes(t.slice(0, 2))) return t; }
    return null;
  }
  function coerce(s, shape) { let o = ''; for (let i = 0; i < s.length; i++) { const c = s[i], want = shape[i]; o += want === 'D' ? (/\d/.test(c) ? c : L2D[c] ?? '?') : (/[A-Z]/.test(c) ? c : D2L[c] ?? '?'); } return o.includes('?') ? null : o; }
  function normalize(raw) {
    const s = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (s.length < 4) return null;
    let best = null;
    for (let len = Math.min(11, s.length); len >= 8; len--) for (let st = 0; st + len <= s.length; st++) {
      const sub = s.slice(st, st + len);
      for (const dl of [1, 2]) for (let ll = 0; ll <= 3; ll++) {             // state(2) + district digits(dl) + letters(ll) + 4 digits
        if (2 + dl + ll + 4 !== len) continue;
        const c0 = coerce(sub, 'LL' + 'D'.repeat(dl) + 'L'.repeat(ll) + 'DDDD'), v = c0 && fixState(c0);
        if (v) { const sc = 100 + len - (v !== c0 ? 3 : 0) + (dl === 2 ? 2 : 0); /* district codes are usually 2 digits */ if (!best || sc > best.score) best = { plate: v, indian: true, score: sc }; }
      }
      if (len >= 9) { const v = coerce(sub.slice(0, 8) + sub.slice(8), 'DDLLDDDD' + 'L'.repeat(len - 8)); if (v && v.slice(2, 4) === 'BH' && len <= 10) best = best || { plate: v, indian: true, score: 100 + len }; }
    }
    return best || (s.length >= 5 && s.length <= 10 ? { plate: s, indian: false, score: s.length } : null);
  }

  // ---------- plate region search: edge-density windows in the lower part of the vehicle box ----------
  const work = document.createElement('canvas'), wctx = work.getContext('2d', { willReadFrequently: true });
  function candidates(src, sx, sy, sw, sh, max = 3) {
    const W = Math.min(480, Math.round(sw)), H = Math.max(8, Math.round(sh * W / sw));
    work.width = W; work.height = H; wctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
    const d = wctx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    const I = new Float64Array((W + 1) * (H + 1));                      // integral image of strong vertical edges
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { const e = x > 0 && x < W - 1 && Math.abs(g[y * W + x + 1] - g[y * W + x - 1]) > 60 ? 1 : 0; row += e; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
    const sum = (x, y, w, h) => I[(y + h) * (W + 1) + x + w] - I[y * (W + 1) + x + w] - I[(y + h) * (W + 1) + x] + I[y * (W + 1) + x];
    const out = [];
    for (const fw of [0.22, 0.3, 0.4, 0.55]) for (const ar of [4.5, 3, 1.6]) {   // 4.5:1 single-row, 3:1, 1.6:1 two-row (bikes, rear plates)
      const w = Math.round(W * fw), h = Math.round(w / ar); if (h < 8 || h > H) continue;
      const step = Math.max(2, w >> 3);
      for (let y = 0; y + h <= H; y += Math.max(2, h >> 2)) for (let x = 0; x + w <= W; x += step) {
        const dens = sum(x, y, w, h) / (w * h); if (dens < 0.08) continue;
        // plates: dense edges inside, quieter just above/below
        const above = y >= h / 2 ? sum(x, y - (h >> 1), w, h >> 1) / (w * (h >> 1)) : dens * 0.5, below = y + h + (h >> 1) <= H ? sum(x, y + h, w, h >> 1) / (w * (h >> 1)) : dens * 0.5;
        out.push({ x, y, w, h, score: dens * 2 - above - below });
      }
    }
    out.sort((a, b) => b.score - a.score);
    const pick = [];
    for (const c of out) { if (pick.length >= max) break; if (pick.every(p => c.x > p.x + p.w || c.x + c.w < p.x || c.y > p.y + p.h || c.y + c.h < p.y)) pick.push(c); }
    const k = sw / W; return pick.map(c => ({ x: sx + c.x * k, y: sy + c.y * k, w: c.w * k, h: c.h * k, score: c.score }));
  }
  // bright plate blobs: white/yellow rectangles (connected components on a brightness mask)
  function brightBlobs(src, sx, sy, sw, sh, max = 3) {
    const W = Math.min(240, Math.round(sw)), H = Math.max(8, Math.round(sh * W / sw));
    work.width = W; work.height = H; wctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
    const d = wctx.getImageData(0, 0, W, H).data, n = W * H, lum = new Uint8Array(n);
    for (let i = 0; i < n; i++) lum[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    const sorted = Uint8Array.from(lum).sort(), thr = Math.max(130, sorted[(n * 0.6) | 0]);
    const lab = new Int32Array(n), out = []; let id = 0; const q = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      if (lum[i] < thr || lab[i]) continue;
      id++; let qh = 0, qt = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, cnt = 0; q[qt++] = i; lab[i] = id;
      while (qh < qt) {
        const j = q[qh++], x = j % W, y = (j / W) | 0; cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < n && !lab[k] && lum[k] >= thr && Math.abs((k % W) - x) <= 1) { lab[k] = id; q[qt++] = k; }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, ar = bw / bh, fill = cnt / (bw * bh);
      if (ar >= 1.4 && ar <= 7 && bw >= W * 0.12 && bh >= 6 && fill > 0.35 && fill < 0.97) out.push({ x: x0, y: y0, w: bw, h: bh, score: fill * Math.min(ar, 5) * Math.sqrt(bw * bh) });
    }
    out.sort((a, b) => b.score - a.score);
    const k = sw / W; return out.slice(0, max).map(c => ({ x: sx + c.x * k, y: sy + c.y * k, w: c.w * k, h: c.h * k, score: c.score, blob: true }));
  }
  // character segmentation inside a candidate: dark, character-shaped components → tight text box + tilt from a line through their bottoms
  function charBand(src, r) {
    const ex = r.w * 0.12, R = { x: Math.max(0, r.x - ex), y: Math.max(0, r.y - r.h * 0.1), w: r.w + 2 * ex, h: r.h * 1.2 };
    const W = 320, H = Math.max(16, Math.round(R.h * W / R.w)); work.width = W; work.height = H;
    wctx.drawImage(src, R.x, R.y, R.w, R.h, 0, 0, W, H);
    const d = wctx.getImageData(0, 0, W, H).data, n = W * H, g = new Uint8Array(n), hist = new Float64Array(256);
    for (let i = 0; i < n; i++) { g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; hist[g[i]]++; }
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, t = 100; for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB || wB === n) continue; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / (n - wB), v = wB * (n - wB) * (mB - mF) ** 2; if (v > best) { best = v; t = i; } }
    const lab = new Int32Array(n), q = new Int32Array(n), chars = []; let id = 0;
    for (let i = 0; i < n; i++) {
      if (g[i] > t || lab[i]) continue;
      id++; let qh = 0, qt = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, cnt = 0; q[qt++] = i; lab[i] = id;
      while (qh < qt) { const j = q[qh++], x = j % W, y = (j / W) | 0; cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < n && !lab[k] && g[k] <= t && Math.abs((k % W) - x) <= 1) { lab[k] = id; q[qt++] = k; } }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bh >= H * 0.2 && bh <= H * 0.9 && bw <= W * 0.2 && bh / bw >= 0.9 && bh / bw <= 8 && cnt / (bw * bh) > 0.15) chars.push({ x0, y0, x1, y1, bh });
    }
    if (chars.length < 4) return null;
    // keep the largest group of similar-height characters
    chars.sort((a, b) => a.bh - b.bh); const med = chars[chars.length >> 1].bh, cs = chars.filter(c => c.bh > med * 0.6 && c.bh < med * 1.5);
    if (cs.length < 4) return null;
    const pts = cs.map(c => [(c.x0 + c.x1) / 2, c.y1]), mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / (pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) || 1);
    const x0 = Math.min(...cs.map(c => c.x0)), x1 = Math.max(...cs.map(c => c.x1)), y0 = Math.min(...cs.map(c => c.y0)), y1 = Math.max(...cs.map(c => c.y1)), k = R.w / W;
    const padX = (x1 - x0) * 0.04 + 4, padY = med * 0.2;
    return { x: R.x + (x0 - padX) * k, y: R.y + (y0 - padY) * k, w: (x1 - x0 + 2 * padX) * k, h: (y1 - y0 + 2 * padY) * k, angle: Math.atan(slope) * 180 / Math.PI, n: cs.length, tight: true };
  }
  const ocrC = document.createElement('canvas');
  function prep(src, r, binarize, angle = 0) {  // crop (inset for white blobs, padded for edge boxes), deskew, upscale, grayscale+contrast, optional Otsu
    const f = r.blob ? -0.03 : 0.06, px = r.w * f, py = r.h * (r.blob ? -0.05 : 0.08), R = { x: Math.max(0, r.x - px), y: Math.max(0, r.y - py), w: r.w + 2 * px, h: r.h + 2 * py };
    const a = Math.abs(angle) * Math.PI / 180, hd = r.tight ? Math.max(R.h * Math.cos(a) - R.w * Math.sin(a), R.h * 0.3) : R.h;   // deskewed text-band height
    const sc = Math.min(3, Math.max(0.3, 100 / hd)), cw = Math.round(R.w * sc), ch = Math.round(R.h * sc);
    if (r.tight) { ocrC.width = Math.round(cw / Math.cos(a)) + 30; ocrC.height = Math.round(hd * sc) + 30; }   // fit the deskewed line, don't clip its ends
    else { ocrC.width = cw + 20; ocrC.height = ch + 20; }
    const x = ocrC.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, ocrC.width, ocrC.height);
    x.save(); x.translate(ocrC.width / 2, ocrC.height / 2); x.rotate(angle * Math.PI / 180); x.filter = 'grayscale(1) contrast(1.5)';
    x.drawImage(src, R.x, R.y, R.w, R.h, -cw / 2, -ch / 2, cw, ch); x.restore(); x.filter = 'none';
    if (binarize) {
      const img = x.getImageData(0, 0, ocrC.width, ocrC.height), d = img.data, hist = new Float64Array(256), n = d.length / 4;
      for (let i = 0; i < n; i++) hist[d[i * 4]]++;
      let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sB = 0, wB = 0, best = 0, t = 128; for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB || wB === n) continue; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / (n - wB), v = wB * (n - wB) * (mB - mF) ** 2; if (v > best) { best = v; t = i; } }
      for (let i = 0; i < n; i++) { const v = d[i * 4] > t ? 255 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
      x.putImageData(img, 0, 0);
    }
    return ocrC;
  }
  async function readPlate(src, box, from = 0.35) {   // box in source pixels; search the lower part (from = top fraction skipped)
    if (!worker) return null;
    const [bx, by, bw, bh] = box, lower = { x: bx, y: by + bh * from, w: bw, h: bh * (1 - from) };
    const cands = [...brightBlobs(src, lower.x, lower.y, lower.w, lower.h), ...candidates(src, lower.x, lower.y, lower.w, lower.h, 2)];
    let best = null;
    const better = v => !best || v.score + v.conf > best.score + best.conf;
    const tight = cands.map(c => charBand(src, c)).filter(Boolean).sort((a, b) => b.n - a.n);
    for (const r of [...tight, ...cands, { x: bx, y: by, w: bw, h: bh, whole: true }]) {
      if (r.tight) {   // tight, deskewed character band: one or two quick tries
        for (const [bin, ang] of [[false, -r.angle], [false, r.angle], [false, 0], [true, -r.angle], [false, -r.angle / 2], [false, r.angle / 2]]) {
          await worker.setParameters({ tessedit_pageseg_mode: '7' });
          const { data } = await worker.recognize(prep(src, r, bin, ang));
          const nn = normalize(data.text); if (!nn) continue;
          const v = { ...nn, conf: data.confidence, rect: r, raw: data.text.trim().replace(/\s+/g, ' ') };
          if (better(v)) best = v;
          if (best.indian && best.conf > 60) return best;
        }
        continue;
      }
      // single line → binarized → deskewed (plates are often tilted a few degrees) → block mode (2-row bike plates)
      const tries = r.whole ? [['11', false, 0]] : [['7', false, 0], ['7', true, 0], ['7', false, -4], ['7', false, 4], ['7', false, -8], ['7', false, 8], ...(r.w / r.h < 3 ? [['6', false, 0]] : [])];
      for (const [psm, bin, ang] of tries) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        const { data } = await worker.recognize(prep(src, r, bin, ang));
        const n = normalize(data.text); if (!n) continue;
        const v = { ...n, conf: data.confidence, rect: r, raw: data.text.trim().replace(/\s+/g, ' ') };
        if (better(v)) best = v;
        if (best.indian && best.conf > 75) return best;
      }
      if (best?.indian && best.conf > 60) break;
    }
    return best;
  }

  // ---------- IN / OUT bookkeeping ----------
  function record(read, t, dir, snapCanvas) {
    const now = Date.now(), p = plates[read.plate] ||= { plate: read.plate, first: now, visits: 0, inside: false, conf: 0 };
    p.last = now; p.conf = Math.max(p.conf, Math.round(read.conf)); p.trackId = t?.id;
    if (snapCanvas) { const c = document.createElement('canvas'), r = read.rect; c.width = 160; c.height = Math.max(20, Math.round(160 * r.h / r.w)); c.getContext('2d').drawImage(snapCanvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height); p.thumb = c.toDataURL('image/jpeg', 0.7); }
    const d = dir || (p.inside ? null : 'in');
    if (d === 'in' && !p.inside) { p.inside = true; p.in = now; p.out = null; p.visits++; }
    else if (d === 'out' && p.inside) { p.inside = false; p.out = now; }
    else if (!d) { save(); render(); return; }
    else if (d === 'in') return save();
    log.push({ plate: read.plate, dir: d, t: now, conf: Math.round(read.conf) }); save(); render();
    const watch = M.cfg.watchlist.toUpperCase().split(/[\s,;]+/).filter(Boolean), hit = watch.includes(read.plate);
    M.emit(d, `${hit ? '🚨 WATCHLIST ' : ''}${t?.cls || 'vehicle'} ${read.plate} ${d.toUpperCase()}${read.indian ? '' : ' (format unverified)'} · conf ${Math.round(read.conf)}`, { severity: hit ? 'alert' : 'info', trackId: t?.id });
  }

  const M = SC.register({
    id: 'plates', name: 'Vehicles & number plates', icon: '🚘',
    desc: 'Counts vehicles and reads number plates (tesseract.js OCR, ~6 MB, loaded when enabled). Each new vehicle is read once, retried on later frames until a confident Indian-format plate (e.g. MH12AB1234) is found. IN = first read (or crossing the line in the IN direction), OUT = line crossing or not seen for the timeout.',
    defaults: { classes: ['car', 'truck', 'bus', 'motorcycle'], tries: 4, minConf: 55, indianOnly: false, outMin: 2, watchlist: '', line: null, cooldown: 5 },
    geometry: ['line'],
    fields: [
      { k: 'classes', label: 'Vehicle classes', type: 'classes', options: VEH },
      { k: 'tries', label: 'OCR attempts per vehicle', type: 'range', min: 1, max: 10, step: 1 },
      { k: 'minConf', label: 'Min. OCR confidence', type: 'range', min: 20, max: 95, step: 5 },
      { k: 'indianOnly', label: 'Only accept Indian-format plates', type: 'check' },
      { k: 'outMin', label: 'Mark OUT when not seen for (min) — if no line', type: 'range', min: 0.5, max: 60, step: 0.5 },
      { k: 'watchlist', label: 'Watchlist plates (alert)', type: 'text', placeholder: 'MH12AB1234, DL3CAF0001' },
    ],
    onEnable() { loadOCR(); },
    onDetect(F) {
      const vehicles = F.tracks.filter(t => this.cfg.classes.includes(t.cls));
      for (const t of vehicles) {
        const st = t.flags.plate ||= { tries: 0, best: null, next: 0, counted: false };
        if (!st.counted) { st.counted = true; this.counts['vehicles_' + t.cls] = (this.counts['vehicles_' + t.cls] || 0) + 1; this.counts.vehicles = (this.counts.vehicles || 0) + 1; }
        const L = this.cfg.line;   // optional direction line
        if (L) { const s = SC.geo.side(SC.geo.center(t), L[0], L[1]), prev = st.side; if (s) st.side = s; if (prev && s && s !== prev) { st.dir = s < 0 ? 'in' : 'out'; if (st.best) record(st.best, t, st.dir, null); } }
      }
      if (!worker || ocrBusy) return;
      const now = F.now, t = vehicles.filter(t => { const st = t.flags.plate; return st.tries < this.cfg.tries && now >= st.next && !(st.best?.indian && st.best.conf > 80) && t.box[2] > 40; })
        .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
      if (!t) return;
      const st = t.flags.plate; st.tries++; st.next = now + 1200; ocrBusy = true;
      const snap = document.createElement('canvas'); snap.width = S.video.videoWidth; snap.height = S.video.videoHeight; snap.getContext('2d').drawImage(S.video, 0, 0);
      readPlate(snap, t.box.map((v, i) => v * (i % 2 ? S.vy : S.vx)), st.tries % 2 ? 0.35 : 0.1).then(r => {   // alternate: lower box (typical) / almost whole box (close-up)
        if (!r || (r.conf < this.cfg.minConf && !(r.indian && r.conf >= 35)) || (this.cfg.indianOnly && !r.indian)) return;
        if (!st.best || r.score + r.conf > st.best.score + st.best.conf) {
          const first = !st.best; st.best = r; t.flags.plateText = r.plate;
          if (first) record(r, t, st.dir || null, snap); else { const p = plates[r.plate]; if (!p) record(r, t, st.dir || null, snap); }
        }
      }).catch(e => console.warn('ocr', e)).finally(() => ocrBusy = false);
    },
    draw(c, W, H) {
      if (this.cfg.line) SC.drawPoly(c, this.cfg.line, W, H, '#2ac3de', 'plates IN →', false);
      for (const t of SC.S.tracks.values()) if (t.flags.plateText && performance.now() - t.last < 800) { const [x, y, w, h] = t.box; c.fillStyle = '#2ac3de'; c.fillRect(x, y + h, Math.max(90, w * 0.6), 20); c.fillStyle = '#000'; c.fillText(t.flags.plateText, x + 4, y + h + 15); }
    },
    stats() { const ins = Object.values(plates).filter(p => p.inside).length; return { 'Inside now': ins, 'Vehicles today': this.counts.vehicles || 0, 'Plates IN': this.counts.in || 0, 'Plates OUT': this.counts.out || 0 }; },
    panel(el) {
      el.innerHTML = `<div class="row"><label class="btn">📷 Read plate from photo<input type="file" id="plateFile" accept="image/*" hidden></label></div><div id="plateTest" class="hint"></div>
        <h4>Vehicles inside now</h4><div class="tablewrap"><table><thead><tr><th>Plate</th><th>IN</th><th>Conf</th></tr></thead><tbody id="plInside"></tbody></table></div>
        <h4>Plate log</h4><div class="tablewrap"><table><thead><tr><th>Plate</th><th>IN</th><th>OUT</th><th>Visits</th></tr></thead><tbody id="plLog"></tbody></table></div>
        <div class="row"><button id="plCsv">Export CSV</button><button id="plOutAll">Mark all OUT</button><button id="plClear">Clear</button></div>`;
      $('plCsv').onclick = exportCsv;
      $('plClear').onclick = () => { if (confirm('Clear plate log?')) { plates = {}; log = []; save(); render(); } };
      $('plOutAll').onclick = () => { for (const p of Object.values(plates)) if (p.inside) { p.inside = false; p.out = Date.now(); log.push({ plate: p.plate, dir: 'out', t: p.out, conf: p.conf }); } save(); render(); };
      $('plateFile').onchange = testPhoto;
      render();
    },
  });
  M.readPlate = readPlate; M._prep = prep; M.normalize = normalize; M.loadOCR = loadOCR; M.plates = () => plates;

  async function testPhoto(e) {
    const f = e.target.files[0]; if (!f) return; const out = $('plateTest'); out.textContent = 'Loading OCR…';
    if (!(await loadOCR())) { out.textContent = 'OCR failed to load'; return; }
    const im = new Image(); im.src = URL.createObjectURL(f); await im.decode();
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0);
    out.textContent = 'Reading…';
    // whole photo treated as a vehicle box (plate search runs in its lower part, then whole image)
    const r = await readPlate(c, [0, 0, c.width, c.height], 0);
    out.innerHTML = r ? `Read: <b>${esc(r.plate)}</b> ${r.indian ? '✅ Indian format' : '(format unverified)'} · conf ${Math.round(r.conf)} · raw "${esc(r.raw)}"` : 'No plate text found.';
    if (r && r.conf >= M.cfg.minConf && confirm(`Log ${r.plate} as IN?`)) record(r, null, 'in', c);
    e.target.value = '';
  }

  // OUT by timeout when no direction line is used
  setInterval(() => {
    if (!M.cfg.enabled || M.cfg.line) return; const lim = M.cfg.outMin * 60000, now = Date.now();
    for (const p of Object.values(plates)) if (p.inside && now - p.last > lim) { p.inside = false; p.out = p.last; log.push({ plate: p.plate, dir: 'out', t: p.last, conf: p.conf }); M.emit('out', `${p.plate} OUT (not seen for ${M.cfg.outMin} min)`, {}); }
    save(); render();
  }, 15000);

  const fmt = t => t ? new Date(t).toLocaleString() : '—';
  function render() {
    const a = $('plInside'), b = $('plLog'); if (!a) return;
    const ps = Object.values(plates).sort((x, y) => y.last - x.last);
    a.innerHTML = ps.filter(p => p.inside).map(p => `<tr><td>${p.thumb ? `<img src="${p.thumb}" class="plimg"><br>` : ''}<b>${esc(p.plate)}</b></td><td>${fmt(p.in)}</td><td>${p.conf}</td></tr>`).join('') || '<tr><td colspan="3" class="hint">None</td></tr>';
    b.innerHTML = ps.slice(0, 100).map(p => `<tr><td><b>${esc(p.plate)}</b></td><td>${fmt(p.in)}</td><td>${p.inside ? 'inside' : fmt(p.out)}</td><td>${p.visits}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No plates yet</td></tr>';
  }
  function exportCsv() {
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    UI.download(`plates_${new Date().toISOString().slice(0, 10)}.csv`, 'plate,direction,time,confidence\n' + log.map(l => [l.plate, l.dir.toUpperCase(), new Date(l.t).toISOString(), l.conf].map(q).join(',')).join('\n'), 'text/csv');
  }
})();
