/* ==========================================================================
   人が描いた街、AIが見つけた街 — Map / UI controller
   データ: grid.js (Overture buildings を出どころ別に集計)
           search.js (Overture divisions + places の地名・駅名)
           footprints_*.js (注目エリアの建物の形)
   ========================================================================== */
(function () {
  "use strict";

  const G = window.SOURCE_GRID;
  const SEARCH = window.SEARCH_INDEX.entries; // [lng, lat, name, ward, kind, reading]
  // 大学・病院・市区役所・商業施設も名前で検索できるようにする (kind 3 = 施設)
  const FACILITY_KIND = ["大学", "病院", "市区役所", "商業施設"];
  const FACILITIES = window.LANDMARKS.places.filter((p) => p[3] <= 3).map((p) => [p[0], p[1], p[2], FACILITY_KIND[p[3]], 3, p[4] || ""]);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const fmt = (n) => Math.round(n).toLocaleString("ja-JP");
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";

  /* ----------------------------------------------------------------------
     Icons
     ---------------------------------------------------------------------- */
  const ICONS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.4"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
    zoom: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 13l3-3 2 2 3-3M8 16h8"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ""}</svg>`;
  const ic = (n) => `<i class="ic">${icon(n)}</i>`;
  $$("i.ic[data-i]").forEach((el) => (el.innerHTML = icon(el.dataset.i)));

  /* ----------------------------------------------------------------------
     Grid
     ---------------------------------------------------------------------- */
  const [W, S, E, N] = G.bbox, DX = G.dx, DY = G.dy, NX = G.nx, NY = G.ny;
  const KX = 111.32 * Math.cos((35.65 * Math.PI) / 180), KY = 110.94;
  const OSM = new Int32Array(NX * NY), MS = new Int32Array(NX * NY), EAB = new Int32Array(NX * NY);
  for (const [ix, iy, o, m, e] of G.cells) { const k = iy * NX + ix; OSM[k] = o; MS[k] = m; EAB[k] = e; }
  const T = G.totals, TOTAL = T.osm + T.msft + T.eab, REGION_AI = (T.msft + T.eab) / TOTAL;

  function areaStats(lat, lng, rKm = 1) {
    const cx = Math.floor((lng - W) / DX), cy = Math.floor((lat - S) / DY);
    const rx = Math.ceil(rKm / (DX * KX)) + 1, ry = Math.ceil(rKm / (DY * KY)) + 1;
    let o = 0, m = 0, e = 0;
    for (let iy = cy - ry; iy <= cy + ry; iy++) for (let ix = cx - rx; ix <= cx + rx; ix++) {
      if (ix < 0 || iy < 0 || ix >= NX || iy >= NY) continue;
      const x = W + (ix + 0.5) * DX, y = S + (iy + 0.5) * DY;
      if (Math.hypot((x - lng) * KX, (y - lat) * KY) > rKm) continue;
      const k = iy * NX + ix; o += OSM[k]; m += MS[k]; e += EAB[k];
    }
    const t = o + m + e;
    return { osm: o, msft: m, eab: e, total: t, ai: m + e, share: t ? (m + e) / t : 0 };
  }

  function nearestPlace(lat, lng, kinds = [1, 0]) {
    let best = null, bd = Infinity;
    for (const p of SEARCH) {
      if (!kinds.includes(p[4])) continue;
      const d = ((p[0] - lng) * KX) ** 2 + ((p[1] - lat) * KY) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /* ----------------------------------------------------------------------
     Map
     ---------------------------------------------------------------------- */
  const isMobile = window.innerWidth < 1024;
  const map = L.map("map", {
    zoomControl: false, minZoom: 9, maxZoom: 18, zoomSnap: 0.25, preferCanvas: true,
    maxBounds: [[S - 0.4, W - 0.5], [N + 0.4, E + 0.5]],
  }).setView([35.62, 139.62], isMobile ? 9.5 : 10.25);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.createPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
  // 背景地図: 国土地理院「淡色地図」(APIキー不要) を CSS で反転してダークに見せる
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
    minZoom: 5, maxZoom: 18, maxNativeZoom: 18, className: "basemap-dark",
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a> | Buildings &amp; places &copy; <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps Foundation</a> · &copy; OpenStreetMap contributors',
  }).addTo(map);

  const state = { mode: "dots", human: true, ai: true, pins: true };

  /* ---------- 建物ドット / AI比率 / 建物の形 キャンバス ----------
     ・画面より一回り大きく描いておき、少しのパンでは描き直さない
     ・ズーム中は描いた画像をそのまま拡大縮小して、地図と一緒に滑らかに動かす */
  const MAX_DOTS = 130000;
  const DotLayer = L.Layer.extend({
    onAdd(m) {
      this._c = L.DomUtil.create("canvas", "dot-canvas leaflet-layer leaflet-zoom-animated");
      m.getPanes().overlayPane.appendChild(this._c);
      m.on("moveend", this._maybe, this);
      m.on("zoomend viewreset resize", this.redraw, this);
      m.on("zoom", this._follow, this);
      m.on("zoomanim", this._anim, this);
      this.redraw();
    },
    onRemove(m) {
      this._c.remove();
      m.off("moveend", this._maybe, this); m.off("zoomend viewreset resize", this.redraw, this);
      m.off("zoom", this._follow, this); m.off("zoomanim", this._anim, this);
    },
    _maybe() { if (!this._pb || !this._pb.contains(this._map.getPixelBounds())) this.redraw(); },
    _follow() {
      if (!this._llb) return;
      const m = this._map;
      L.DomUtil.setTransform(this._c, m.latLngToLayerPoint(this._llb.getNorthWest()), m.getZoomScale(m.getZoom(), this._z));
    },
    _anim(e) {
      if (!this._llb) return;
      const m = this._map;
      L.DomUtil.setTransform(this._c, m._latLngBoundsToNewLayerBounds(this._llb, e.zoom, e.center).min, m.getZoomScale(e.zoom, this._z));
    },
    redraw() {
      const m = this._map, z = m.getZoom(), view = m.getPixelBounds(), size = m.getSize(), c = this._c;
      const pad = size.multiplyBy(0.3).round();
      const tl = view.min.subtract(pad), br = view.max.add(pad);
      const w = br.x - tl.x, h = br.y - tl.y;
      this._pb = L.bounds(tl, br); this._z = z;
      this._llb = L.latLngBounds(m.unproject(tl, z), m.unproject(br, z));
      c.width = w; c.height = h; c.style.width = w + "px"; c.style.height = h + "px";
      L.DomUtil.setPosition(c, tl.subtract(m.getPixelOrigin()));
      const g = c.getContext("2d");
      const b = this._llb;
      const x0 = Math.max(0, Math.floor((b.getWest() - W) / DX)), x1 = Math.min(NX - 1, Math.floor((b.getEast() - W) / DX));
      const y0 = Math.max(0, Math.floor((b.getSouth() - S) / DY)), y1 = Math.min(NY - 1, Math.floor((b.getNorth() - S) / DY));
      if (x1 < x0 || y1 < y0) return;
      const px = [], py = [];
      for (let ix = x0; ix <= x1 + 1; ix++) px[ix] = m.project([S, W + ix * DX], z).x - tl.x;
      for (let iy = y0; iy <= y1 + 1; iy++) py[iy] = m.project([S + iy * DY, W], z).y - tl.y;
      const cw = px[x0 + 1] - px[x0], ch = py[y0] - py[y0 + 1], A = cw * ch;
      const fp = footprintsOn(z, b);
      const skip = (ix, iy) => fp && W + (ix + 0.5) * DX > FEATURED.bbox[0] && W + (ix + 0.5) * DX < FEATURED.bbox[2] && S + (iy + 0.5) * DY > FEATURED.bbox[1] && S + (iy + 0.5) * DY < FEATURED.bbox[3];

      if (state.mode === "share") {
        const gap = cw > 10 ? 1 : 0;
        for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
          const k = iy * NX + ix, o = OSM[k], a = MS[k] + EAB[k], t = o + a;
          if (!t || skip(ix, iy)) continue;
          const s = a / t, alpha = clamp(0.18 + Math.log10(t + 1) / 3.6, 0.18, 0.92);
          // 青 (人) → マゼンタ (AI) を AI 比率で補間
          const r = Math.round(59 + (255 - 59) * s), gg = Math.round(158 + (61 - 158) * s), bb = Math.round(255 + (127 - 255) * s);
          g.fillStyle = `rgba(${r},${gg},${bb},${alpha})`;
          g.fillRect(px[ix] + gap, py[iy + 1] + gap, cw - gap, ch - gap);
        }
        $("#legendNote").textContent = "色: マス内のAI比率（青=0% → マゼンタ=100%）";
      } else {
        // 1マスあたり面積の30%程度を点で埋める縮尺。描く点の総数にも上限を設けて軽くする
        let scale = Math.min(1, (A * 0.3) / 1500), total = 0;
        for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
          const k = iy * NX + ix;
          total += (state.human ? OSM[k] : 0) + (state.ai ? MS[k] + EAB[k] : 0);
        }
        if (total * scale > MAX_DOTS) scale = MAX_DOTS / total;
        // 点は画素バッファに直接書き込む (fillRect を何万回も呼ぶより大幅に速い)。重なりは加算して光らせる
        const sz = Math.round(clamp(Math.sqrt(A) / 40, 1, 2.4));
        const img = g.createImageData(w, h), buf = img.data;
        const pass = (getN, r, gg, bb, a, seedSalt, size) => {
          for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
            const k = iy * NX + ix, cnt = getN(k);
            if (!cnt || skip(ix, iy)) continue;
            let seed = (ix * 73856093) ^ (iy * 19349663) ^ seedSalt;
            const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            const exp = cnt * scale; let n = Math.floor(exp); if (rnd() < exp - n) n++;
            const bx = px[ix], by = py[iy + 1];
            for (let i = 0; i < n; i++) {
              const x = (bx + rnd() * cw) | 0, y = (by + rnd() * ch) | 0;
              for (let dy = 0; dy < size; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = 0; dx < size; dx++) {
                  const xx = x + dx;
                  if (xx < 0 || xx >= w) continue;
                  const o = (yy * w + xx) * 4;
                  buf[o] += r; buf[o + 1] += gg; buf[o + 2] += bb; buf[o + 3] += a;
                }
              }
            }
          }
        };
        if (state.human) pass((k) => OSM[k], 50, 150, 255, 140, 0x1234, sz);
        if (state.ai) pass((k) => MS[k] + EAB[k], 255, 61, 127, 245, 0x9876, sz + (sz < 2 ? 1 : 0));
        g.putImageData(img, 0, 0);
        const per = 1 / scale;
        $("#legendNote").textContent = per <= 1.05 ? "1点 = 1棟（点はマス内にランダム配置）" : `1点 ≈ ${per < 10 ? per.toFixed(1) : fmt(per)}棟（点はマス内にランダム配置）`;
      }
      if (fp) { drawFootprints(g, z, tl); $("#legendNote").textContent = "淵野辺周辺: 建物の実際の形を表示中（クリックで出どころ）"; }
    },
  });
  const dots = new DotLayer();

  /* ---------- 注目エリアの建物フットプリント (同じキャンバスに直接描く) ---------- */
  const FEATURED = { id: "fuchinobe", bbox: [139.375, 35.555, 139.410, 35.580], name: "淵野辺・青山学院大学 相模原キャンパス周辺" };
  const FP_BOUNDS = L.latLngBounds([FEATURED.bbox[1], FEATURED.bbox[0]], [FEATURED.bbox[3], FEATURED.bbox[2]]);
  let fpData = null, fpLoading = false, fpWaiters = [];
  function inFeatured(lat, lng) { return FP_BOUNDS.contains([lat, lng]); }
  function footprintsOn(z, b) {
    if (z < 15 || !b.intersects(FP_BOUNDS)) return false;
    if (!fpData) { loadFootprints(() => dots.redraw()); return false; }
    return true;
  }
  function loadFootprints(cb) {
    if (fpData) return cb && cb();
    if (cb) fpWaiters.push(cb);
    if (fpLoading) return;
    fpLoading = true;
    const s = document.createElement("script");
    s.src = `footprints_${FEATURED.id}.js`;
    s.onload = () => {
      const raw = window.FOOTPRINTS[FEATURED.id], [w, so] = raw.bbox, sc = raw.scale;
      fpData = raw.buildings.map(([src, year, d]) => {
        const xs = [], ys = []; let x = 0, y = 0;
        for (let i = 0; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; xs.push(w + x * sc); ys.push(so + y * sc); }
        return { src, year, xs, ys, ring: xs.map((v, i) => [ys[i], v]),
          minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      });
      fpLoading = false;
      fpWaiters.splice(0).forEach((f) => f());
    };
    document.head.appendChild(s);
  }
  function drawFootprints(g, z, tl) {
    // 3km四方なのでメルカトル投影は一次式で近似して高速に描く
    const p0 = map.project([FEATURED.bbox[1], FEATURED.bbox[0]], z), p1 = map.project([FEATURED.bbox[3], FEATURED.bbox[2]], z);
    const ax = (p1.x - p0.x) / (FEATURED.bbox[2] - FEATURED.bbox[0]), ay = (p1.y - p0.y) / (FEATURED.bbox[3] - FEATURED.bbox[1]);
    const X = (lng) => p0.x + (lng - FEATURED.bbox[0]) * ax - tl.x, Y = (lat) => p0.y + (lat - FEATURED.bbox[1]) * ay - tl.y;
    for (const ai of [false, true]) {
      if (ai ? !state.ai : !state.human) continue;
      g.beginPath();
      for (const bd of fpData) {
        if ((bd.src !== 0) !== ai) continue;
        g.moveTo(X(bd.xs[0]), Y(bd.ys[0]));
        for (let i = 1; i < bd.xs.length; i++) g.lineTo(X(bd.xs[i]), Y(bd.ys[i]));
        g.closePath();
      }
      g.fillStyle = ai ? "rgba(255,61,127,0.55)" : "rgba(59,158,255,0.22)";
      g.strokeStyle = ai ? "rgba(255,61,127,1)" : "rgba(59,158,255,0.8)";
      g.lineWidth = ai ? 1.2 : 0.8;
      g.fill(); g.stroke();
    }
  }
  function buildingAt(lat, lng) {
    if (!fpData || map.getZoom() < 15 || !inFeatured(lat, lng)) return null;
    for (const bd of fpData) {
      if (lng < bd.minX || lng > bd.maxX || lat < bd.minY || lat > bd.maxY) continue;
      if ((bd.src === 0 ? !state.human : !state.ai)) continue;
      let inside = false;
      for (let i = 0, j = bd.xs.length - 1; i < bd.xs.length; j = i++) {
        if ((bd.ys[i] > lat) !== (bd.ys[j] > lat) && lng < ((bd.xs[j] - bd.xs[i]) * (lat - bd.ys[i])) / (bd.ys[j] - bd.ys[i]) + bd.xs[i]) inside = !inside;
      }
      if (inside) return bd;
    }
    return null;
  }
  dots.addTo(map);

  /* ---------- 目印のピン (Overture places) ---------- */
  const LM = window.LANDMARKS;
  // 種類: 0大学 1病院 2市区役所 3商業施設 4学校 5公園 6スーパー 7コンビニ 8駅 (big: 大きいピン)
  const PIN = [
    { label: "大学", minZ: 11, big: 1, color: "#b8a4ff", d: '<path d="M3 9.5l9-4.5 9 4.5-9 4.5-9-4.5z"/><path d="M7 11.5v3.8c0 1.5 2.2 2.9 5 2.9s5-1.4 5-2.9v-3.8"/>' },
    { label: "病院", minZ: 13, big: 1, color: "#ff8f8f", d: '<path d="M12 6.5v11M6.5 12h11"/>' },
    { label: "市区役所", minZ: 11, big: 1, color: "#d5dcea", d: '<path d="M4.5 9.5L12 5l7.5 4.5M5.5 19h13M8 11v6M12 11v6M16 11v6"/>' },
    { label: "商業施設", minZ: 13, big: 1, color: "#ffcf5c", d: '<path d="M6.5 8.5h11l-.9 10.5H7.4L6.5 8.5z"/><path d="M9.5 8.5V7.6a2.5 2.5 0 0 1 5 0v.9"/>' },
    { label: "学校", minZ: 14, big: 0, color: "#bff07e", d: '<path d="M5 6.5h5.5A1.5 1.5 0 0 1 12 8v10a1.5 1.5 0 0 0-1.5-1.5H5zM19 6.5h-5.5A1.5 1.5 0 0 0 12 8v10a1.5 1.5 0 0 1 1.5-1.5H19z"/>' },
    { label: "公園", minZ: 14, big: 0, color: "#5fe3a1", d: '<path d="M12 4.5a4.2 4.2 0 0 0-3.9 5.8A3.4 3.4 0 0 0 9.2 17h5.6a3.4 3.4 0 0 0 1.1-6.7A4.2 4.2 0 0 0 12 4.5z"/><path d="M12 12v7.5"/>' },
    { label: "スーパー", minZ: 14, big: 0, color: "#ffa862", d: '<path d="M4 6h2l1.8 9h9.4L19 8.5H7"/><circle cx="9.5" cy="18.3" r="1.1"/><circle cx="16" cy="18.3" r="1.1"/>' },
    { label: "コンビニ", minZ: 15, big: 0, color: "#ffe28a", d: '<path d="M5 9.5l1.3-3.5h11.4L19 9.5M6 9.5V18h12V9.5M5 9.5h14"/><path d="M10.5 18v-4h3v4"/>' },
    { label: "駅", minZ: 12, big: 1, color: "#f3f6fb", d: '<rect x="7" y="4.5" width="10" height="11.5" rx="2.6"/><path d="M7 11h10M9.5 19.5l1.2-3M14.5 19.5l-1.2-3"/><circle cx="9.8" cy="13.6" r=".5"/><circle cx="14.2" cy="13.6" r=".5"/>' },
  ];
  const PLACES = LM.places.concat(SEARCH.filter((e) => e[4] === 2).map((e) => [e[0], e[1], e[2], 8]));
  const LABEL_Z = [14, 15, 13, 15, 16, 16, 15, 16, 13];
  const ORDER = [8, 0, 2, 3, 1, 6, 4, 5, 7]; // 重要度: 駅・大学・役所 → … → コンビニ
  const pinLayer = L.layerGroup().addTo(map);
  const pinCache = new Map(); // 画面に出しているピン (動かしても作り直さない)
  const geom = (k) => PIN[k].big ? { s: 26, h: 34 } : { s: 20, h: 27 };
  function pinIcon(k, name, showLabel) {
    const { s, h } = geom(k);
    return L.divIcon({
      className: "",
      html: `<div class="lm ${PIN[k].big ? "lm-big" : "lm-small"}" style="--c:${PIN[k].color}"><span class="lm-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${PIN[k].d}</svg></span>${showLabel ? `<span class="lm-label">${name}</span>` : ""}</div>`,
      iconSize: [s, h], iconAnchor: [s / 2, h],
    });
  }
  function drawPins() {
    if (!state.pins) { pinLayer.clearLayers(); pinCache.clear(); return; }
    const z = map.getZoom(), b = map.getBounds().pad(0.1), sel = state.selected;
    const shown = PLACES.filter((p) => z >= PIN[p[3]].minZ && b.contains([p[1], p[0]])
      && !(sel && Math.abs(p[1] - sel.lat) < 2e-4 && Math.abs(p[0] - sel.lng) < 2e-4)); // 選択中の地点は照準とラベルで表示
    shown.sort((a, c) => ORDER.indexOf(a[3]) - ORDER.indexOf(c[3]));
    // 画面上で重なるピンは重要度の低い方を省き、ラベルも重ならないものだけ出す
    const boxes = [], labels = [];
    if (sel) {
      const sp = map.latLngToContainerPoint([sel.lat, sel.lng]);
      boxes.push({ x: sp.x - 16, y: sp.y - 16, w: 32, h: 32 });
      labels.push({ x: sp.x + 14, y: sp.y - 24, w: Math.max(120, (sel.name || "").length * 14 + 30), h: 48 });
    }
    const hit = (r, list) => list.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    const next = new Map();
    for (const p of shown) {
      if (next.size >= 140) break;
      const k = p[3], pt = map.latLngToContainerPoint([p[1], p[0]]), { s, h } = geom(k);
      const box = { x: pt.x - s / 2 - 2, y: pt.y - h - 2, w: s + 4, h: h + 4 };
      if (hit(box, boxes) || hit(box, labels)) continue;
      let showLabel = false;
      if (z >= LABEL_Z[k]) {
        const lb = { x: pt.x + s / 2 + 3, y: pt.y - h + s / 2 - 11, w: p[2].length * 11.5 + 18, h: 22 };
        if (!hit(lb, boxes) && !hit(lb, labels)) { labels.push(lb); showLabel = true; }
      }
      boxes.push(box);
      const key = `${p[3]}|${p[0]}|${p[1]}|${showLabel ? 1 : 0}`;
      let m = pinCache.get(key);
      if (!m) {
        m = L.marker([p[1], p[0]], { icon: pinIcon(k, p[2], showLabel), keyboard: false, riseOnHover: true, zIndexOffset: (9 - ORDER.indexOf(k)) * 10 });
        m.bindTooltip(`<b>${p[2]}</b><br><span style="color:#8c94a8">${PIN[k].label} · Overture places</span>`, { direction: "top", offset: [0, -h], className: "lm-tip" });
        m.on("click", (e) => { L.DomEvent.stopPropagation(e); goTo(p[1], p[0], map.getZoom(), { name: p[2], ward: PIN[k].label }); });
        m.addTo(pinLayer);
      }
      next.set(key, m);
    }
    for (const [key, m] of pinCache) if (!next.has(key)) pinLayer.removeLayer(m);
    pinCache.clear();
    for (const [key, m] of next) pinCache.set(key, m);
  }
  map.on("moveend", drawPins);

  /* ----------------------------------------------------------------------
     Overview panel
     ---------------------------------------------------------------------- */
  function countUp(el, to, f = fmt, dur = 1200) {
    if (reduced) { el.textContent = f(to); return; }
    const t0 = performance.now();
    const step = (now) => { const t = ease(clamp((now - t0) / dur)); el.textContent = f(to * t); if (t < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  countUp($("#totalBig"), TOTAL);
  countUp($("#pctHuman"), T.osm / TOTAL, (v) => pct(v));
  countUp($("#pctAi"), REGION_AI, (v) => pct(v));
  requestAnimationFrame(() => {
    $("#splitHuman").style.width = pct(T.osm / TOTAL, 3);
    $("#splitAi").style.width = pct(REGION_AI, 3);
  });
  $("#srcList").innerHTML = [
    ["sw-human", "OpenStreetMap", "人が描いた · ボランティアの手作業", T.osm],
    ["sw-ai", "Microsoft ML Buildings", "AI · 衛星画像から自動抽出", T.msft],
    ["sw-eab", "East Asian Buildings", "AI · doi:10.5281/zenodo.8174931", T.eab],
  ].map(([sw, name, sub, n]) => `<div><span class="sw ${sw}"></span><dt>${name}<small>${sub}</small></dt><dd>${fmt(n)}<small>${pct(n / TOTAL)}</small></dd></div>`).join("");

  // 表示モード
  const seg = $("#segMode");
  function syncMode() {
    $$("button", seg).forEach((b, i) => { const on = b.dataset.value === state.mode; b.setAttribute("aria-checked", on); if (on) seg.dataset.pos = i; });
  }
  $$("button", seg).forEach((b) => b.addEventListener("click", () => { state.mode = b.dataset.value; syncMode(); dots.redraw(); }));
  syncMode();
  $("#tgPins").addEventListener("click", (e) => {
    state.pins = !state.pins;
    e.currentTarget.classList.toggle("is-on", state.pins);
    e.currentTarget.setAttribute("aria-pressed", state.pins);
    drawPins();
  });
  for (const [id, key] of [["#tgHuman", "human"], ["#tgAi", "ai"]]) {
    $(id).addEventListener("click", (e) => {
      state[key] = !state[key];
      e.currentTarget.classList.toggle("is-on", state[key]);
      e.currentTarget.setAttribute("aria-pressed", state[key]);
      dots.redraw();
    });
  }

  /* ----------------------------------------------------------------------
     OSM編集候補ランキング (3×3マス ≒ 1.3km四方の AI 建物数)
     ---------------------------------------------------------------------- */
  function buildRanking() {
    const cand = [];
    for (let iy = 1; iy < NY - 1; iy++) for (let ix = 1; ix < NX - 1; ix++) {
      let a = 0, t = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = (iy + dy) * NX + ix + dx; a += MS[k] + EAB[k]; t += OSM[k] + MS[k] + EAB[k];
      }
      if (a > 0) cand.push({ ix, iy, a, t });
    }
    cand.sort((p, q) => q.a - p.a);
    const picked = [];
    for (const c of cand) {
      const lng = W + (c.ix + 0.5) * DX, lat = S + (c.iy + 0.5) * DY;
      if (picked.some((p) => Math.hypot((p.lng - lng) * KX, (p.lat - lat) * KY) < 3)) continue;
      const pl = nearestPlace(lat, lng);
      picked.push({ ...c, lng, lat, name: pl ? pl[2] : "—", ward: pl ? pl[3] : "" });
      if (picked.length >= 10) break;
    }
    const max = picked[0] ? picked[0].a : 1;
    $("#ranking").innerHTML = picked.map((p, i) => `
      <li><button data-r="${i}">
        <span><span class="nm block">${p.name}</span><span class="wd block">${p.ward}</span></span>
        <span class="ct">${fmt(p.a)}<small>AI ${pct(p.a / p.t, 0)}</small></span>
        <span class="bar"><span style="width:${(p.a / max) * 100}%"></span></span>
      </button></li>`).join("");
    $$("#ranking [data-r]").forEach((b) => b.addEventListener("click", () => {
      const p = picked[+b.dataset.r];
      goTo(p.lat, p.lng, 14.5, { name: p.name, ward: p.ward });
    }));
  }
  buildRanking();

  /* ----------------------------------------------------------------------
     Search
     ---------------------------------------------------------------------- */
  const q = $("#q"), results = $("#results");
  const KIND = ["市区町村", "町名", "駅", "施設"];
  let hits = [], sel = 0;
  const norm = (s) => s.normalize("NFKC").replace(/\s+/g, "");
  const toHira = (s) => norm(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const isKana = (s) => /^[ぁ-ゖー]+$/.test(s);
  function search(text) {
    const t = norm(text), h = toHira(text), kana = isKana(h);
    if (!t) return [];
    const out = [];
    for (const e of SEARCH.concat(FACILITIES)) {
      const n = norm(e[2]), w = norm(e[3]), r = e[5] || "";
      let sc = -1;
      if (n === t || n === t + "駅") sc = 100;
      else if (n.startsWith(t)) sc = 80 - n.length * 0.5;
      else if (n.includes(t)) sc = 60 - n.length * 0.5;
      else if (kana && r) {
        // ひらがな・カタカナ入力は読みがなで照合 (例: ふちのべ → 淵野辺)
        if (r === h || r === h + "えき") sc = 95;
        else if (e[4] === 0 && /^(し|く|まち|ちょう|むら)$/.test(r.slice(h.length)) && r.startsWith(h)) sc = 96;
        else if (r.startsWith(h)) sc = 75 - r.length * 0.5;
        else if (h.length >= 2 && r.includes(h)) sc = 55 - r.length * 0.5;
      }
      if (sc < 0 && w.includes(t)) sc = 30;
      if (sc < 0) continue;
      out.push({ e, sc: sc + (e[4] === 2 ? 4 : e[4] === 0 ? 3 : 0) });
    }
    out.sort((a, b) => b.sc - a.sc);
    const seen = new Set();
    return out.filter(({ e }) => { const k = e[2] + e[3]; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8).map((o) => o.e);
  }
  function renderResults() {
    const t = q.value.trim();
    if (!t) { results.hidden = true; return; }
    results.hidden = false;
    if (!hits.length) { results.innerHTML = `<li class="empty-r">「${t.replace(/</g, "&lt;")}」は見つかりませんでした。町名か駅名で試してください。</li>`; return; }
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    results.innerHTML = hits.map((e, i) => `
      <li role="option" aria-selected="${i === sel}" data-h="${i}">
        <span class="kind k${e[4]}">${KIND[e[4]]}</span>
        <span>${e[2].replace(re, "<mark>$&</mark>")}${e[5] ? ` <small class="rd">${e[5]}</small>` : ""}</span>
        <small>${e[3]}</small>
      </li>`).join("");
    $$("[data-h]", results).forEach((li) => li.addEventListener("mousedown", (ev) => { ev.preventDefault(); choose(hits[+li.dataset.h]); }));
  }
  function choose(e) {
    if (!e) return;
    q.value = e[2]; results.hidden = true; q.blur();
    goTo(e[1], e[0], e[4] === 0 ? 13 : 15, { name: e[2], ward: e[4] === 3 ? "" : e[3] });
  }
  q.addEventListener("input", () => { hits = search(q.value); sel = 0; renderResults(); });
  q.addEventListener("focus", () => { if (q.value) { hits = search(q.value); renderResults(); } });
  q.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 120));
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { sel = Math.min(sel + 1, hits.length - 1); renderResults(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { sel = Math.max(sel - 1, 0); renderResults(); ev.preventDefault(); }
    else if (ev.key === "Enter") { choose(hits[sel]); ev.preventDefault(); }
    else if (ev.key === "Escape") { results.hidden = true; q.blur(); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== q && !$("#about").open) { ev.preventDefault(); q.focus(); }
  });

  /* ----------------------------------------------------------------------
     Area report
     ---------------------------------------------------------------------- */
  let pin = null, ring = null;
  const reportEl = $("#report");

  let flightId = 0;
  function goTo(lat, lng, zoom, place) {
    const id = ++flightId;
    const target = Math.max(zoom, map.getZoom());
    const from = map.getCenter();
    const distKm = Math.hypot((from.lng - lng) * KX, (from.lat - lat) * KY);
    analyze(lat, lng, place, { cinematic: !reduced });
    if (reduced) { map.setView([lat, lng], target); return; }
    // 移動距離に応じて飛行時間を変える (近いほど短く、遠いほど大きく弧を描く)
    const duration = clamp(0.9 + distKm / 25, 1.0, 2.4);
    const near = map.getBounds().contains([lat, lng]) && Math.abs(map.getZoom() - target) < 0.5;
    const arrive = () => { if (id === flightId) land(lat, lng, place); };
    if (near) { map.panTo([lat, lng], { duration: 0.6, easeLinearity: 0.2 }); setTimeout(arrive, 650); return; }
    document.body.classList.add("is-flying");
    map.flyTo([lat, lng], target, { duration, easeLinearity: 0.12 });
    map.once("moveend", () => { document.body.classList.remove("is-flying"); setTimeout(arrive, 30); });
  }

  // 着地の演出: ロックオン → 半径1kmの円がゆっくり広がる → 地名ラベル
  function land(lat, lng, place) {
    const el = pin && pin.getElement() && pin.getElement().querySelector(".pin");
    if (el) { el.classList.remove("is-locking"); void el.offsetWidth; el.classList.add("is-locking"); }
    if (ring) {
      const t0 = performance.now();
      ring.setRadius(1);
      ring.setStyle({ opacity: 0.9, fillOpacity: 0 });
      const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const grow = (now) => {
        const t = clamp((now - t0 - 250) / 1600);
        ring.setRadius(1 + 999 * inOut(t));
        ring.setStyle({ fillOpacity: 0.045 * t });
        if (t < 1) requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
    }
    if (pin) {
      pin.unbindTooltip();
      pin.bindTooltip(`<span class="hud-in"><span class="hud-k">AREA SCAN · 1km</span><b>${place ? place.name : ""}</b></span>`, { permanent: true, direction: map.latLngToContainerPoint([lat, lng]).x > map.getSize().x - 190 ? "left" : "right", offset: [map.latLngToContainerPoint([lat, lng]).x > map.getSize().x - 190 ? -16 : 16, 0], className: "hud-tip" }).openTooltip();
    }
  }

  map.on("click", (e) => {
    const bd = buildingAt(e.latlng.lat, e.latlng.lng);
    if (bd) {
      const label = bd.src === 0 ? "人が描いた建物（OpenStreetMap）" : bd.src === 1 ? "AIが見つけた建物（Microsoft ML Buildings）" : "AIが見つけた建物（East Asian Buildings）";
      const sub = bd.src === 0 ? (bd.year ? `OSMで最後に編集された年: ${bd.year}年` : "") : "OSMにはまだ描かれていない可能性があります";
      L.popup().setLatLng(e.latlng).setContent(`<b style="color:${bd.src === 0 ? "#7cc4ff" : "#ff8ab3"}">${label}</b><br>${sub}`).openOn(map);
      return;
    }
    flightId++;
    analyze(e.latlng.lat, e.latlng.lng, null, { cinematic: !reduced });
    if (!reduced) land(e.latlng.lat, e.latlng.lng, state.selected);
  });

  function analyze(lat, lng, place, opt = {}) {
    if (lat < S || lat > N || lng < W || lng > E) return;
    const st = areaStats(lat, lng, 1);
    if (!place) { const p = nearestPlace(lat, lng); place = { name: p ? p[2] : "選択地点", ward: p ? p[3] : "" }; }
    if (pin) pin.remove();
    if (ring) ring.remove();
    ring = L.circle([lat, lng], { radius: opt.cinematic ? 1 : 1000, color: "#7cc4ff", weight: 1.6, opacity: opt.cinematic ? 0 : 0.8, dashArray: "3 5", fillColor: "#3b9eff", fillOpacity: opt.cinematic ? 0 : 0.04, interactive: false }).addTo(map);
    pin = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="pin"><i></i><b></b><s></s></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    state.selected = { lat, lng, name: place.name };
    renderReport(lat, lng, place, st);
    drawPins();
    if (isMobile) setTab("report");
  }

  function verdict(st) {
    const avg = pct(REGION_AI, 0);
    if (st.total < 50) return { cls: "v-low", lv: "—", t: "建物が少ないエリア", msg: "半径1km以内の建物が少なく、判定できません。" };
    if (st.share >= 0.5 && st.ai >= 300) return { cls: "v-high", lv: "高", t: "OSM編集候補度", msg: `建物の半分以上がAIだけが見つけたもので、<b>${fmt(st.ai)}棟</b> が OpenStreetMap にまだ描かれていない可能性があります。<b>編集のしがいがあるエリア</b>です。` };
    if (st.share >= REGION_AI) return { cls: "v-mid", lv: "中", t: "OSM編集候補度", msg: `AI の建物の割合が首都圏平均（${avg}）より高めです。<b>${fmt(st.ai)}棟</b> が OSM 未登録の可能性があります。` };
    if (st.ai >= 500) return { cls: "v-mid", lv: "中", t: "OSM編集候補度", msg: `AI の割合は首都圏平均（${avg}）より低いものの、AI だけが見つけた建物が <b>${fmt(st.ai)}棟</b> あります。` };
    return { cls: "v-low", lv: "低", t: "OSM編集候補度", msg: `AI の割合は首都圏平均（${avg}）より低く、ほとんどの建物がすでに OpenStreetMap で描かれています。<b>マッピングが行き届いた</b>エリアです。` };
  }

  function renderReport(lat, lng, place, st) {
    const C = 2 * Math.PI * 54;
    const segs = [["seg-h", "#3b9eff", st.osm], ["seg-a", "#ff3d7f", st.msft], ["seg-e", "#ffb020", st.eab]];
    let off = 0;
    const arcs = segs.map(([cls, col, n]) => {
      const len = st.total ? (n / st.total) * C : 0;
      const s = `<circle class="${cls}" cx="68" cy="68" r="54" fill="none" stroke="${col}" stroke-width="12" stroke-dasharray="0 ${C}" data-dash="${Math.max(0, len - (len > 3 ? 1.5 : 0))} ${C}" stroke-dashoffset="${-off}"/>`;
      off += len; return s;
    }).join("");
    const v = verdict(st);
    const showFp = inFeatured(lat, lng);
    const osmLink = `https://www.openstreetmap.org/edit?editor=id#map=17/${lat.toFixed(5)}/${lng.toFixed(5)}`;
    const ovLink = `https://explore.overturemaps.org/#16/${lat.toFixed(5)}/${lng.toFixed(5)}`;

    reportEl.innerHTML = `
      <div class="rep-enter space-y-4">
        <div>
          <p class="eyebrow">Area report · 半径1km</p>
          <h2 class="place mt-1.5">${place.name}<span class="text-muted text-[13px] font-medium"> 周辺</span></h2>
          <p class="mt-1 text-[12px] text-muted">${place.ward || ""}</p>
          <p class="coords mt-1">${lat.toFixed(4)}°N ${lng.toFixed(4)}°E</p>
        </div>

        <div class="hero">
          <div class="donut">
            <svg viewBox="0 0 136 136"><circle cx="68" cy="68" r="54" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="12"/>${arcs}</svg>
            <div class="lbl"><small>AIが見つけた</small><b data-c="share">0<small>%</small></b></div>
          </div>
          <div class="kv">
            <div><span class="sw sw-human"></span>人が描いた<b data-c="osm">0</b></div>
            <div><span class="sw sw-ai"></span>AI · Microsoft<b data-c="msft">0</b></div>
            <div><span class="sw sw-eab"></span>AI · East Asian<b data-c="eab">0</b></div>
            <div class="tot">建物の合計<b data-c="total">0</b></div>
          </div>
        </div>

        <div class="verdict ${v.cls}">
          <span class="lv">${v.lv}</span>
          <div><p class="t">${v.t}</p><p>${v.msg}</p></div>
        </div>

        <div class="card"><h4>AI比率をくらべる<span>Compare</span></h4>
          <div class="cmp">
            <div class="cmp-row"><span>このエリア</span><span class="tr"><span data-w="${clamp(st.share) * 100}"></span></span><b>${pct(st.share)}</b></div>
            <div class="cmp-row"><span>首都圏平均</span><span class="tr"><span data-w="${REGION_AI * 100}"></span></span><b>${pct(REGION_AI)}</b></div>
          </div>
          <p class="note mt-2">バーの青い部分が人の描いた建物、マゼンタが AI の建物の割合です。</p>
        </div>

        ${showFp ? `<div class="card" id="histCard"><h4>OSM の建物はいつ描かれた？<span>Last edit year</span></h4>
          <div class="hist" id="hist"></div><div class="hist-ax"><span>2008</span><span>2017</span><span>2026</span></div>
          <p class="note mt-2" id="histNote">建物データを読み込み中…</p></div>` : ""}

        <div class="actions">
          <a class="btn btn-ai" href="${osmLink}" target="_blank" rel="noopener">${ic("edit")}OSMで編集する</a>
          <a class="btn btn-ghost" href="${ovLink}" target="_blank" rel="noopener">${ic("globe")}Overture Explorer</a>
          ${showFp ? `<button class="btn btn-wide" id="btnShape">${ic("zoom")}建物の形を見る（クリックで出どころ表示）</button>` : ""}
        </div>
        <p class="note">AI の検出には誤りもあります。OSM に描くときは航空写真や現地で確認してください。集計は約450mマスの合計のため、範囲の端は近似です。</p>
      </div>`;

    // アニメーション
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$("[data-dash]", reportEl).forEach((c) => c.setAttribute("stroke-dasharray", c.dataset.dash));
      $$("[data-w]", reportEl).forEach((s) => (s.style.width = s.dataset.w + "%"));
    }));
    const c = (k) => $(`[data-c="${k}"]`, reportEl);
    countUp(c("osm"), st.osm, fmt, 900); countUp(c("msft"), st.msft, fmt, 900); countUp(c("eab"), st.eab, fmt, 900); countUp(c("total"), st.total, fmt, 900);
    // % の小さい文字を保つため innerHTML で数える
    const shareEl = c("share");
    if (!reduced) {
      const t0 = performance.now();
      const step = (now) => { const t = ease(clamp((now - t0) / 900)); shareEl.innerHTML = `${(st.share * 100 * t).toFixed(1)}<small>%</small>`; if (t < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    } else shareEl.innerHTML = `${(st.share * 100).toFixed(1)}<small>%</small>`;

    if (showFp) {
      loadFootprints(() => drawHist(lat, lng));
      $("#btnShape").addEventListener("click", () => map.flyTo([lat, lng], 16.5, { duration: reduced ? 0 : 1.2 }));
    }
  }

  function drawHist(lat, lng) {
    const el = $("#hist");
    if (!el || !fpData) return;
    const years = new Array(19).fill(0); let n = 0, ai = 0;
    for (const b of fpData) {
      const [y, x] = b.ring[0];
      if (Math.hypot((x - lng) * KX, (y - lat) * KY) > 1) continue;
      if (b.src !== 0) { ai++; continue; }
      if (b.year >= 2008 && b.year <= 2026) { years[b.year - 2008]++; n++; }
    }
    const max = Math.max(1, ...years);
    el.innerHTML = years.map((v, i) => `<span style="height:0" data-h="${(v / max) * 100}" title="${2008 + i}年: ${fmt(v)}棟"></span>`).join("");
    requestAnimationFrame(() => requestAnimationFrame(() => $$("span", el).forEach((s) => (s.style.height = s.dataset.h + "%"))));
    const peak = years.indexOf(max) + 2008;
    const recent = years.slice(-3).reduce((a, b) => a + b, 0);
    $("#histNote").innerHTML = `OSM の建物 ${fmt(n)}棟のうち、最後の編集が最も多いのは <b style="color:var(--fg)">${peak}年</b>。2024年以降に編集された建物は ${pct(recent / Math.max(1, n), 0)} です。`;
  }

  /* ----------------------------------------------------------------------
     Mobile tabs / dialog / boot
     ---------------------------------------------------------------------- */
  function setTab(id) {
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === id));
    $$(".pane").forEach((p) => p.classList.toggle("is-active", p.dataset.pane === id));
    $("#sheet").scrollTop = 0;
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
  if (isMobile) setTab("report");
  else $$(".pane").forEach((p) => p.classList.add("is-active"));

  const about = $("#about");
  $("#btnAbout").addEventListener("click", () => about.showModal());
  about.addEventListener("click", (e) => { if (e.target === about || e.target.closest("[data-close]")) about.close(); });

  // 最初は淵野辺（青山学院大学 相模原キャンパス周辺）のレポートを表示
  drawPins();
  analyze(35.5686, 139.3951, { name: "淵野辺", ward: "相模原市中央区" });
})();
