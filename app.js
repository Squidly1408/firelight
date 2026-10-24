/* Firelight: a grid-based fire simulation (heat, smoke and steam advected by a buoyant,
   turbulent velocity field with vorticity confinement), rendered on a 2D canvas. */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);

  const cv = $('c');
  const ctx = cv.getContext('2d');
  const coarse = matchMedia('(pointer: coarse)').matches;

  // ---------- settings / persistence ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('firelight.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('firelight.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  let intensity = clamp(+store.get('intensity', 1) || 1, 0.35, 1.6);
  let wantSound = !!store.get('sound', false);

  // ---------- layout ----------
  let vw = 0, vh = 0, dpr = 1, dprCap = 2;
  let cx = 0, baseY = 0, UNIT = 100, sz = 1;

  // ---------- simulation grid ----------
  let gridCols = coarse || Math.min(innerWidth, innerHeight) < 600 ? 92 : 136;
  const MIN_COLS = 56, MAX_COLS = 170;
  let gw = 0, gh = 0, N = 0, cell = 1, bx0 = 0, by0 = 0;
  let T, T2, S, S2, St, St2, Uv, Vv, U2, V2, CU, P, DIV, absorb, rmask;
  let fireCv, fireCx, fireImg, smokeCv, smokeCx, smokeImg, bloomCv, bloomCx;
  let sources = [], bedSrc = [];

  // fuel state lives in fixed bins across the fire bed (in "bed units"), independent of grid res
  const NB = 96, BX0 = -1.6, BX1 = 1.6;
  const H = new Float32Array(NB);   // flame (combustion) level per bin
  const E = new Float32Array(NB);   // ember heat
  const W = new Float32Array(NB);   // wetness
  const fuel = new Uint8Array(NB);
  const binTop = new Float32Array(NB);
  const binOf = (x) => clamp(Math.floor((x - BX0) / (BX1 - BX0) * NB), 0, NB - 1);
  const binX = (b) => BX0 + (b + 0.5) * (BX1 - BX0) / NB;
  let meanH = 1, maxH = 1, meanE = 0.5, light = 1, lightTarget = 1;

  // ---------- smooth tileable noise texture ----------
  const NS = 256, NOISE = new Float32Array(NS * NS);
  (() => {
    const octs = [[8, 0.5], [16, 0.28], [32, 0.15], [64, 0.07]];
    for (const [L, amp] of octs) {
      const lat = new Float32Array(L * L);
      for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
      for (let y = 0; y < NS; y++) {
        const fy = y / NS * L, iy = fy | 0, ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
        const y0 = iy % L, y1 = (iy + 1) % L;
        for (let x = 0; x < NS; x++) {
          const fx = x / NS * L, ix = fx | 0, tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
          const x0 = ix % L, x1 = (ix + 1) % L;
          const a = lat[y0 * L + x0], b = lat[y0 * L + x1], c = lat[y1 * L + x0], d = lat[y1 * L + x1];
          NOISE[y * NS + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
        }
      }
    }
  })();
  function nz(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const xa = x0 & 255, xb = (x0 + 1) & 255, ya = (y0 & 255) << 8, yb = ((y0 + 1) & 255) << 8;
    const a = NOISE[ya + xa], b = NOISE[ya + xb], c = NOISE[yb + xa], d = NOISE[yb + xb];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  // ---------- fire colour LUT ----------
  const LUT = new Uint8ClampedArray(256 * 3);
  (() => {
    const st = [[0, 0, 0, 0], [0.1, 30, 3, 0], [0.26, 125, 20, 2], [0.45, 215, 66, 6], [0.64, 255, 128, 22],
      [0.82, 255, 186, 70], [1.0, 255, 228, 150], [1.5, 255, 252, 230]];
    for (let i = 0; i < 256; i++) {
      const v = i / 170;
      let k = 0; while (k < st.length - 2 && v > st[k + 1][0]) k++;
      const a = st[k], b = st[k + 1], t = clamp((v - a[0]) / (b[0] - a[0]), 0, 1);
      LUT[i * 3] = lerp(a[1], b[1], t); LUT[i * 3 + 1] = lerp(a[2], b[2], t); LUT[i * 3 + 2] = lerp(a[3], b[3], t);
    }
  })();

  // ---------- scene objects ----------
  let logs = [];
  let stones = [];
  let coalSpecks = [];
  let stars = [];
  let bgCv = null, vigCv = null, puffSprite = null, smokeSprite = null;
  const sparks = [], drops = [], puffs = [];

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  function newLog(x, y, len, r, angle, flip) {
    return { x, y, len, r, angle, flip, char: 0.5, e: 0, jig: 0, vy: 0, landed: true, tex: null, seed: Math.random() * 1000 };
  }
  function initLogs() {
    logs = [
      newLog(-0.36, -0.15, 1.45, 0.15, 0.13, false),
      newLog(0.38, -0.16, 1.35, 0.155, -0.16, true),
      newLog(0.0, -0.13, 1.1, 0.13, 0.02, false),
      newLog(0.04, -0.43, 1.25, 0.14, 0.07, true)
    ];
    // middle log sits behind: draw it first
    logs.unshift(logs.splice(2, 1)[0]);
  }
  function initStones() {
    stones = [];
    const n = 13;
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i / (n - 1)) * Math.PI; // back arc
      stones.push({ x: Math.cos(a) * 1.25 + rand(-0.03, 0.03), y: Math.sin(a) * 0.13 - 0.02, rx: rand(0.12, 0.17), ry: rand(0.08, 0.11), front: false, s: rand(0.7, 1) });
    }
    for (let i = 0; i < 9; i++) {
      const a = (i / 8) * Math.PI;
      stones.push({ x: Math.cos(a) * 1.3 + rand(-0.03, 0.03), y: Math.sin(a) * 0.2 + 0.07, rx: rand(0.16, 0.22), ry: rand(0.1, 0.14), front: true, s: rand(0.7, 1) });
    }
    stones.sort((a, b) => a.y - b.y);
    coalSpecks = [];
    for (let i = 0; i < 70; i++) coalSpecks.push({ x: rand(-1, 1) * rand(0.3, 1), y: rand(-0.06, 0.06), r: rand(0.008, 0.025), ph: Math.random() * 100 });
    stars = [];
    for (let i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random() * 0.6, r: rand(0.3, 1.1), a: rand(0.15, 0.6) });
  }

  // ---------- textures ----------
  function capsulePath(g, w, h) {
    const r = h / 2;
    g.beginPath();
    g.moveTo(r, 0); g.lineTo(w - r, 0); g.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
    g.lineTo(r, h); g.arc(r, r, r, Math.PI / 2, Math.PI * 1.5); g.closePath();
  }
  function seeded(seed) { let s = seed * 9301 + 49297; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

  function makeLogTex(log) {
    const w = log.len * UNIT, h = log.r * 2 * UNIT, R = seeded(log.seed);
    const mk = () => { const c = makeCanvas(w, h); const g = c.getContext('2d'); capsulePath(g, c.width, c.height); g.clip(); return [c, g]; };
    const W_ = Math.ceil(w), H_ = Math.ceil(h);
    // bark
    const [bark, b] = mk();
    let gr = b.createLinearGradient(0, 0, 0, H_);
    gr.addColorStop(0, '#5b3c25'); gr.addColorStop(0.35, '#432a18'); gr.addColorStop(0.75, '#22140b'); gr.addColorStop(1, '#0c0705');
    b.fillStyle = gr; b.fillRect(0, 0, W_, H_);
    for (let i = 0; i < 60; i++) {
      const y = R() * H_, lw = 0.5 + R() * 1.8;
      b.strokeStyle = R() < 0.6 ? 'rgba(15,8,4,0.55)' : 'rgba(120,88,60,0.22)';
      b.lineWidth = lw; b.beginPath(); b.moveTo(R() * W_ * 0.3, y);
      let x = 0; while (x < W_) { x += 8 + R() * 20; b.lineTo(x, y + (R() - 0.5) * 3); }
      b.stroke();
    }
    for (let i = 0; i < 3; i++) {
      const x = R() * W_, y = H_ * (0.25 + R() * 0.5);
      b.fillStyle = 'rgba(20,10,5,0.7)'; b.beginPath(); b.ellipse(x, y, H_ * 0.12, H_ * 0.07, 0, 0, 7); b.fill();
      b.strokeStyle = 'rgba(110,80,50,0.35)'; b.lineWidth = 1; b.stroke();
    }
    // end grain
    const ex = log.flip ? H_ * 0.26 : W_ - H_ * 0.26;
    b.fillStyle = '#1a0f08'; b.beginPath(); b.ellipse(ex, H_ / 2, H_ * 0.25, H_ * 0.5, 0, 0, 7); b.fill();
    gr = b.createRadialGradient(ex, H_ / 2, 0, ex, H_ / 2, H_ * 0.45);
    gr.addColorStop(0, '#b48857'); gr.addColorStop(1, '#6e4a2c');
    b.fillStyle = gr; b.beginPath(); b.ellipse(ex, H_ / 2, H_ * 0.2, H_ * 0.44, 0, 0, 7); b.fill();
    b.strokeStyle = 'rgba(70,40,20,0.45)'; b.lineWidth = 1;
    for (let k = 1; k < 6; k++) { b.beginPath(); b.ellipse(ex, H_ / 2, H_ * 0.2 * k / 6, H_ * 0.44 * k / 6, 0, 0, 7); b.stroke(); }
    // char
    const [char, c] = mk();
    c.fillStyle = '#0d0a09'; c.fillRect(0, 0, W_, H_);
    for (let i = 0; i < 220; i++) {
      c.fillStyle = R() < 0.5 ? 'rgba(120,112,105,0.25)' : 'rgba(0,0,0,0.5)';
      c.fillRect(R() * W_, R() * H_, 1 + R() * 3, 1 + R() * 2);
    }
    // glowing cracks: alligator-skin charcoal from a cellular (Worley F2-F1) pattern
    const [glow, g] = mk();
    {
      const cs = Math.max(6, H_ * 0.36), nx = Math.ceil(W_ / cs) + 2, ny = Math.ceil(H_ / cs) + 2;
      const pts = new Float32Array(nx * ny * 3);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        pts[k] = (i - 1 + R()) * cs * (1 + 0.6 * R() * 0); pts[k + 1] = (j - 1 + R()) * cs * 0.7; pts[k + 2] = R();
      }
      const img = g.createImageData(W_, H_), d = img.data;
      for (let y = 0; y < H_; y++) for (let x = 0; x < W_; x++) {
        const ci = Math.floor(x / cs) + 1, cj = Math.floor(y / (cs * 0.7)) + 1;
        let f1 = 1e9, f2 = 1e9, id = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const k = (jj * nx + ii) * 3, dx = (pts[k] - x) * 0.8, dy = pts[k + 1] - y, dd = dx * dx + dy * dy;
          if (dd < f1) { f2 = f1; f1 = dd; id = pts[k + 2]; } else if (dd < f2) f2 = dd;
        }
        const edge = Math.sqrt(f2) - Math.sqrt(f1);
        const w = Math.max(1, cs * 0.07);
        let e = edge < w ? 1 - edge / w : 0;
        e = e * e * (0.55 + 0.45 * id);
        const bottom = y / H_;                       // underside glows hotter
        const fill = 0.08 + 0.22 * bottom * bottom * id;
        const v = Math.min(1, e + fill), o = (y * W_ + x) * 4;
        d[o] = 255; d[o + 1] = 70 + 150 * e; d[o + 2] = 10 + 70 * e * e; d[o + 3] = v * 255;
      }
      g.putImageData(img, 0, 0);
      // putImageData ignores the clip: re-clip by masking with the capsule
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = '#000'; capsulePath(g, W_, H_); g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    // warm highlight (fire-facing side)
    const [hi, hgc] = mk();
    gr = hgc.createLinearGradient(0, 0, 0, H_);
    gr.addColorStop(0, 'rgba(255,150,70,0.85)'); gr.addColorStop(0.45, 'rgba(255,110,40,0.25)'); gr.addColorStop(0.7, 'rgba(255,90,30,0)');
    hgc.fillStyle = gr; hgc.fillRect(0, 0, W_, H_);
    log.tex = { bark, char, glow, hi, w: W_, h: H_ };
  }

  function makeStatic() {
    // background: night sky + ground
    bgCv = makeCanvas(vw, vh);
    const g = bgCv.getContext('2d');
    const horizon = baseY - UNIT * 0.15;
    let gr = g.createLinearGradient(0, 0, 0, horizon);
    gr.addColorStop(0, '#050409'); gr.addColorStop(1, '#0d090c');
    g.fillStyle = gr; g.fillRect(0, 0, vw, horizon + 1);
    for (const s of stars) {
      g.fillStyle = `rgba(220,215,255,${s.a * 0.6})`;
      g.beginPath(); g.arc(s.x * vw, s.y * horizon, s.r, 0, 7); g.fill();
    }
    // distant tree line silhouette
    g.fillStyle = '#040305';
    g.beginPath(); g.moveTo(0, horizon);
    for (let x = 0; x <= vw; x += 6) {
      const h = (nz(x * 0.02, 3) * 0.9 + nz(x * 0.09, 40) * 0.25) * UNIT * 0.9;
      g.lineTo(x, horizon - h);
    }
    g.lineTo(vw, horizon); g.closePath(); g.fill();
    gr = g.createLinearGradient(0, horizon, 0, vh);
    gr.addColorStop(0, '#0c0806'); gr.addColorStop(1, '#030202');
    g.fillStyle = gr; g.fillRect(0, horizon, vw, vh - horizon);
    // ground texture specks
    for (let i = 0; i < 500; i++) {
      const y = horizon + Math.pow(Math.random(), 0.7) * (vh - horizon);
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '60,45,35' : '0,0,0'},${rand(0.1, 0.35)})`;
      g.fillRect(Math.random() * vw, y, rand(1, 3), rand(0.6, 1.6));
    }
    // vignette
    vigCv = makeCanvas(vw / 2, vh / 2);
    const v = vigCv.getContext('2d');
    gr = v.createRadialGradient(vw / 4, vh / 4 * 1.1, Math.min(vw, vh) * 0.2, vw / 4, vh / 4, Math.max(vw, vh) * 0.62);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.75)');
    v.fillStyle = gr; v.fillRect(0, 0, vw / 2, vh / 2);
    // soft puff sprite
    puffSprite = makeCanvas(64, 64);
    const p = puffSprite.getContext('2d');
    gr = p.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    p.fillStyle = gr; p.fillRect(0, 0, 64, 64);
    smokeSprite = makeCanvas(64, 64);
    const q = smokeSprite.getContext('2d');
    gr = q.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(58,52,48,1)'); gr.addColorStop(0.5, 'rgba(50,45,42,0.45)'); gr.addColorStop(1, 'rgba(40,36,34,0)');
    q.fillStyle = gr; q.fillRect(0, 0, 64, 64);
  }

  // ---------- grid ----------
  function allocGrid() {
    const old = T ? { gw, gh, bx0, by0, cell, T, S, St, Uv, Vv } : null;
    const bw = UNIT * 4.0;
    bx0 = cx - bw / 2;
    by0 = Math.max(-UNIT * 0.3, baseY - UNIT * 3.9);
    const bh = baseY + UNIT * 0.25 - by0;
    gw = gridCols; cell = bw / gw; gh = Math.ceil(bh / cell); N = gw * gh;
    const F = () => new Float32Array(N);
    T = F(); T2 = F(); S = F(); S2 = F(); St = F(); St2 = F(); Uv = F(); Vv = F(); U2 = F(); V2 = F(); CU = F(); P = F(); DIV = F();
    absorb = F(); rmask = F();
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const ex = Math.min(x, gw - 1 - x) / (gw * 0.14), ey = y / (gh * 0.25), eb = (gh - 1 - y) / (gh * 0.08);
      const m = clamp(Math.min(ex, ey, eb), 0, 1);
      rmask[y * gw + x] = m * m * (3 - 2 * m);
      absorb[y * gw + x] = 0.9 + 0.1 * m;
    }
    fireCv = makeCanvas(gw, gh); fireCx = fireCv.getContext('2d'); fireImg = fireCx.createImageData(gw, gh);
    smokeCv = makeCanvas(gw, gh); smokeCx = smokeCv.getContext('2d'); smokeImg = smokeCx.createImageData(gw, gh);
    bloomCv = makeCanvas(Math.ceil(gw / 4), Math.ceil(gh / 4)); bloomCx = bloomCv.getContext('2d');
    for (let i = 3; i < fireImg.data.length; i += 4) fireImg.data[i] = 255;
    if (old) {
      // carry the current fire over to the new resolution so quality changes are invisible
      const sOld = (f, sx, sy) => {
        let x = (sx - old.bx0) / old.cell - 0.5, y = (sy - old.by0) / old.cell - 0.5;
        if (x < 0 || y < 0 || x > old.gw - 1.001 || y > old.gh - 1.001) return 0;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * old.gw + x0;
        return (f[i] * (1 - fx) + f[i + 1] * fx) * (1 - fy) + (f[i + old.gw] * (1 - fx) + f[i + old.gw + 1] * fx) * fy;
      };
      const vs = old.cell / cell;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const sx = bx0 + (x + 0.5) * cell, sy = by0 + (y + 0.5) * cell, i = y * gw + x;
        T[i] = sOld(old.T, sx, sy); S[i] = sOld(old.S, sx, sy); St[i] = sOld(old.St, sx, sy);
        Uv[i] = sOld(old.Uv, sx, sy) * vs; Vv[i] = sOld(old.Vv, sx, sy) * vs;
      }
    }
    rebuildSources();
  }

  const toGX = (sx) => (sx - bx0) / cell - 0.5;
  const toGY = (sy) => (sy - by0) / cell - 0.5;
  const bedToSX = (x) => cx + x * UNIT;
  const bedToSY = (y) => baseY + y * UNIT;

  function logTopAt(log, x) {
    let top = Infinity;
    const ca = Math.cos(log.angle), sa = Math.sin(log.angle);
    for (let k = 0; k <= 24; k++) {
      const t = k / 24 - 0.5, px = log.x + ca * t * log.len, py = log.y + sa * t * log.len, dx = x - px;
      if (Math.abs(dx) < log.r) top = Math.min(top, py - Math.sqrt(log.r * log.r - dx * dx));
    }
    return top;
  }

  function rebuildSources() {
    fuel.fill(0); binTop.fill(0);
    const map = new Map();
    let bmin = NB, bmax = -1;
    for (const log of logs) {
      if (!log.landed) continue;
      const ca = Math.cos(log.angle), sa = Math.sin(log.angle), nx = sa, ny = -ca;
      const n = Math.ceil(log.len * UNIT / cell * 2) + 2;
      let lb0 = NB, lb1 = -1;
      for (let k = 0; k <= n; k++) {
        const t = k / n - 0.5, px = log.x + ca * t * log.len, py = log.y + sa * t * log.len;
        for (const rr of [0.5]) {
          const qx = px + nx * log.r * rr, qy = py + ny * log.r * rr;
          const gx = Math.round(toGX(bedToSX(qx))), gy = Math.round(toGY(bedToSY(qy)));
          if (gx < 1 || gx >= gw - 1 || gy < 1 || gy >= gh - 1) continue;
          const i = gy * gw + gx, b = binOf(qx);
          if (!map.has(i)) map.set(i, { i, b, w: 1 });
          fuel[b] = 1; if (!binTop[b] || qy < binTop[b]) binTop[b] = qy;
          bmin = Math.min(bmin, b); bmax = Math.max(bmax, b); lb0 = Math.min(lb0, b); lb1 = Math.max(lb1, b);
        }
      }
      log.b0 = lb0; log.b1 = lb1;
    }
    sources = [...map.values()];
    for (let b = bmin; b <= bmax; b++) { fuel[b] = 1; if (!binTop[b]) binTop[b] = -0.06; }
    bedSrc = [];
    for (const yy of [-0.03, -0.08]) {
      const gy = Math.round(toGY(bedToSY(yy)));
      for (let gx = 1; gx < gw - 1; gx++) {
        const bx = (bx0 + (gx + 0.5) * cell - cx) / UNIT, b = binOf(bx);
        if (fuel[b] && Math.abs(bx) < 0.95) bedSrc.push({ i: gy * gw + gx, b, w: (1 - (bx / 0.95) ** 2) * (0.5 + 0.5 * Math.random()) });
      }
    }
  }

  function nearestFuelBin(bedX) {
    const b0 = binOf(bedX);
    for (let d = 0; d < NB; d++) {
      if (b0 - d >= 0 && fuel[b0 - d]) return b0 - d;
      if (b0 + d < NB && fuel[b0 + d]) return b0 + d;
    }
    return -1;
  }

  // ---------- resize ----------
  function resize() {
    vw = innerWidth || document.documentElement.clientWidth || 360;
    vh = innerHeight || document.documentElement.clientHeight || 640;
    dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    UNIT = Math.min(vw * 0.4, vh * 0.34);
    sz = clamp(Math.min(vw, vh) / 700, 0.6, 1.3);
    cx = vw / 2; baseY = vh * (vh > vw ? 0.74 : 0.8);
    makeStatic();
    for (const l of logs) makeLogTex(l);
    allocGrid();
  }

  // ---------- fuel dynamics ----------
  let steamRate = 0, smoulder = 0;
  function updateBins(dt) {
    let sh = 0, se = 0, cnt = 0, mx = 0, sm = 0;
    const g = 0.6 * (0.6 + 0.4 * intensity);
    for (let b = 0; b < NB; b++) {
      if (!fuel[b]) { H[b] = 0; E[b] *= 0.98; W[b] *= 0.98; continue; }
      let nb = 0;
      for (let d = -2; d <= 2; d++) if (d && b + d >= 0 && b + d < NB && fuel[b + d]) nb = Math.max(nb, H[b + d]);
      let h = H[b];
      const w = W[b];
      if (h > 0.015 || nb > 0.15) h += dt * g * (h + 0.45 * nb) * (1 - h) * (1 - 0.92 * w);
      else h = Math.max(0, h - dt * 0.06);
      H[b] = clamp(h, 0, 1);
      if (h > E[b]) E[b] += (h - E[b]) * dt * 0.22;
      else E[b] = Math.max(0, E[b] - dt * (0.008 + 0.09 * w * (1 - h)));
      W[b] = Math.max(0, w - dt * (0.02 + 0.1 * h + 0.03 * E[b]));
      sh += h; se += E[b]; cnt++; mx = Math.max(mx, h); sm += E[b] * (1 - h);
    }
    meanH = cnt ? sh / cnt : 0; meanE = cnt ? se / cnt : 0; maxH = mx; smoulder = cnt ? sm / cnt : 0;
    for (const log of logs) {
      if (!log.landed || log.b1 < 0) continue;
      let s = 0, sh2 = 0, n = 0;
      for (let b = log.b0; b <= log.b1; b++) { s += E[b]; sh2 += H[b]; n++; }
      log.e = n ? s / n : 0;
      log.char = Math.min(0.92, log.char + dt * 0.012 * (n ? sh2 / n : 0));
    }
  }

  // ---------- simulation step ----------
  function sample(f, x, y) {
    if (x < 0) x = 0; else if (x > gw - 1.001) x = gw - 1.001;
    if (y < 0) y = 0; else if (y > gh - 1.001) y = gh - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * gw + x0;
    const a = f[i], b = f[i + 1], c = f[i + gw], d = f[i + gw + 1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  // pressure projection (Gauss-Seidel, warm-started): makes the flow incompressible so rising
  // hot gas pushes air ahead of it and draws fresh air in at the base
  function project(iters) {
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      DIV[i] = 0.5 * (Uv[i + 1] - Uv[i - 1] + Vv[i + gw] - Vv[i - gw]);
    }
    for (let it = 0; it < iters; it++) {
      for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x;
        P[i] = (P[i - 1] + P[i + 1] + P[i - gw] + P[i + gw] - DIV[i]) * 0.25;
      }
    }
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      Uv[i] -= 0.5 * (P[i + 1] - P[i - 1]);
      Vv[i] -= 0.5 * (P[i + gw] - P[i - gw]);
    }
  }

  let simT = 0;
  function step(dt) {
    const k = gw / 125;                // keep the look independent of grid resolution
    const nsc = 125 / gw;              // noise-space scale per cell
    const t = simT;
    const srcT = 1.12 * Math.sqrt(intensity);

    // fuel sources: hot cells on the log surfaces
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s], h = H[src.b];
      if (h < 0.004) continue;
      const fl = 0.45 + 1.0 * nz(src.b * 5.3, t * 22 + src.w * 37);
      const tv = src.w * srcT * Math.min(1, h * 1.4) * fl;
      if (T[src.i] < tv) T[src.i] = tv;
      const up = -18 * k * h;
      if (Vv[src.i] > up) Vv[src.i] = up;
    }
    let steamAdd = 0;
    for (let s = 0; s < bedSrc.length; s++) {
      const src = bedSrc[s], h = H[src.b], e = E[src.b], w = W[src.b];
      const fl = 0.5 + nz(src.i * 0.37, t * 9);
      const tv = (e * 0.3 + h * 0.5 * srcT) * fl * src.w;
      if (T[src.i] < tv) T[src.i] = tv;
      S[src.i] += e * (1 - h) * 1.3 * dt * fl;            // smouldering smoke
      const sa = w * e * 2.5 * dt; St[src.i] += sa; steamAdd += sa;  // wet hot coals steam
    }
    steamRate = steamRate * 0.9 + steamAdd * 0.4;

    // forces: buoyancy, turbulence, convergence, damping
    const buoy = 230 * k * (0.85 + 0.15 * intensity);
    const turb = 520 * k;
    const midX = toGX(cx);
    const du = Math.exp(-2.6 * dt), dv = Math.exp(-3.0 * dt);
    for (let y = 1; y < gh - 1; y++) {
      const v = y * nsc;
      for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x, tt = T[i];
        const u = x * nsc;
        Vv[i] = (Vv[i] - (buoy * tt + 70 * k * St[i] + 45 * k * S[i]) * dt) * dv;
        const n = nz(u * 1.4 + 31, v * 1.4 + t * 70 * k * nsc) - 0.5;
        Uv[i] = (Uv[i] + (n * turb * (0.25 + tt) + (midX - x) * 0.9 * tt) * dt) * du;
      }
    }
    // vorticity confinement for curling tongues and smoke swirls
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      CU[i] = 0.5 * (Vv[i + 1] - Vv[i - 1] - Uv[i + gw] + Uv[i - gw]);
    }
    const eps = 3.2 * dt;
    for (let y = 2; y < gh - 2; y++) for (let x = 2; x < gw - 2; x++) {
      const i = y * gw + x;
      const gx = Math.abs(CU[i + 1]) - Math.abs(CU[i - 1]), gy = Math.abs(CU[i + gw]) - Math.abs(CU[i - gw]);
      const len = Math.sqrt(gx * gx + gy * gy) + 1e-5, c = CU[i];
      Uv[i] += eps * (gy / len) * c;
      Vv[i] -= eps * (gx / len) * c;
    }
    project(14);
    // semi-Lagrangian advection
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x, px = x - Uv[i] * dt, py = y - Vv[i] * dt;
      U2[i] = sample(Uv, px, py); V2[i] = sample(Vv, px, py);
      T2[i] = sample(T, px, py); S2[i] = sample(S, px, py); St2[i] = sample(St, px, py);
    }
    let tmp;
    tmp = Uv; Uv = U2; U2 = tmp; tmp = Vv; Vv = V2; V2 = tmp;
    tmp = T; T = T2; T2 = tmp; tmp = S; S = S2; S2 = tmp; tmp = St; St = St2; St2 = tmp;

    // cooling with a scrolling noise field -> flame tongues; smoke & steam dissipation
    const coolBase = 0.85 / (0.55 + 0.45 * intensity), coolAmp = 2.8 / (0.7 + 0.3 * intensity);
    const scroll = t * 95 * k * nsc;
    const sd = Math.exp(-0.42 * dt), std = Math.exp(-1.1 * dt);
    for (let y = 0; y < gh; y++) {
      const v = y * nsc;
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x, a = absorb[i];
        let tt = T[i];
        if (tt > 0.001) {
          const n = nz(x * nsc * 2.2, v * 2.2 + scroll);
          const c = (coolBase + coolAmp * n * n) * dt;
          const nt = tt > c ? tt - c : 0;
          S[i] += (tt - nt) * 0.07;
          tt = nt;
        } else tt = 0;
        T[i] = tt * a;
        S[i] *= sd * a;
        St[i] *= std * a;
      }
    }
  }

  // ---------- input ----------
  let ptr = null, lastTap = { t: 0, x: 0, y: 0 };
  let spraying = 0, sprayAim = { x: 0, y: 0 }, hoseSide = 1, hoseShow = 0;
  let igniting = false, igniteT = 0, igPos = { x: 0, y: 0 }, igReach = 0, strikeTimer = 0, matchShow = 0;

  function onDown(e) {
    if (ptr) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), type: e.pointerType, hold: false, mode: null, moved: 0 };
    FireAudio.unlock();
    requestWake();
    wakeUI();
    if (wantSound && !FireAudio.enabled) setSound(true);
  }
  function onMove(e) {
    if (e.pointerType === 'mouse') wakeUI();
    if (!ptr || e.pointerId !== ptr.id) return;
    ptr.x = e.clientX; ptr.y = e.clientY;
    ptr.moved = Math.max(ptr.moved, Math.hypot(ptr.x - ptr.sx, ptr.y - ptr.sy));
  }
  function onUp(e) {
    if (!ptr || e.pointerId !== ptr.id) return;
    const dur = performance.now() - ptr.t0;
    if (!ptr.hold && dur < 300 && ptr.moved < 18 && e.type === 'pointerup') tap(ptr.x, ptr.y);
    ptr = null; igniting = false;
  }
  cv.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  function updateInput(dt) {
    const now = performance.now();
    if (ptr && !ptr.hold && now - ptr.t0 > 240) {
      ptr.hold = true;
      ptr.mode = (meanH > 0.07 || maxH > 0.2) ? 'spray' : 'ignite';
      if (ptr.mode === 'ignite') { igniting = true; igniteT = 0; strikeTimer = 0; }
      hintSeen[ptr.mode] = true;
    }
    const isSpray = ptr && ptr.hold && ptr.mode === 'spray';
    spraying = lerp(spraying, isSpray ? 1 : 0, 1 - Math.exp(-dt * (isSpray ? 10 : 6)));
    hoseShow = lerp(hoseShow, isSpray ? 1 : 0, 1 - Math.exp(-dt * (isSpray ? 9 : 3)));
    if (isSpray) {
      sprayAim.x = ptr.x; sprayAim.y = ptr.y;
      hoseSide = ptr.x < cx - UNIT * 0.2 ? -1 : ptr.x > cx + UNIT * 0.2 ? 1 : hoseSide;
    }
    if (spraying > 0.05) emitSpray(dt);

    matchShow = lerp(matchShow, igniting && igniteT > 0.35 ? 1 : 0, 1 - Math.exp(-dt * 8));
    if (igniting && ptr) {
      igniteT += dt;
      const off = ptr.type === 'touch' ? 56 * sz : 0;
      igPos.x = ptr.x; igPos.y = ptr.y - off;
      const bedX = (igPos.x - cx) / UNIT;
      const b = nearestFuelBin(bedX);
      let d = 9;
      if (b >= 0) d = Math.hypot(bedX - binX(b), (igPos.y - baseY) / UNIT - binTop[b]);
      igReach = clamp(1.5 - d / 0.45, 0, 1);
      if (igniteT < 0.4) {
        strikeTimer -= dt;
        if (strikeTimer <= 0) {
          strikeTimer = 0.13;
          for (let i = 0; i < 9; i++) spawnSpark(igPos.x, igPos.y, rand(-260, 260), rand(-260, 60), rand(0.3, 0.7), 'flint');
          FireAudio.strike((igPos.x - cx) / vw * 2);
        }
      } else {
        // match flame: inject heat into the grid at the flame point
        const gx = Math.round(toGX(igPos.x)), gy = Math.round(toGY(igPos.y));
        for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx, y = gy + dy;
          if (x > 0 && x < gw - 1 && y > 0 && y < gh - 1) {
            const i = y * gw + x, tv = (dx ? 0.75 : 1.05) * (0.8 + 0.4 * Math.random());
            if (T[i] < tv) T[i] = tv;
            Vv[i] = Math.min(Vv[i], -30 * gw / 125);
          }
        }
        // catching: kindling takes a moment, wet wood takes longer
        if (b >= 0 && igReach > 0 && igniteT > 0.65) {
          for (let dd = -3; dd <= 3; dd++) {
            const bb = b + dd;
            if (bb < 0 || bb >= NB || !fuel[bb]) continue;
            const f = (1 - Math.abs(dd) / 4) * igReach;
            H[bb] = Math.min(1, H[bb] + dt * 0.3 * f * Math.max(0, 1 - 1.4 * W[bb]));
            W[bb] = Math.max(0, W[bb] - dt * 0.7 * f);
          }
          if (Math.random() < dt * 8) spawnSpark(igPos.x, igPos.y, rand(-40, 40), rand(-120, -40), rand(0.5, 1.2), 'ember');
        }
      }
    }
  }

  function tap(x, y) {
    const now = performance.now();
    const dbl = now - lastTap.t < 340 && Math.hypot(x - lastTap.x, y - lastTap.y) < 70;
    lastTap = { t: dbl ? 0 : now, x, y };
    if (dbl) { addLog(x); hintSeen.log = true; } else poke(x, y);
  }

  function poke(x, y) {
    const bedX = (x - cx) / UNIT, b = nearestFuelBin(bedX);
    if (b < 0) return;
    hintSeen.poke = true;
    const sx = bedToSX(binX(b)), sy = bedToSY(binTop[b]);
    const n = 10 + Math.round(40 * Math.max(meanH, E[b] * 0.6));
    for (let i = 0; i < n; i++) spawnSpark(sx + rand(-10, 10) * sz, sy, rand(-90, 90), rand(-420, -120), rand(0.6, 2.2), 'ember');
    for (let d = -4; d <= 4; d++) {
      const bb = b + d; if (bb < 0 || bb >= NB || !fuel[bb]) continue;
      const f = 1 - Math.abs(d) / 5;
      if (H[bb] > 0.02) H[bb] = Math.min(1, H[bb] + 0.15 * f);
      else if (E[bb] > 0.35 && W[bb] < 0.3) H[bb] += 0.03 * f * E[bb];   // a poke can rekindle hot embers
    }
    for (const l of logs) if (l.landed && b >= l.b0 - 3 && b <= l.b1 + 3) l.jig = 1;
    const gx = Math.round(toGX(sx)), gy = Math.round(toGY(sy));
    for (let dy = -2; dy <= 1; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = gx + dx, yy = gy + dy; if (xx < 1 || xx >= gw - 1 || yy < 1 || yy >= gh - 1) continue;
      const i = yy * gw + xx; Vv[i] -= 60 * gw / 125; S[i] += 0.15 * E[b];
    }
    const pan = (sx - cx) / vw * 2;
    FireAudio.thud(0.4, pan);
    FireAudio.pop(0.5 * Math.max(0.3, meanH), pan);
  }

  function addLog(x) {
    if (logs.length >= 7) { showHint('That’s plenty of wood for now', 2500); poke(x, baseY - UNIT * 0.3); return; }
    const len = rand(1.0, 1.4), r = rand(0.115, 0.15), angle = rand(-0.38, 0.38);
    const lx = clamp((x - cx) / UNIT, -0.5, 0.5);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    let rest = -r;
    for (let k = 0; k <= 16; k++) {
      const t = k / 16 - 0.5, px = lx + ca * t * len, py = sa * t * len;
      let top = 0;
      for (const l of logs) if (l.landed) top = Math.min(top, logTopAt(l, px));
      rest = Math.min(rest, top - r - py);
    }
    const log = newLog(lx, rest - 3.2, len, r, angle, Math.random() < 0.5);
    log.char = 0; log.landed = false; log.rest = rest;
    makeLogTex(log);
    logs.push(log);
  }

  function landLog(log) {
    log.landed = true; log.y = log.rest; log.jig = 1.4;
    rebuildSources();
    const sx = bedToSX(log.x), sy = bedToSY(log.y);
    for (let b = log.b0; b <= log.b1; b++) H[b] *= 0.65;   // briefly smothers, then flares
    for (let i = 0; i < 50 * Math.max(0.2, meanH); i++) spawnSpark(sx + rand(-0.5, 0.5) * log.len * UNIT, sy, rand(-160, 160), rand(-500, -100), rand(0.6, 2.4), 'ember');
    for (let i = 0; i < 4; i++) puffs.push({ x: sx + rand(-0.4, 0.4) * UNIT, y: sy, vx: rand(-20, 20), vy: rand(-50, -20), r: UNIT * 0.15, gr: UNIT * 0.3, life: 0, max: rand(1.5, 2.5), a: 0.25, smoke: true });
    FireAudio.thud(0.8, (sx - cx) / vw * 2);
    FireAudio.pop(0.6, (sx - cx) / vw * 2);
  }

  // ---------- particles ----------
  function spawnSpark(x, y, vx, vy, life, kind) {
    if (sparks.length > 420) return;
    sparks.push({ x, y, px: x, py: y, vx: vx * sz, vy: vy * sz, life, max: life, kind, w: rand(0.6, 1.6) * sz, seed: Math.random() * 100 });
  }

  function emitSpray(dt) {
    const tip = nozzleTip();
    const n = Math.round(320 * spraying * dt + Math.random());
    for (let i = 0; i < n; i++) {
      if (drops.length > 500) break;
      const dist = Math.hypot(sprayAim.x - tip.x, sprayAim.y - tip.y);
      const spread = (14 + dist * 0.09) * Math.sqrt(-2 * Math.log(Math.random() + 1e-6));
      const a = Math.random() * Math.PI * 2;
      const tx = sprayAim.x + Math.cos(a) * spread, ty = sprayAim.y + Math.sin(a) * spread * 0.6;
      drops.push({ x0: tip.x, y0: tip.y, x1: tx, y1: ty, t: 0, dur: rand(0.2, 0.3) * (0.5 + dist / Math.max(vw, vh)), arc: -dist * rand(0.08, 0.16), px: tip.x, py: tip.y, x: tip.x, y: tip.y });
    }
  }

  function waterHit(sx, sy) {
    const gx = Math.round(toGX(sx)), gy = Math.round(toGY(sy));
    const bedX = (sx - cx) / UNIT, bedY = (sy - baseY) / UNIT;
    let heat = 0;
    if (gx > 2 && gx < gw - 3 && gy > 2 && gy < gh - 3) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const i = (gy + dy) * gw + gx + dx, tt = T[i];
        heat += tt;
        T[i] = tt * 0.6;
        St[i] += tt * 0.22 + 0.006;
        Vv[i] *= 0.9;
      }
    }
    // effect on the fuel: strongest when the water lands on the logs / flame base
    const b = binOf(bedX);
    if (Math.abs(bedX) < 1.3) {
      const top = fuel[b] ? binTop[b] : -0.1;
      const above = top - bedY;                 // how far above the wood surface the drop landed
      const onWood = above < 0.25 ? 1 : clamp(1 - (above - 0.25) / 1.2, 0.08, 1);
      for (let d = -3; d <= 3; d++) {
        const bb = b + d; if (bb < 0 || bb >= NB || !fuel[bb]) continue;
        const f = (1 - Math.abs(d) / 4) * onWood;
        H[bb] = Math.max(0, H[bb] - 0.016 * f * (0.6 + W[bb]));
        W[bb] = Math.min(1, W[bb] + 0.01 * f);
        const evap = E[bb] * 0.0012 * f;
        E[bb] = Math.max(0, E[bb] - evap * 0.7);
        heat += evap * 30;
      }
    }
    steamRate += heat * 0.015;
    if (heat > 0.25 && Math.random() < 0.18 && puffs.length < 90) {
      puffs.push({ x: sx, y: sy, vx: rand(-25, 25), vy: rand(-90, -40), r: UNIT * rand(0.06, 0.12), gr: UNIT * rand(0.35, 0.6), life: 0, max: rand(1.4, 2.6), a: clamp(heat * 0.12, 0.08, 0.32), smoke: false });
    }
    if (Math.random() < 0.3) spawnSpark(sx, sy, rand(-120, 120), rand(-160, -30), rand(0.2, 0.45), 'splash');
  }

  function updateParticles(dt) {
    // ambient sparks from the fire, and crackles linked to them
    const rate = meanH * (6 + 22 * intensity);
    let n = rate * dt; while (n > 0) { if (Math.random() < n) emitFireSpark(); n -= 1; }
    crackleClock -= dt;
    const crackRate = meanH * (3 + 12 * intensity) + meanE * 1.5;
    while (crackleClock < 0) {
      crackleClock += -Math.log(Math.random() + 1e-6) / Math.max(0.05, crackRate);
      const b = randomBurningBin();
      if (b < 0) break;
      const pan = (bedToSX(binX(b)) - cx) / vw * 2;
      if (Math.random() < 0.1 && H[b] > 0.25) {
        FireAudio.pop(0.35 + 0.4 * H[b], pan);
        const sx = bedToSX(binX(b)), sy = bedToSY(binTop[b]);
        for (let i = 0; i < 6 + Math.random() * 12; i++) spawnSpark(sx, sy, rand(-150, 150), rand(-450, -150), rand(0.5, 1.8), 'ember');
      } else FireAudio.crackle(0.25 + 0.6 * Math.max(H[b], E[b] * 0.5), pan);
    }
    // smouldering smoke puffs once the flames are down
    if (smoulder > 0.05 && Math.random() < smoulder * dt * 6 && puffs.length < 90) {
      const b = randomFuelBin();
      if (b >= 0) puffs.push({ x: bedToSX(binX(b)), y: bedToSY(binTop[b]), vx: rand(-10, 10), vy: rand(-45, -25), r: UNIT * 0.08, gr: UNIT * 0.35, life: 0, max: rand(2.5, 4), a: 0.18 * Math.min(1, smoulder * 2), smoke: true });
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life -= dt;
      if (p.life <= 0 || p.y < -20 || p.y > vh + 20) { sparks[i] = sparks[sparks.length - 1]; sparks.pop(); continue; }
      p.px = p.x; p.py = p.y;
      if (p.kind === 'ember') {
        const gx = toGX(p.x), gy = toGY(p.y);
        if (gx > 0 && gx < gw - 1 && gy > 0 && gy < gh - 1) {
          const gvx = sample(Uv, gx, gy) * cell, gvy = sample(Vv, gx, gy) * cell;
          p.vx += (gvx - p.vx) * dt * 1.6; p.vy += (gvy - p.vy) * dt * 1.2;
        }
        p.vy -= 40 * sz * dt;
        p.vx += (nz(p.seed * 40, simT * 30) - 0.5) * 900 * sz * dt;
        p.vx *= Math.exp(-0.6 * dt); p.vy *= Math.exp(-0.5 * dt);
      } else if (p.kind === 'flint') {
        p.vy += 700 * sz * dt; p.vx *= Math.exp(-2 * dt);
      } else {
        p.vy += 900 * sz * dt;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.t += dt / d.dur;
      d.px = d.x; d.py = d.y;
      const t = Math.min(1, d.t);
      d.x = lerp(d.x0, d.x1, t); d.y = lerp(d.y0, d.y1, t) + d.arc * 4 * t * (1 - t);
      if (d.t >= 1) { waterHit(d.x1, d.y1); drops[i] = drops[drops.length - 1]; drops.pop(); }
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.life += dt;
      if (p.life > p.max) { puffs[i] = puffs[puffs.length - 1]; puffs.pop(); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy *= Math.exp(-0.25 * dt);
      p.vx += (nz(p.x * 0.01, simT * 2 + i) - 0.5) * 60 * dt;
      p.r += p.gr * dt / p.max;
    }
  }
  let crackleClock = 0;
  function randomBurningBin() {
    for (let tries = 0; tries < 12; tries++) {
      const b = (Math.random() * NB) | 0;
      if (fuel[b] && (H[b] > 0.05 || E[b] > 0.2)) return b;
    }
    return -1;
  }
  function randomFuelBin() {
    for (let tries = 0; tries < 12; tries++) { const b = (Math.random() * NB) | 0; if (fuel[b] && E[b] > 0.05) return b; }
    return -1;
  }
  function emitFireSpark() {
    const b = randomBurningBin(); if (b < 0 || H[b] < 0.1) return;
    const sx = bedToSX(binX(b) + rand(-0.02, 0.02)), sy = bedToSY(binTop[b]) - rand(0, 0.3) * UNIT * H[b];
    spawnSpark(sx, sy, rand(-40, 40), rand(-260, -80), rand(0.8, 2.6) * (0.6 + 0.4 * intensity), 'ember');
  }

  // ---------- rendering ----------
  function nozzleTip() {
    const bx = hoseSide > 0 ? vw - 34 * sz : 34 * sz;
    const by = vh + 30 * sz - 120 * sz * hoseShow;
    const ang = Math.atan2(sprayAim.y - by, sprayAim.x - bx);
    const L = 92 * sz;
    return { x: bx + Math.cos(ang) * L, y: by + Math.sin(ang) * L, bx, by, ang };
  }

  function renderFields() {
    const fd = fireImg.data, sdt = smokeImg.data;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const m = rmask[i];
      const tt = T[i] * m;
      const li = (tt >= 1.5 ? 255 : (tt * 170) | 0) * 3;
      fd[j] = LUT[li]; fd[j + 1] = LUT[li + 1]; fd[j + 2] = LUT[li + 2];
      const s = S[i], st = St[i];
      const a = Math.min(0.85, s * 0.55 + st * 0.75) * m;
      if (a < 0.004) { sdt[j + 3] = 0; continue; }
      const mix = st / (s + st + 1e-6), glow = Math.min(1, T[i]) * 90 + light * 14;
      sdt[j] = 52 + mix * 170 + glow; sdt[j + 1] = 47 + mix * 175 + glow * 0.55; sdt[j + 2] = 44 + mix * 180 + glow * 0.25;
      sdt[j + 3] = a * 255;
    }
    fireCx.putImageData(fireImg, 0, 0);
    smokeCx.putImageData(smokeImg, 0, 0);
    bloomCx.clearRect(0, 0, bloomCv.width, bloomCv.height);
    bloomCx.drawImage(fireCv, 0, 0, bloomCv.width, bloomCv.height);
  }

  function drawStone(s, L) {
    const x = bedToSX(s.x), y = bedToSY(s.y), rx = s.rx * UNIT, ry = s.ry * UNIT;
    const dirX = (cx - x) / UNIT, toward = s.front ? -1 : 1;
    const hx = x + clamp(dirX, -1, 1) * rx * 0.5, hy = y + toward * ry * 0.45 - (s.front ? ry * 0.3 : 0);
    const gr = ctx.createRadialGradient(hx, hy, 0, x, y, Math.max(rx, ry) * 1.2);
    const lit = L * (s.front ? 0.55 : 1) * s.s;
    gr.addColorStop(0, `rgb(${30 + 150 * lit | 0},${26 + 70 * lit | 0},${24 + 30 * lit | 0})`);
    gr.addColorStop(0.6, `rgb(${20 + 50 * lit | 0},${17 + 22 * lit | 0},${16 + 10 * lit | 0})`);
    gr.addColorStop(1, '#0a0807');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawFire(alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(fireCv, bx0, by0, gw * cell, gh * cell);
    ctx.globalAlpha = 1;
  }

  function drawLog(log, L) {
    const tx = log.tex; if (!tx) return;
    const jig = log.jig > 0 ? Math.sin(simT * 40) * log.jig * 0.012 : 0;
    ctx.save();
    ctx.translate(bedToSX(log.x + jig), bedToSY(log.y));
    ctx.rotate(log.angle + jig * 0.5);
    ctx.drawImage(tx.bark, -tx.w / 2, -tx.h / 2);
    if (log.char > 0.01) { ctx.globalAlpha = log.char; ctx.drawImage(tx.char, -tx.w / 2, -tx.h / 2); }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(L * 0.24, 0, 1);
    ctx.drawImage(tx.hi, -tx.w / 2, -tx.h / 2);
    const g = log.e * (0.6 + 0.4 * nz(log.seed, simT * 3)) * Math.min(1, log.char * 1.2 + 0.1) * (1 - 0.5 * light);
    if (g > 0.01) { ctx.globalAlpha = clamp(g, 0, 1); ctx.drawImage(tx.glow, -tx.w / 2, -tx.h / 2); }
    ctx.restore();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function drawHose() {
    if (hoseShow < 0.01) return;
    const n = nozzleTip(), { bx, by, ang } = n;
    ctx.save();
    // hose
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#4a0c08'; ctx.lineWidth = 26 * sz;
    ctx.beginPath(); ctx.moveTo(bx + hoseSide * 120 * sz, vh + 80 * sz);
    ctx.quadraticCurveTo(bx + hoseSide * 10 * sz, by + 70 * sz, bx, by); ctx.stroke();
    ctx.strokeStyle = '#a3241a'; ctx.lineWidth = 20 * sz; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,170,140,0.25)'; ctx.lineWidth = 4 * sz; ctx.stroke();
    ctx.translate(bx, by); ctx.rotate(ang);
    const L = 92 * sz;
    // coupling
    ctx.fillStyle = '#b8862e'; ctx.fillRect(-8 * sz, -14 * sz, 18 * sz, 28 * sz);
    // nozzle barrel
    const gr = ctx.createLinearGradient(0, -12 * sz, 0, 12 * sz);
    gr.addColorStop(0, '#5a5f66'); gr.addColorStop(0.35, '#e3e7ec'); gr.addColorStop(1, '#2c3036');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.moveTo(10 * sz, -12 * sz); ctx.lineTo(L - 16 * sz, -8 * sz); ctx.lineTo(L - 16 * sz, 8 * sz); ctx.lineTo(10 * sz, 12 * sz); ctx.closePath(); ctx.fill();
    // red tip bumper
    ctx.fillStyle = '#c0261b'; ctx.beginPath(); ctx.moveTo(L - 18 * sz, -10 * sz); ctx.lineTo(L, -7 * sz); ctx.lineTo(L, 7 * sz); ctx.lineTo(L - 18 * sz, 10 * sz); ctx.closePath(); ctx.fill();
    // pistol grip + bale
    ctx.fillStyle = '#16181b';
    ctx.fillRect(18 * sz, 10 * sz, 14 * sz, 30 * sz);
    ctx.strokeStyle = '#16181b'; ctx.lineWidth = 5 * sz;
    ctx.beginPath(); ctx.moveTo(40 * sz, -12 * sz); ctx.lineTo(56 * sz, -26 * sz); ctx.stroke();
    ctx.restore();
    // jet core
    if (spraying > 0.05) {
      ctx.save();
      ctx.globalAlpha = 0.22 * spraying;
      ctx.strokeStyle = 'rgb(205,228,255)'; ctx.lineCap = 'round'; ctx.lineWidth = 7 * sz;
      const dist = Math.hypot(sprayAim.x - n.x, sprayAim.y - n.y);
      const mx = (n.x + sprayAim.x) / 2, my = (n.y + sprayAim.y) / 2 - dist * 0.24;
      ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.quadraticCurveTo(mx, my, lerp(n.x, sprayAim.x, 0.55), lerp(n.y, sprayAim.y, 0.55) - dist * 0.1); ctx.stroke();
      ctx.restore();
    }
  }

  function drawMatch() {
    if (matchShow < 0.02 && !(igniting && igniteT < 0.4)) return;
    const x = igPos.x, y = igPos.y;
    ctx.save();
    // match stick
    ctx.globalAlpha = Math.max(matchShow, igniting ? 1 : 0);
    ctx.strokeStyle = '#c9a36a'; ctx.lineWidth = 4 * sz; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x + 4 * sz, y + 8 * sz); ctx.lineTo(x + 34 * sz, y + 70 * sz); ctx.stroke();
    ctx.fillStyle = matchShow > 0.5 ? '#2a1610' : '#8c1f17';
    ctx.beginPath(); ctx.ellipse(x + 4 * sz, y + 8 * sz, 4 * sz, 5.5 * sz, -0.45, 0, 7); ctx.fill();
    // glow around the flame
    if (matchShow > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      const r = 70 * sz * (0.9 + 0.2 * Math.random());
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,190,90,${0.5 * matchShow})`); gr.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      // small drawn flame so it reads even outside the sim box
      const f = 1 + 0.15 * Math.sin(simT * 31) + 0.1 * Math.sin(simT * 47);
      const fg = ctx.createRadialGradient(x, y - 4 * sz, 0, x, y - 6 * sz, 14 * sz);
      fg.addColorStop(0, 'rgba(255,250,220,0.95)'); fg.addColorStop(0.5, 'rgba(255,170,60,0.7)'); fg.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = fg;
      ctx.beginPath(); ctx.moveTo(x, y - 22 * sz * f);
      ctx.quadraticCurveTo(x + 9 * sz, y - 2 * sz, x, y + 5 * sz); ctx.quadraticCurveTo(x - 9 * sz, y - 2 * sz, x, y - 22 * sz * f); ctx.fill();
    }
    ctx.restore();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bgCv, 0, 0, vw, vh);
    const L = light;

    // ambient glow on the surroundings
    ctx.globalCompositeOperation = 'lighter';
    let gr = ctx.createRadialGradient(cx, baseY - UNIT * 0.6, 0, cx, baseY - UNIT * 0.6, Math.max(vw, vh) * (0.45 + 0.3 * L));
    gr.addColorStop(0, `rgba(255,130,50,${0.30 * L})`); gr.addColorStop(0.35, `rgba(220,80,25,${0.11 * L})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, vw, vh);
    ctx.save(); ctx.translate(cx, baseY + UNIT * 0.05); ctx.scale(1, 0.26);
    const gR = UNIT * (1.8 + 1.4 * L);
    gr = ctx.createRadialGradient(0, 0, 0, 0, 0, gR);
    gr.addColorStop(0, `rgba(255,140,60,${0.55 * L})`); gr.addColorStop(0.5, `rgba(200,70,20,${0.18 * L})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, gR, 0, 7); ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';

    for (const s of stones) if (!s.front) drawStone(s, L);

    // coal bed
    ctx.save(); ctx.translate(cx, baseY); ctx.scale(1, 0.18);
    gr = ctx.createRadialGradient(0, 0, 0, 0, 0, UNIT * 1.05);
    gr.addColorStop(0, '#120a07'); gr.addColorStop(1, 'rgba(10,6,5,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, UNIT * 1.05, 0, 7); ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'lighter';
    for (const c of coalSpecks) {
      const e = E[binOf(c.x)];
      const a = e * (0.4 + 0.6 * nz(c.ph * 10, simT * 2));
      if (a < 0.03) continue;
      ctx.fillStyle = `rgba(255,${80 + 90 * a | 0},20,${Math.min(1, a)})`;
      ctx.beginPath(); ctx.arc(bedToSX(c.x), bedToSY(c.y), c.r * UNIT, 0, 7); ctx.fill();
    }

    drawFire(1);
    // bloom (behind the logs so they read as silhouettes against the flames)
    const pad = 0.12;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(bloomCv, bx0 - gw * cell * pad, by0 - gh * cell * pad, gw * cell * (1 + 2 * pad), gh * cell * (1 + 2 * pad));
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const l of logs) drawLog(l, L);
    ctx.globalCompositeOperation = 'lighter';
    drawFire(0.16);
    ctx.globalCompositeOperation = 'source-over';

    for (const s of stones) if (s.front) drawStone(s, L);

    // smoke & steam
    ctx.drawImage(smokeCv, bx0, by0, gw * cell, gh * cell);
    for (const p of puffs) {
      const u = p.life / p.max, a = p.a * Math.sin(Math.PI * Math.min(1, u * 1.2)) * (1 - u);
      if (a < 0.005) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(p.smoke ? smokeSprite : puffSprite, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    }
    ctx.globalAlpha = 1;

    // sparks
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of sparks) {
      const u = p.life / p.max;
      let col;
      if (p.kind === 'splash') col = `rgba(190,215,255,${0.7 * u})`;
      else if (p.kind === 'flint') col = `rgba(255,${200 + 55 * u | 0},${120 + 120 * u | 0},${u})`;
      else {
        const tw = 0.65 + 0.35 * Math.sin(simT * 25 + p.seed * 9);
        col = `rgba(255,${70 + 150 * u | 0},${20 + 60 * u * u | 0},${Math.min(1, u * 1.6) * tw})`;
      }
      ctx.strokeStyle = col; ctx.lineWidth = p.w * (p.kind === 'ember' ? 1.6 : 1.2);
      ctx.beginPath(); ctx.moveTo(p.px - (p.x - p.px) * 0.8, p.py - (p.y - p.py) * 0.8); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    // water droplets
    if (drops.length) {
      ctx.strokeStyle = 'rgba(200,225,255,0.6)';
      for (const d of drops) {
        ctx.lineWidth = (2.6 - 1.6 * d.t) * sz;
        ctx.beginPath(); ctx.moveTo(d.px, d.py); ctx.lineTo(d.x, d.y); ctx.stroke();
      }
    }
    drawHose();
    drawMatch();

    ctx.drawImage(vigCv, 0, 0, vw, vh);
  }

  // ---------- main loop ----------
  let last = performance.now(), workEMA = 8, perfClock = 0, upgraded = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    advance(now);
  }
  function advance(now) {
    let dt = (now - last) / 1000; last = now;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1 / 24);
    const w0 = performance.now();
    simT += dt;
    updateInput(dt);
    updateBins(dt);
    // falling logs
    for (const l of logs) {
      if (l.jig > 0) l.jig = Math.max(0, l.jig - dt * 3);
      if (!l.landed) { l.vy += 9 * dt; l.y += l.vy * dt; if (l.y >= l.rest) landLog(l); }
    }
    step(dt);
    updateParticles(dt);
    lightTarget = clamp(meanH * (0.75 + 0.3 * intensity) + meanE * 0.22 + matchShow * 0.08, 0, 1.4);
    const flick = nz(simT * 9, 5.5) * 0.7 + nz(simT * 23, 77) * 0.3;
    light = lerp(light, lightTarget * (0.82 + 0.3 * flick), 1 - Math.exp(-dt * 12));
    FireAudio.update(meanH * (0.7 + 0.3 * intensity), spraying, steamRate, flick);
    renderFields();
    render();
    updateHints(dt);
    adaptQuality(performance.now() - w0, dt);
  }

  function adaptQuality(work, dt) {
    workEMA = lerp(workEMA, work, 0.05);
    perfClock += dt;
    if (perfClock < 2.5) return;
    if (workEMA > 13 && gridCols > MIN_COLS) {
      gridCols = Math.max(MIN_COLS, Math.round(gridCols * 0.82)); perfClock = 0; allocGrid();
    } else if (workEMA > 13 && dprCap > 1) {
      dprCap = 1; perfClock = 0; resize();
    } else if (workEMA < 5 && gridCols < MAX_COLS && upgraded < 2 && perfClock > 5) {
      gridCols = Math.min(MAX_COLS, Math.round(gridCols * 1.15)); upgraded++; perfClock = 0; allocGrid();
    }
  }

  // ---------- hints ----------
  const hintEl = $('hint');
  const hintSeen = { spray: false, ignite: false, poke: false, log: false };
  let hintTimer = 0, hintIdle = 0, hintText = '';
  function showHint(text, ms) {
    hintText = text; hintEl.textContent = text; hintEl.classList.add('show');
    hintTimer = (ms || 4000) / 1000;
  }
  function updateHints(dt) {
    if (hintTimer > 0) { hintTimer -= dt; if (hintTimer <= 0) hintEl.classList.remove('show'); return; }
    hintIdle += dt;
    if (hintIdle < 1.5) return;
    if (igniting && igniteT > 1.2 && igReach < 0.05) { showHint('Bring the flame down to the logs', 2200); return; }
    if (igniting && igniteT > 2 && meanH < 0.03) {
      let w = 0, c = 0; for (let b = 0; b < NB; b++) if (fuel[b]) { w += W[b]; c++; }
      if (c && w / c > 0.3) { showHint('The wood is soaked — keep holding', 2500); return; }
    }
    if (ptr) return;
    if (maxH < 0.01 && meanE < 0.6 && hintIdle > 3 && !(hintSeen.ignite && hintIdle < 25)) {
      showHint('Tap and hold to relight', 4000); hintIdle = 0; return;
    }
    if (!hintSeen.spray && maxH > 0.3 && hintIdle > 4) { showHint('Tap and hold to put the fire out', 4500); hintIdle = -6; return; }
    if (hintSeen.spray && !hintSeen.poke && maxH > 0.3 && hintIdle > 20) { showHint('Tap to poke the fire · double-tap to add a log', 4500); hintIdle = -20; }
  }

  // ---------- UI ----------
  const ui = $('ui'), muteBtn = $('mute'), slider = $('intensity'), fsBtn = $('fs');
  let uiTimer = 0;
  function wakeUI() {
    ui.classList.add('awake');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => ui.classList.remove('awake'), 3500);
  }
  wakeUI();
  ui.addEventListener('pointerdown', (e) => { e.stopPropagation(); wakeUI(); });
  slider.value = intensity;
  slider.addEventListener('input', () => { intensity = +slider.value; store.set('intensity', intensity); wakeUI(); });
  function setSound(v) {
    const ok = FireAudio.setEnabled(v);
    muteBtn.classList.toggle('sound', ok && v);
    muteBtn.setAttribute('aria-label', ok && v ? 'Mute sound' : 'Turn sound on');
  }
  muteBtn.classList.toggle('sound', false);
  muteBtn.addEventListener('click', () => {
    wantSound = !FireAudio.enabled; store.set('sound', wantSound); setSound(wantSound); wakeUI();
  });
  const fsEl = document.documentElement;
  if (!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen)) fsBtn.style.display = 'none';
  fsBtn.addEventListener('click', () => {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
    wakeUI();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'm' || e.key === 'M') muteBtn.click();
    if (e.key === 'f' || e.key === 'F') fsBtn.click();
  });

  // ---------- screen wake lock ----------
  let wakeLock = null;
  async function requestWake() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { requestWake(); last = performance.now(); }
  });

  // ---------- boot ----------
  initLogs();
  initStones();
  let rzTimer = 0;
  addEventListener('resize', () => { clearTimeout(rzTimer); rzTimer = setTimeout(resize, 120); });
  resize();
  for (let b = 0; b < NB; b++) if (fuel[b]) { H[b] = rand(0.75, 1); E[b] = rand(0.5, 0.7); }
  // warm the simulation up so the first frame already shows flames
  for (let i = 0; i < 100; i++) { simT += 1 / 60; updateBins(1 / 60); step(1 / 60); }
  requestWake();
  requestAnimationFrame((t) => { last = t; frame(t); });

})();
