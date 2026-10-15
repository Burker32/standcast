/* StandCast app: state, ranking flow and the side panel. */
(function () {
  'use strict';
  const SC = window.SC, E = SC.engine, S = SC.store, W = SC.weather, M = SC.map, MT = SC.markTypes;
  const $ = (id) => document.getElementById(id);
  const isMobile = () => !window.matchMedia('(min-width: 960px)').matches;

  /* ---------------- DOM helpers ---------------- */
  const NS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    let selectValue = null;
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else if (k === 'value' && tag === 'select') selectValue = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    (function add(list) {
      list.forEach((c) => {
        if (c == null || c === false) return;
        if (Array.isArray(c)) add(c);
        else n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
      });
    })(kids);
    if (selectValue != null) n.value = selectValue;
    return n;
  }
  const PATHS = {
    layers: 'M12 3 L3 8 L12 13 L21 8 Z M3 12.5 L12 17.5 L21 12.5 M3 17 L12 22 L21 17',
    locate: 'M12 8 a4 4 0 1 0 0.01 0 M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3',
    plus: 'M12 5 v14 M5 12 h14',
    back: 'M15 5 l-7 7 7 7',
    close: 'M6 6 l12 12 M18 6 L6 18',
    stands: 'M12 21 s-6-5.5-6-10 a6 6 0 1 1 12 0 c0 4.5-6 10-6 10 z M12 8.5 a2.5 2.5 0 1 0 0.01 0',
    marks: 'M6 21 V4 M6 5 h11 l-2 4 2 4 H6',
    guide: 'M12 3 a9 9 0 1 0 0.01 0 M12 11 v6 M12 7 v.5',
    trash: 'M5 7 h14 M9 7 V4 h6 v3 M7 7 l1 13 h8 l1-13',
    photo: 'M4 8 H8 L10 6 H14 L16 8 H20 V19 H4 Z M12 10.5 a3 3 0 1 0 0.01 0',
    search: 'M10.5 4 a6.5 6.5 0 1 0 0.01 0 M15.5 15.5 L20.5 20.5',
    photos: 'M3 7 H17 V19 H3 Z M7 7 V4 H21 V16 H17 M5.5 16.5 l3.5-4 3 3 1.5-1.5 2 2.5',
    refresh: 'M20 11 a8 8 0 1 0 -2.3 5.7 M20 4 v7 h-7',
    ruler: 'M3 17 L17 3 L21 7 L7 21 Z M7 13 l2 2 M10 10 l2 2 M13 7 l2 2',
    undo: 'M9 7 L4 12 L9 17 M4 12 H15 a5 5 0 0 1 0 10 H12'
  };
  function icon(name, size) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 20); s.setAttribute('height', size || 20);
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ico');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', PATHS[name]); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
  }
  // Arrow pointing the way the air is moving.
  function arrow(deg, cls, size) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 18); s.setAttribute('height', size || 18);
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'arrow ' + (cls || ''));
    s.style.transform = 'rotate(' + Math.round(deg) + 'deg)';
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M12 2.5 L19 12.5 H14 V21.5 H10 V12.5 H5 Z');
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
    return s;
  }
  function two(n) { return n < 10 ? '0' + n : '' + n; }
  function localTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function distM(a, b, c, d) {
    const dy = (c - a) * 111320, dx = (d - b) * 111320 * Math.cos(a * E.DEG);
    return Math.hypot(dx, dy);
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
  }
  function confirmTwice(label, action, cls) {
    let armed = false, timer = null;
    const b = h('button', { class: 'btn ' + (cls || 'danger'), type: 'button' }, label);
    b.addEventListener('click', () => {
      if (!armed) {
        armed = true; b.textContent = 'Tap again to confirm'; b.classList.add('armed');
        timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 3500);
      } else { clearTimeout(timer); action(); }
    });
    return b;
  }

  /* ---------------- state ---------------- */
  const ui = { tab: 'stands', view: 'list', selStand: null, selMark: null, sitId: null, tMin: null, placing: null, sheet: 'half', markFilter: 'all', logOpen: false };
  const data = { fc: {}, evals: {}, ranks: [], sits: [], ref: null, nowMin: 0, loading: false, error: null, at: null, stale: false, scrubMin: 0, scrubMax: 0, terrainBusy: {}, terrainFailed: {}, field: null, fieldKey: '' };
  const settings = () => S.state.settings;
  const stands = () => S.state.stands;
  const currentSit = () => data.sits.filter((s) => s.id === ui.sitId)[0] || null;

  /* ---------------- data flow ---------------- */
  function refresh(force) {
    if (!stands().length) { data.fc = {}; data.error = null; recompute(); return Promise.resolve(); }
    data.loading = true; renderStatus();
    return W.loadFor(stands(), force).then((r) => {
      data.fc = r.byStand; data.error = r.error; data.at = r.at; data.stale = r.stale || r.missing; data.loading = false;
      recompute();
      return ensureTerrain();
    });
  }
  function needsTerrain(s) {
    if (data.terrainBusy[s.id]) return false;
    if (data.terrainFailed[s.id] && Date.now() - data.terrainFailed[s.id] < 5 * 60000) return false;
    return !s.terrain || s.terrain.src !== 'lidar' || distM(s.terrain.lat, s.terrain.lng, s.lat, s.lng) > 40;   // no src = old 90 m reading: redo with lidar
  }
  function ensureTerrain() {
    const todo = stands().filter(needsTerrain);
    return Promise.all(todo.map((s) => {
      data.terrainBusy[s.id] = true;
      return W.fetchTerrain(s.lat, s.lng).then((t) => {
        S.updateStand(s.id, { terrain: t }); delete data.terrainFailed[s.id];
      }).catch(() => { data.terrainFailed[s.id] = Date.now(); })
        .then(() => { delete data.terrainBusy[s.id]; });
    })).then(() => { if (todo.length) recompute(); });
  }
  function sitMid(sit) {
    const mid = Math.round((sit.start + sit.end) / 2 / 10) * 10;
    return Math.max(data.scrubMin, Math.min(data.scrubMax, mid));
  }
  function recompute() {
    data.evals = {}; data.ranks = []; data.ref = null;
    const list = stands();
    for (let i = 0; i < list.length; i++) if (data.fc[list[i].id]) { data.ref = data.fc[list[i].id]; break; }
    if (!data.ref) { data.sits = []; renderAll(); return; }
    data.nowMin = E.nowMinFor(data.ref);
    data.sits = E.listSits(data.ref, data.nowMin, 6);
    if (!data.sits.some((s) => s.id === ui.sitId)) ui.sitId = data.sits.length ? data.sits[0].id : null;
    const start = Math.floor(data.nowMin / 30) * 30;
    data.scrubMin = start; data.scrubMax = Math.min(start + 48 * 60, data.ref.t[data.ref.t.length - 1]);
    const sit = currentSit();
    if (sit) list.forEach((s) => {
      const fc = data.fc[s.id]; if (!fc) return;
      const now = E.nowMinFor(fc), win = E.windowForStand(fc, sit, now);
      if (win) data.evals[s.id] = E.evaluateSit(s, fc, win, now);
    });
    data.ranks = list.filter((s) => data.evals[s.id]).sort((a, b) => data.evals[b.id].score - data.evals[a.id].score).map((s) => s.id);
    snapPreds();
    if (ui.tMin == null || ui.tMin < data.scrubMin || ui.tMin > data.scrubMax) ui.tMin = sit ? sitMid(sit) : data.scrubMin;
    renderAll();
  }

  /* ---------------- map + scrub + status ---------------- */
  function renderMap() {
    const items = stands().map((s) => {
      const fc = data.fc[s.id], st = fc && ui.tMin != null ? E.stateAt(s, fc, ui.tMin) : null, ev = data.evals[s.id];
      return {
        stand: s, state: st, cls: ev ? ev.label.cls : 'none', rank: ev ? data.ranks.indexOf(s.id) + 1 : 0,
        selected: ui.selStand === s.id, windText: st ? E.compass(st.eff.from) + ' ' + Math.round(st.eff.speed) : ''
      };
    });
    M.render({ stands: items, marks: S.state.marks.map((m) => ({ mark: m, selected: ui.selMark === m.id })), layers: settings().layers, animating: animOn(), routes: mapRoutes() });
    drawField();
  }

  /* ---- thermal flow across the map ----
   * Elevation for a grid over what is on screen gives each spot its slope and facing. The
   * forecast and sun at the chosen time then say whether air there is drifting uphill or
   * draining downhill. Estimated, like the stand thermals. */
  let fieldTimer = 0;
  function loadField() {
    clearTimeout(fieldTimer);
    fieldTimer = setTimeout(() => {
      if (!(settings().layers.field || settings().layers.swirl) || M.zoom < 13) { data.field = null; data.fieldKey = ''; M.renderField([]); return; }
      const grid = E.flowGrid(M.bounds(), M.zoom, 420);
      const key = grid.spacing + ':' + grid.rows + 'x' + grid.cols + ':' + grid.pts[0].join(',');
      if (key === data.fieldKey && data.field) return;
      data.fieldKey = key;
      W.elevations(grid.pts).then((z) => {
        if (data.fieldKey !== key) return;
        data.field = { cells: E.flowCells(grid, z), spacing: grid.spacing, dLat: grid.dLat, dLng: grid.dLng };
        drawField();
      });
    }, 350);
  }
  /* ---- benches: flat strips part-way up a hillside, worked out from lidar ground heights for the area in view.
   * Estimated from the shape of the ground only. announce = say what happened (used when the layer is switched on). */
  let benchTimer = 0, benchKey = '';
  function loadBenches(announce) {
    clearTimeout(benchTimer);
    benchTimer = setTimeout(() => {
      const on = !!(settings().overlays || {}).benches;
      // Ground cells of about 2 yd (1 yd when zoomed right in): fine enough to see a bench or old road bed only
      // 20 ft wide. Coarser data smears those into the hillside, so the layer needs a close zoom.
      const t = on && M.zoom >= 16 ? E.demTiles(M.bounds(), 60, 16, M.zoom >= 17.25 ? 17 : 16) : null;
      if (!t) { benchKey = ''; M.renderBenches(null); if (on && announce) toast('Zoom in closer to see benches.'); return; }
      const key = [t.z, t.x0, t.y0, t.nx, t.ny].join(',');
      if (key === benchKey) { M.setBenchOpacity(ovOpacity('benches')); return; }
      benchKey = key;
      if (announce) toast('Reading the ground for benches…');
      W.demMosaic(t).then((dem) => {
        if (benchKey !== key) return;
        if (dem.missing === dem.total) { benchKey = ''; if (announce) toast('Could not load the ground data for benches. Check your signal.'); return; }
        const res = E.findBenches(dem.z, dem.rows, dem.cols, t.cellM);
        M.renderBenches(res, t.bounds, ovOpacity('benches'));
        if (dem.missing) benchKey = '';   // part of the area failed to load: try again on the next move
        if (announce) toast(res.benches.length ? res.benches.length + (res.benches.length === 1 ? ' bench' : ' benches') + ' found in view (estimated).' : 'No benches found on the ground in view.');
      }).catch(() => { benchKey = ''; });
    }, 400);
  }
  /* ---- saddles and funnels: the strongest few in view, as small symbols you can tap. Estimated from the ground. */
  let spotTimer = 0, spotKey = '';
  function loadSpots(announce) {
    clearTimeout(spotTimer);
    spotTimer = setTimeout(() => {
      const ov = settings().overlays || {}, on = !!(ov.saddles || ov.funnels);
      const t = on && M.zoom >= 15 ? E.demTiles(M.bounds(), 150, 16, 15) : null;
      if (!t) { spotKey = ''; M.renderSpots(null); if (on && announce) toast('Zoom in closer to see saddles and funnels.'); return; }
      const key = [t.x0, t.y0, t.nx, t.ny, !!ov.saddles, !!ov.funnels].join(',');
      if (key === spotKey) return;
      spotKey = key;
      if (announce) toast('Reading the ground…');
      W.demMosaic(t).then((dem) => {
        if (spotKey !== key) return;
        if (dem.missing === dem.total) { spotKey = ''; if (announce) toast('Could not load the ground data. Check your signal.'); return; }
        const res = E.findSpots(dem.z, dem.rows, dem.cols, t.cellM), b = t.bounds;
        const place = (kind) => (s) => Object.assign({ kind: kind, lat: b.n - (s.row + 0.5) / dem.rows * (b.n - b.s), lng: b.w + (s.col + 0.5) / dem.cols * (b.e - b.w) }, s);
        const spots = (ov.saddles ? res.saddles.map(place('saddle')) : []).concat(ov.funnels ? res.funnels.map(place('funnel')) : []);
        M.renderSpots(spots, showSpot);
        if (dem.missing) spotKey = '';
        if (announce) {
          const count = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
          const parts = [ov.saddles ? count(res.saddles.length, 'saddle') : null, ov.funnels ? count(res.funnels.length, 'funnel') : null].filter(Boolean);
          toast(spots.length ? parts.join(' and ') + ' in view (estimated). Tap one for details.' : 'None found on the ground in view.');
        }
      }).catch(() => { spotKey = ''; });
    }, 400);
  }
  function showSpot(s) {
    const card = $('landcard'), ft = (m) => Math.round(m * 3.281);
    let title, body;
    if (s.kind === 'saddle') {
      title = 'Saddle';
      body = 'A low gap in the ridge, about ' + ft(s.depthM) + ' ft lower than the high ground on either side. The ridge runs ' + E.compass(s.axisDeg) + ' to ' + E.compass(s.axisDeg + 180) + ' through it.';
    } else {
      const w = s.sides.filter((x) => x === 'water').length, up = s.sides.filter((x) => x === 'up').length;
      const between = w === 2 ? 'water on both sides' : w === 1 ? 'water and ' + (up ? 'a steep bank' : 'a steep drop')
        : up === 2 ? 'steep ground rising on both sides, like the bottom of a hollow' : up === 0 ? 'steep drops on both sides, like a narrow ridge' : 'a steep bank above and a steep drop below';
      title = 'Funnel';
      body = 'Easy walking about ' + Math.round(E.yards(s.widthM)) + ' yd wide, squeezed between ' + between + '.';
    }
    card.replaceChildren(
      h('div', { class: 'lc-top' }, h('h3', null, title + ' (estimated)'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { card.hidden = true; } }, icon('close', 18))),
      h('div', null, body),
      h('div', { class: 'dim' }, 'Ground height about ' + ft(s.elevM) + ' ft.'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { card.hidden = true; holdAt(s.lat, s.lng); } }, icon('plus', 15), 'Add a mark here'),
      h('p', { class: 'lc-fine' }, 'Worked out from the shape of the ground only. It cannot see cover, fences or sign, so check it on foot.'));
    card.hidden = false;
  }
  function nearestFc(lat, lng) {
    let best = null, bd = Infinity;
    stands().forEach((s) => { const fc = data.fc[s.id]; if (!fc) return; const d = distM(lat, lng, s.lat, s.lng); if (d < bd) { bd = d; best = fc; } });
    return best || data.ref;
  }
  const animOn = () => settings().layers.animate !== false && SC.flow && SC.flow.active;
  function standScent() {
    // Scent puffs leave each stand and ride the same air as the particles.
    if (!settings().layers.cone || ui.tMin == null) return [];
    const out = [];
    stands().forEach((s) => {
      const fc = data.fc[s.id]; if (!fc) return;
      const st = E.stateAt(s, fc, ui.tMin), v = E.toVec(st.eff.from, 0.35 * st.eff.speed + 0.6);
      out.push({ lat: s.lat, lng: s.lng, reachM: E.clamp(55 + st.eff.speed * 30, 55, 420), fb: { u: v.u, v: v.v }, swirl: st.swirl });
    });
    return out;
  }
  function drawField() {
    const f = data.field, L_ = settings().layers, anim = animOn();
    const scentList = anim ? standScent() : [];
    const off = () => { M.renderField([]); if (SC.flow) SC.flow.set(anim && scentList.length ? { cells: [], swirls: [], stands: scentList } : null); };
    if (!f || !(L_.field || L_.swirl) || ui.tMin == null || !data.ref) return off();
    const b = M.bounds(), clat = (b.s + b.n) / 2, clng = (b.w + b.e) / 2, fc = nearestFc(clat, clng);
    if (!fc) return off();
    const smp = E.sampleForecast(fc, ui.tMin);
    const sun = E.solarPosition(ui.tMin * 60000 - fc.utcOffsetSec * 1000, clat, clng);
    const gw = E.toVec(smp.from, 0.35 * smp.speed);          // wind near the ground, under the trees
    const gmag = Math.hypot(gw.u, gw.v);
    const out = [], cells = [];
    f.cells.forEach((c) => {
      const th = E.thermal({ slopeDeg: c.slopeDeg, aspectDeg: c.aspectDeg, sun: sun, sw: smp.sw, cloud: smp.cloud, windMph: smp.speed });
      if (!L_.field) return;
      const sink = th.index < 0;
      if (anim) {
        // net air near the ground = ground wind + slope flow; color by which one is steering it
        const tm = th.toward != null ? th.potential * (0.55 + 0.45 * E.clamp(1 - smp.speed / 20, 0, 1)) : 0;
        const tu = tm ? tm * Math.sin(th.toward * E.DEG) : 0, tv = tm ? tm * Math.cos(th.toward * E.DEG) : 0;
        // share: how much of the air's push comes from the slope (under ~40% the wind overpowers it)
        const share = tm / (tm + gmag + 0.01);
        cells.push({ i: c.i, j: c.j, lat: c.lat, lng: c.lng, wu: gw.u, wv: gw.v, tu: tu, tv: tv, ts: E.clamp(tm / 2.2, 0, 1), share: share, sink: sink });
        return;
      }
      const pool = sink && c.low && c.slopeDeg < 4;
      if (th.strength < 0.05 && !pool) return;
      if (th.toward == null && !pool) return;
      const k = Math.min(1, th.strength * 1.5);
      out.push({ lat: c.lat, lng: c.lng, toward: th.toward, strength: pool ? Math.max(th.strength, 0.3) : th.strength, sink: sink, pool: pool, lenM: f.spacing * 0.8 * (0.45 + 0.55 * k) });
    });
    // Swirl spots, pinpointed on the fine lidar grid (see engine.swirlSpots). Stands draw their own.
    let swirls = L_.swirl ? E.swirlSpots(f.cells, f, { sun: sun, smp: smp })
      .filter((x) => !stands().some((st) => distM(st.lat, st.lng, x.lat, x.lng) < f.spacing * 0.9)) : [];
    if (anim) {
      // stands with swirl spin too
      scentList.forEach((st) => { if (L_.swirl && st.swirl && st.swirl.score >= 0.45) swirls.push({ lat: st.lat, lng: st.lng, score: st.swirl.score, rM: 28 + 14 * st.swirl.score }); });
      M.renderField([]);
      SC.flow.set({ cells: cells, dLat: f.dLat, dLng: f.dLng, swirls: swirls, stands: scentList });
      return;
    }
    if (SC.flow) SC.flow.set(null);
    M.renderField(out, swirls);
  }
  function trackGradient() {
    const ref = data.ref; if (!ref) return 'none';
    const night = getComputedStyle(document.documentElement).getPropertyValue('--night').trim();
    const day = getComputedStyle(document.documentElement).getPropertyValue('--day').trim();
    const a = data.scrubMin, b = data.scrubMax, span = Math.max(1, b - a);
    const isDay = (t) => ref.daily.some((d) => t >= d.sunrise && t <= d.sunset);
    const stops = []; let cur = null, from = 0;
    for (let t = a; t <= b; t += 15) {
      const c = isDay(t) ? day : night;
      if (c !== cur) { if (cur != null) stops.push(cur + ' ' + from + '% ' + ((t - a) / span * 100) + '%'); cur = c; from = (t - a) / span * 100; }
    }
    stops.push(cur + ' ' + from + '% 100%');
    return 'linear-gradient(to right,' + stops.join(',') + ')';
  }
  function renderScrub() {
    const box = $('scrub'), has = !!data.ref;
    box.classList.toggle('is-off', !has);
    if (!has) { $('scrub-time').textContent = stands().length ? 'Waiting for forecast' : 'Add a stand to see wind'; $('scrub-sun').textContent = ''; $('scrub-range').disabled = true; return; }
    const r = $('scrub-range');
    r.disabled = false; r.min = data.scrubMin; r.max = data.scrubMax; r.step = 10; r.value = ui.tMin;
    r.style.setProperty('--track', trackGradient());
    $('scrub-time').textContent = E.fmtDayClock(ui.tMin);
    const day = data.ref.daily.filter((d) => d.date === E.dateKey(ui.tMin))[0];
    $('scrub-sun').textContent = day ? 'Sunrise ' + E.fmtClock(day.sunrise) + '  ·  Sunset ' + E.fmtClock(day.sunset) : '';
  }
  function renderStatus() {
    const el = $('status');
    if (!stands().length) { el.hidden = true; return; }
    el.hidden = false; el.className = 'chip';
    if (data.loading) { el.textContent = 'Updating wind…'; return; }
    if (!data.ref) { el.textContent = 'No forecast. Tap to retry'; el.classList.add('warn'); return; }
    if (data.error) { el.textContent = 'Offline. Forecast from ' + localTime(data.at); el.classList.add('warn'); return; }
    el.textContent = 'Wind updated ' + localTime(data.at);
  }
  let scrubRaf = 0;
  function setScrub(t, fromSlider) {
    ui.tMin = Math.max(data.scrubMin, Math.min(data.scrubMax, t));
    cancelAnimationFrame(scrubRaf);
    scrubRaf = requestAnimationFrame(() => {
      $('scrub-time').textContent = E.fmtDayClock(ui.tMin);
      if (!fromSlider) $('scrub-range').value = ui.tMin;
      renderMap();
      document.querySelectorAll('.cell').forEach((c) => c.classList.toggle('is-now', Math.abs(+c.dataset.t + 30 - ui.tMin) <= 30));
    });
  }

  /* ---------------- sheet ---------------- */
  let lastKey = '';
  function setSheet(size) {
    const sh = $('sheet');
    ui.sheet = size; sh.dataset.size = size; sh.style.height = '';
    setTimeout(M.invalidate, 260);
  }

  /* ---- bottom panel: drag it like a maps app ----
   * Grab the handle or anywhere on the panel's top area (not the slider or buttons). It follows your
   * finger, then snaps to the nearest size; a quick flick goes one size in that direction.
   * In the list, pulling down while already scrolled to the top drags the panel down. */
  function sheetHeights() {
    const sh = $('sheet'), vh = sh.parentElement.clientHeight;
    const peek = sh.querySelector('.sheet-head').offsetHeight + $('tabs').offsetHeight + 4;
    return { peek: peek, half: Math.min(vh * 0.6, 640), full: vh - 120 };
  }
  function wireSheetDrag() {
    const sh = $('sheet'), head = sh.querySelector('.sheet-head'), body = $('sheet-body');
    let drag = null;
    const isMobileNow = () => isMobile();
    function begin(y, src) {
      const H = sheetHeights();
      drag = { y0: y, h0: sh.offsetHeight, H: H, src: src, moved: false, last: [{ y: y, t: performance.now() }] };
      sh.style.transition = 'none';
    }
    function move(y) {
      if (!drag) return;
      const dy = y - drag.y0;
      if (Math.abs(dy) > 4) drag.moved = true;
      const h = Math.max(drag.H.peek * 0.85, Math.min(drag.H.full + 20, drag.h0 - dy));
      sh.style.height = h + 'px';
      drag.last.push({ y: y, t: performance.now() }); if (drag.last.length > 5) drag.last.shift();
    }
    function end() {
      if (!drag) return;
      const d = drag; drag = null;
      sh.style.transition = '';
      if (!d.moved) { if (d.src === 'grab') { const order = ['peek', 'half', 'full']; setSheet(order[(order.indexOf(ui.sheet) + 1) % 3]); } else sh.style.height = ''; return; }
      // speed over the last ~100 ms only; a finger that stopped before letting go is not a flick
      const now = performance.now(), recent = d.last.filter((p) => now - p.t < 110);
      let v = 0;
      if (recent.length >= 2) { const a = recent[0], b = recent[recent.length - 1]; v = (b.y - a.y) / Math.max(1, b.t - a.t); }
      const h = sh.offsetHeight, H = d.H;
      const sizes = [['peek', H.peek], ['half', H.half], ['full', H.full]];
      let pick;
      if (Math.abs(v) > 0.45) {
        // flick: go to the next size in that direction
        const cur = sizes.reduce((best, s) => Math.abs(s[1] - d.h0) < Math.abs(best[1] - d.h0) ? s : best);
        const i = sizes.indexOf(cur);
        pick = sizes[Math.max(0, Math.min(2, i + (v < 0 ? 1 : -1)))];
      } else pick = sizes.reduce((best, s) => Math.abs(s[1] - h) < Math.abs(best[1] - h) ? s : best);
      // animate from the dragged height to the snapped one, then hand control back to the CSS sizes
      sh.style.height = pick[1] + 'px';
      setTimeout(() => setSheet(pick[0]), 230);
    }
    const blocked = (t) => t.closest('input, button:not(#grab), select, textarea, a');
    // handle and panel top: pointer events
    head.addEventListener('pointerdown', (e) => {
      if (!isMobileNow() || (e.pointerType === 'mouse' && e.button !== 0) || blocked(e.target)) return;
      begin(e.clientY, e.target.closest('#grab') ? 'grab' : 'head');
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => { if (drag && drag.src !== 'body') move(e.clientY); });
    head.addEventListener('pointerup', () => { if (drag && drag.src !== 'body') end(); });
    head.addEventListener('pointercancel', () => { if (drag && drag.src !== 'body') end(); });
    // list: pull down from the top to shrink the panel
    let ty = null;
    body.addEventListener('touchstart', (e) => { ty = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
    body.addEventListener('touchmove', (e) => {
      if (ty == null || !isMobileNow()) return;
      const y = e.touches[0].clientY;
      if (!drag) {
        if (body.scrollTop <= 0 && y - ty > 8) begin(ty, 'body'); else return;
      }
      e.preventDefault();
      move(y);
    }, { passive: false });
    const tEnd = () => { ty = null; if (drag && drag.src === 'body') end(); };
    body.addEventListener('touchend', tEnd); body.addEventListener('touchcancel', tEnd);
  }
  let rendering = false, renderAgain = false;
  function renderSheet() {
    if (rendering) { renderAgain = true; return; }   // a blur handler fired while the panel was being replaced
    rendering = true;
    try { drawSheet(); } finally { rendering = false; }
    if (renderAgain) { renderAgain = false; renderSheet(); }
  }
  function drawSheet() {
    const body = $('sheet-body'), key = ui.view + ':' + ui.tab + ':' + (ui.selStand || ui.selMark || '') + ':' + (stands().length ? 'has' : 'none') + ':' + (data.ref ? 'fc' : 'nofc');
    const keep = key === lastKey ? body.scrollTop : 0; lastKey = key;
    if (ui.view !== 'add') clearPending();   // left the chooser without picking
    if (ui.view !== 'spots' && ui.sites) { ui.sites = null; M.renderSites(null); }
    // moving on to anything else keeps an unsaved pin, the same as tapping Save
    if (ui.draft && !(ui.draft.kind === 'stand' ? ui.view === 'stand' && ui.selStand === ui.draft.id : ui.view === 'mark' && ui.selMark === ui.draft.id)) ui.draft = null;
    let node;
    if (ui.view === 'add') node = addView();
    else if (ui.view === 'photo') node = photoAddView();
    else if (ui.view === 'placing') node = placingView();
    else if (ui.view === 'import') node = importView();
    else if (ui.view === 'spots') node = siteView();
    else if (ui.view === 'stand') node = standView();
    else if (ui.view === 'mark') node = markView();
    else if (ui.tab === 'marks') node = marksView();
    else if (ui.tab === 'photos') node = photosView();
    else if (ui.tab === 'guide') node = guideView();
    else node = listView();
    body.replaceChildren(node);
    body.scrollTop = keep;
    document.querySelectorAll('#tabs button').forEach((b) => {
      const on = b.dataset.tab === ui.tab && (ui.view === 'list');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    });
    $('fab').hidden = $('btn-photo').hidden = ui.view === 'placing';
  }
  function renderAll() { renderMap(); renderSheet(); renderScrub(); renderStatus(); }

  function go(view, extra) {
    Object.assign(ui, { view: view }, extra || {});
    if (view === 'list') { ui.selStand = null; ui.selMark = null; }
    renderAll();
  }
  function selectStand(id, fly) {
    const s = S.getStand(id); if (!s) return;
    ui.selStand = id; ui.selMark = null; ui.view = 'stand'; ui.tab = 'stands'; ui.logOpen = false;
    if (isMobile() && ui.sheet === 'peek') setSheet('half');
    renderAll();
    if (fly !== false) M.flyTo(s.lat, s.lng, Math.max(M.zoom, 16), isMobile() ? $('sheet').offsetHeight : 0);
  }
  function selectMark(id, fly) {
    const m = S.getMark(id); if (!m) return;
    ui.selMark = id; ui.selStand = null; ui.view = 'mark'; ui.tab = 'marks';
    if (isMobile() && ui.sheet === 'peek') setSheet('half');
    renderAll();
    if (fly !== false) M.flyTo(m.lat, m.lng, Math.max(M.zoom, 17), isMobile() ? $('sheet').offsetHeight : 0);
  }
  function backHeader(title, onBack, right) {
    return h('div', { class: 'view-top' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: onBack }, icon('back')),
      h('div', { class: 'view-title' }, title), right || null);
  }

  /* ---- ranking list ---- */
  function windSummary(ev) {
    const sm = ev.summary;
    let txt = E.compass(sm.from) + ' ' + Math.round(sm.speed) + ' mph';
    const down = (sm.thermalFlips || []).filter((f) => f.to === 'falling').pop();
    if (sm.swirlFrom != null) txt += '  ·  swirl from ' + E.fmtClock(sm.swirlFrom);
    else if (down) txt += '  ·  air turns downhill ' + E.fmtClock(down.t);
    else if (sm.thermalStrength >= 0.12) txt += '  ·  thermals ' + E.thermalWords(sm.thermalPhase);
    return txt;
  }
  function emptyView() {
    return h('div', { class: 'empty' },
      h('h2', null, 'Which stand tonight?'),
      h('p', null, 'Mark your stands, say which winds work for each one, and StandCast ranks them for your next sit using the forecast, the slope of the hill and the sun.'),
      h('div', { class: 'stack' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => startPlacing('stand') }, 'Add your first stand'),
        h('button', { class: 'btn', type: 'button', onclick: loadExamples }, 'Try it with example stands')),
      h('p', { class: 'fine' }, 'Everything stays on this device. Wind is modeled from a weather forecast and thermals are estimated, so treat both as a strong hint and not a sensor reading.'));
  }
  function listView() {
    if (!stands().length) return emptyView();
    const root = h('div', { class: 'view' });
    const sit = currentSit(), win = sit ? { start: sit.start, end: sit.end } : null;
    root.appendChild(h('div', { class: 'view-head' },
      h('h2', null, 'Which stand?'),
      win ? h('p', { class: 'sub' }, E.fmtDayClock(sit.start) + ' to ' + E.fmtClock(sit.end)) : null));
    const note = backupNote(); if (note) root.appendChild(note);
    if (data.sits.length) {
      root.appendChild(h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Hunt window' },
        data.sits.map((s) => h('button', {
          class: 'chip-btn' + (s.id === ui.sitId ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': s.id === ui.sitId ? 'true' : 'false',
          onclick: () => { ui.sitId = s.id; ui.tMin = null; recompute(); }
        }, s.label))));
    } else if (data.loading) {
      root.appendChild(h('p', { class: 'note' }, 'Loading the forecast…'));
    } else {
      root.appendChild(h('div', { class: 'note warn' },
        h('p', null, data.error || 'No forecast yet.'),
        h('button', { class: 'btn', type: 'button', onclick: () => refresh(true) }, icon('refresh', 16), 'Try again')));
    }
    data.ranks.forEach((id, i) => {
      const s = S.getStand(id), ev = data.evals[id];
      if (!s || !ev) return;
      const why = ev.reasons.filter((r, k) => k === 0 || r.kind === 'bad' || r.kind === 'warn').slice(0, 2);
      root.appendChild(h('button', { class: 'card ' + ev.label.cls, type: 'button', onclick: () => selectStand(id) },
        h('span', { class: 'rank-pin ' + ev.label.cls }, String(i + 1)),
        h('span', { class: 'card-main' },
          h('span', { class: 'card-title' }, h('b', null, s.name), s.example ? h('em', { class: 'tag' }, 'Example') : null),
          h('span', { class: 'card-wind' }, arrow(E.norm(ev.summary.from + 180), 'wind', 15), windSummary(ev)),
          why.map((r) => h('span', { class: 'why ' + r.kind }, r.text)),
          recordText(s) ? h('span', { class: 'why record-line' }, recordText(s) + (E.fixDeg(s) ? ' (learned)' : '')) : null),
        h('span', { class: 'card-score' }, h('b', null, String(ev.score)), h('span', { class: ev.label.cls }, ev.label.text))));
    });
    stands().filter((s) => !data.evals[s.id]).forEach((s) => {
      root.appendChild(h('button', { class: 'card none', type: 'button', onclick: () => selectStand(s.id) },
        h('span', { class: 'rank-pin none' }, '•'),
        h('span', { class: 'card-main' }, h('span', { class: 'card-title' }, h('b', null, s.name)),
          h('span', { class: 'why info' }, data.loading ? 'Loading forecast…' : 'No forecast for this stand yet.'))));
    });
    root.appendChild(h('button', { class: 'btn wide-btn', type: 'button', onclick: findSites }, icon('search', 16), 'Find new stand sites in view'));
    root.appendChild(h('p', { class: 'fine' }, 'Wind is modeled from a weather forecast. Thermals are estimated from the slope, sun and clouds. Scores are a guide, so trust your own read of the woods.'));
    return root;
  }

  /* ---- stand detail ---- */
  function timeline(s, fc) {
    const sit = currentSit(), win = sit ? E.windowForStand(fc, sit, E.nowMinFor(fc)) : null;
    const sun = {};
    fc.daily.forEach((d) => { sun[Math.floor(d.sunrise / 60) * 60] = 'sunrise'; sun[Math.floor(d.sunset / 60) * 60] = 'sunset'; });
    const start = Math.floor(E.nowMinFor(fc) / 60) * 60, last = fc.t[fc.t.length - 1];
    const row = h('div', { class: 'timeline', role: 'list' });
    let firstInWin = null, prevDay = null;
    for (let t = start; t <= start + 36 * 60 && t <= last; t += 60) {
      const st = E.stateAt(s, fc, t), cls = E.ratingClass(st.rating), day = E.dateKey(t);
      const inWin = win && t + 60 > win.start && t <= win.end;
      const cell = h('button', {
        class: 'cell ' + cls + (inWin ? ' in-win' : '') + (Math.abs(t + 30 - ui.tMin) <= 30 ? ' is-now' : ''),
        type: 'button', role: 'listitem', 'data-t': t,
        'aria-label': E.fmtDayClock(t) + ': ' + E.compass(st.eff.from) + ' wind ' + Math.round(st.eff.speed) + ' mph, ' + (cls === 'good' ? 'good' : cls === 'bad' ? 'bad' : 'okay') + ' for this stand',
        onclick: () => setScrub(t + 30)
      },
        h('span', { class: 'cell-h' }, day !== prevDay ? E.fmtDayClock(t).split(' ')[0] + ' ' + E.fmtHour(t) : E.fmtHour(t)),
        arrow(E.norm(st.eff.from + 180), 'cell-arrow', 20),
        h('span', { class: 'cell-s' }, String(Math.round(st.eff.speed))),
        st.swirl.score >= 0.5 ? h('span', { class: 'cell-t swirl', title: 'Swirl likely' }, '↻') :
        h('span', { class: 'cell-t ' + (st.thermal.strength >= 0.06 ? (st.thermal.index < 0 ? 'down' : 'up') : 'none') },
          st.thermal.strength >= 0.06 ? (st.thermal.index < 0 ? '▼' : '▲') : '·'),
        h('span', { class: 'cell-sun' }, sun[t] || ''));
      prevDay = day;
      if (inWin && !firstInWin) firstInWin = cell;
      row.appendChild(cell);
    }
    requestAnimationFrame(() => { if (firstInWin) row.scrollLeft = Math.max(0, firstInWin.offsetLeft - 24); });
    return h('div', { class: 'timeline-wrap' }, row,
      h('p', { class: 'fine tight' }, 'Arrow shows where the air is going, with the number in mph. ▲ air drifting uphill, ▼ air draining downhill, ↻ swirl likely (all estimated). Outlined hours are your hunt window.'));
  }
  function meter(label, v) {
    const pct = Math.round(E.clamp(v, 0, 1) * 100);
    return h('div', { class: 'meter' }, h('span', { class: 'meter-l' }, label),
      h('span', { class: 'meter-bar' }, h('span', { style: 'width:' + pct + '%' })), h('span', { class: 'meter-v' }, pct + '%'));
  }
  function windGrid(s) {
    const order = ['NW', 'N', 'NE', 'W', null, 'E', 'SW', 'S', 'SE'];
    const word = { good: 'good for this stand', bad: 'bad for this stand' };
    return h('div', { class: 'wind-grid' }, order.map((d) => {
      if (!d) return h('div', { class: 'wg-mid', 'aria-hidden': 'true' }, 'Your stand');
      const st = (s.winds || {})[d];
      return h('button', {
        class: 'wg ' + (st || 'none'), type: 'button',
        'aria-label': d + ' wind: ' + (word[st] || 'does not matter') + '. Tap to change.',
        onclick: () => {
          const w = Object.assign({}, s.winds), cur = w[d];
          if (!cur) w[d] = 'good'; else if (cur === 'good') w[d] = 'bad'; else delete w[d];
          S.updateStand(s.id, { winds: w }); recompute();
        }
      }, h('span', null, d), h('small', null, st === 'good' ? 'Good' : st === 'bad' ? 'Bad' : ''));
    }));
  }
  function terrainPanel(s) {
    const t = E.resolveTerrain(s);
    let line;
    if (data.terrainBusy[s.id]) line = 'Checking the terrain…';
    else if (t.source === 'none') line = data.terrainFailed[s.id] ? 'Could not load terrain data. Check your connection.' : 'Terrain not loaded yet.';
    else line = 'Slope ' + Math.round(t.slopeDeg) + '°, ' + (t.aspectDeg == null ? 'no clear direction' : 'facing ' + E.compass(t.aspectDeg)) + (t.source === 'auto' ? (s.terrain && s.terrain.src === 'lidar' ? ' (from 1 m lidar)' : ' (from 90 m terrain data)') : ' (set by you)');
    const ov = s.override || {};
    const opt = (v, l, cur) => h('option', { value: v, selected: v === cur }, l);
    const sel = (id, label, cur, opts, key) => h('label', { class: 'field', for: id }, h('span', null, label),
      h('select', {
        id, value: cur || '', onchange: (e) => {
          const o = Object.assign({}, s.override); if (e.target.value) o[key] = e.target.value; else delete o[key];
          S.updateStand(s.id, { override: o }); recompute();
        }
      }, opts));
    const fc = data.fc[s.id], flipsBox = h('div', { class: 'stack' });
    if (fc) {
      const now = E.nowMinFor(fc), flips = E.thermalSwitches(s, fc, now, now + 26 * 60).slice(0, 2);
      flips.forEach((f) => {
        const st = E.stateAt(s, fc, f.t + 30);
        const where = st.thermal.toward != null ? 'Scent slides ' + (f.to === 'falling' ? 'downhill' : 'uphill') + ' toward the ' + E.compass(st.thermal.toward) + '.'
          : (f.to === 'falling' ? 'Flat ground: scent settles and pools around you.' : 'Flat ground: scent lifts straight up.');
        flipsBox.appendChild(h('div', { class: 'flip ' + f.to },
          h('b', null, E.fmtDayClock(f.t)),
          h('span', null, (f.to === 'falling' ? 'Air turns downhill. ' : 'Air turns uphill. ') + where)));
      });
      if (!flips.length) flipsBox.appendChild(h('p', { class: 'line dim' }, 'No thermal flip in the next day.'));
    }
    return h('div', { class: 'block' },
      h('h3', null, 'Thermals and terrain'),
      flipsBox,
      h('p', { class: 'line' }, line),
      h('div', { class: 'row2' },
        sel('ov-aspect', 'Slope faces', ov.aspect, [opt('', 'Auto', ov.aspect || '')].concat(E.SECTORS.map((d) => opt(d, d, ov.aspect)), [opt('flat', 'Flat', ov.aspect)]), 'aspect'),
        sel('ov-steep', 'Steepness', ov.steep, [opt('', 'Auto', ov.steep || ''), opt('flat', 'Flat', ov.steep), opt('gentle', 'Gentle', ov.steep), opt('moderate', 'Moderate', ov.steep), opt('steep', 'Steep', ov.steep)], 'steep')),
      h('p', { class: 'fine tight' }, 'The terrain data is coarse. If you know this hillside is steeper or faces another way, set it here and the thermal estimate follows.'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { S.updateStand(s.id, { terrain: null }); delete data.terrainFailed[s.id]; renderSheet(); ensureTerrain(); } }, icon('refresh', 15), 'Recheck terrain'));
  }
  function todayKey() {
    if (data.ref) return E.dateKey(E.nowMinFor(data.ref));
    const d = new Date(); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  /* ---- sit log and wind-check track record ----
   * Before each sit, StandCast's call for every stand is saved on this device (PRED_KEY). When a sit is logged
   * with the hunter's own wind check, that call is copied into the sit, so the two can be compared later.
   * Once 3 or more checks agree that a stand's air runs off the forecast, the stand gets a learned turn (windFix). */
  const PRED_KEY = 'standcast.preds.v1';
  let lastSnap = 0;
  function loadPreds() { try { return JSON.parse(localStorage.getItem(PRED_KEY)) || {}; } catch (e) { return {}; } }
  function predFrom(s, ev) {
    const m = ev.summary;
    return { from: Math.round(m.from), raw: Math.round(E.norm(m.from - E.fixDeg(s))), speed: Math.round(m.speed * 10) / 10,
      swirl: Math.round(m.swirlFrac * 100) / 100, thermal: m.thermalPhase, score: ev.score };
  }
  function sitKey(id, date, kind) { return id + '|' + date + '|' + kind; }
  // Save today's calls. A call stops updating half an hour into the sit, so it stays what the hunter went in with.
  function snapPreds(force) {
    if (!data.ref || (!force && Date.now() - lastSnap < 60000)) return;
    lastSnap = Date.now();
    const keep = loadPreds(), today = E.dateKey(data.nowMin);
    stands().forEach((s) => {
      const fc = data.fc[s.id]; if (!fc || s.example) return;
      const now = E.nowMinFor(fc);
      ['AM', 'PM'].forEach((kind) => {
        const w = E.sitWindowFor(fc, today, kind);
        if (w && now <= w.start + 30) keep[sitKey(s.id, today, kind)] = predFrom(s, E.evaluateSit(s, fc, w, now));
      });
    });
    Object.keys(keep).forEach((k) => { const p = k.split('|'); if (E.dayDiff(p[p.length - 2], today) > 10) delete keep[k]; });
    try { localStorage.setItem(PRED_KEY, JSON.stringify(keep)); } catch (e) { /* storage full: the log still works without calls */ }
  }
  // StandCast's call for a stand's sit: the saved one, or worked out now if the forecast still covers that day.
  function predFor(s, date, kind) {
    const saved = loadPreds()[sitKey(s.id, date, kind)];
    if (saved) return saved;
    const fc = data.fc[s.id], w = fc && E.sitWindowFor(fc, date, kind);
    if (!w || w.start < fc.t[0]) return null;
    return predFrom(s, E.evaluateSit(s, fc, w, E.nowMinFor(fc)));
  }
  function saveSits(s, sits) {
    const fix = E.windFixFrom(sits), was = s.windFix;
    const windFix = fix ? Object.assign(fix, was && was.off ? { off: true } : null) : null;
    S.updateStand(s.id, { sits, windFix });
    if (fix && (!was || was.deg !== fix.deg) && !(was && was.off)) toast('StandCast learned this stand\'s wind from your checks');
  }
  const OUTCOMES = [['range', 'Deer in range'], ['seen', 'Saw deer'], ['busted', 'Winded me'], ['none', 'No deer']];
  const OBS_WORD = { calm: 'calm', swirl: 'swirling' };
  const obsText = (o) => OBS_WORD[o] || o;
  // the record line for the ranking card, e.g. "Wind calls matched your checks 9 of 11"
  function recordText(s) {
    const r = E.sitRecord(s.sits);
    return r.checks ? 'Wind calls matched your checks ' + r.hits + ' of ' + r.checks : '';
  }
  function fmtLogDate(d) {
    const p = d.split('-');
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + (+p[2]);
  }
  function sitRow(s, x) {
    const c = E.checkSit(x), bits = [];
    if (x.obs) bits.push('Wind ' + obsText(x.obs));
    if (x.pred) bits.push('we said ' + (x.obs === 'calm' ? (x.pred.speed < 3 ? 'light' : Math.round(x.pred.speed) + ' mph') : x.obs === 'swirl' ? (x.pred.swirl >= 0.3 ? 'swirl' : 'no swirl') : E.compass(x.pred.from)));
    const out = OUTCOMES.filter((o) => o[0] === x.outcome)[0];
    if (out) bits.push(out[1]);
    if (x.deer != null && x.deer !== '') bits.push(x.deer + ' deer');
    if (x.note) bits.push(x.note);
    return h('div', { class: 'logrow' },
      c ? h('span', { class: 'chk ' + (c.hit ? 'hit' : 'miss'), title: c.hit ? 'Our call matched' : 'Our call missed' }, c.hit ? '✓' : '✗') : h('span', { class: 'chk none' }, '·'),
      h('span', null, h('b', null, fmtLogDate(x.date) + (x.kind ? ' ' + x.kind : '')), bits.length ? '  ·  ' + bits.join('  ·  ') : ''),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove this sit', onclick: () => {
        saveSits(s, (s.sits || []).filter((y) => y !== x)); recompute();
      } }, icon('close', 16)));
  }
  function trackRecord(s) {
    const r = E.sitRecord(s.sits), box = h('div', { class: 'record' });
    if (!r.checks) {
      box.appendChild(h('p', { class: 'line dim' }, 'After each sit, note which way the milkweed drifted. StandCast checks it against its call for this stand and keeps score here. After 3 checks that agree, it learns how the wind really runs at this stand.'));
      return box;
    }
    const pct = Math.round(100 * r.hits / r.checks);
    box.appendChild(h('p', { class: 'record-main' }, h('b', null, r.hits + ' of ' + r.checks), ' wind calls matched your checks here (' + pct + '%).'));
    const split = ['AM', 'PM'].filter((k) => r[k].checks).map((k) => (k === 'AM' ? 'Mornings ' : 'Evenings ') + r[k].hits + ' of ' + r[k].checks);
    if (split.length === 2) box.appendChild(h('p', { class: 'line dim' }, split.join('  ·  ')));
    if (r.busted) box.appendChild(h('p', { class: 'line dim' }, 'Winded ' + r.busted + (r.busted === 1 ? ' time' : ' times') + ' in ' + r.sits + ' logged sits.'));
    const f = s.windFix;
    if (f) {
      const ex = 225, side = f.deg > 0 ? 'clockwise' : 'counterclockwise';
      box.appendChild(h('div', { class: 'note' + (f.off ? '' : ' good') },
        h('p', null, 'Your ' + f.n + ' checks show the air here runs about ' + Math.abs(f.deg) + '° ' + side + ' of the forecast (a forecast ' + E.compass(ex) + ' wind reads more like ' + E.compass(ex + f.deg) + ' at this stand). ' +
          (f.off ? 'This correction is off.' : 'StandCast now turns this stand\'s wind to match.')),
        h('button', { class: 'btn small', type: 'button', onclick: () => {
          S.updateStand(s.id, { windFix: Object.assign({}, f, { off: !f.off }) }); recompute();
        } }, f.off ? 'Use the correction' : 'Turn the correction off')));
    } else if (r.checks >= E.FIX.min) {
      box.appendChild(h('p', { class: 'line dim' }, 'No steady difference from the forecast at this stand, so StandCast uses it as is.'));
    }
    return box;
  }
  function choiceRow(opts, cur, onPick, cls) {
    const row = h('div', { class: 'choice ' + (cls || '') });
    opts.forEach((o) => row.appendChild(h('button', { class: 'chip-btn' + (o[0] === cur ? ' on' : ''), type: 'button', 'aria-pressed': o[0] === cur ? 'true' : 'false',
      onclick: () => { onPick(o[0] === cur ? null : o[0]); } }, o[1])));
    return row;
  }
  function sitLog(s) {
    const all = s.sits || [], list = all.slice(-6).reverse();
    const box = h('div', { class: 'block' }, h('h3', null, 'Sit log and wind checks'), trackRecord(s));
    list.forEach((x) => box.appendChild(sitRow(s, x)));
    if (all.length > list.length) box.appendChild(h('p', { class: 'fine tight' }, (all.length - list.length) + ' older sits are kept and counted.'));
    if (!ui.logOpen) {
      box.appendChild(h('button', { class: 'btn small', type: 'button', onclick: () => {
        const hr = new Date().getHours();
        ui.logOpen = { kind: hr < 12 ? 'AM' : 'PM', obs: null, outcome: null }; renderSheet();
      } }, icon('plus', 15), 'Log a sit'));
      return box;
    }
    const f = ui.logOpen;
    const d = h('input', { id: 'log-date', type: 'date', value: f.date || todayKey(), onchange: () => { f.date = d.value; } });
    const n = h('input', { id: 'log-deer', type: 'number', min: 0, max: 99, inputmode: 'numeric', placeholder: '0', value: f.deer || '', oninput: () => { f.deer = n.value; } });
    const t = h('input', { id: 'log-note', type: 'text', maxlength: 80, placeholder: 'Optional note', value: f.note || '', oninput: () => { f.note = t.value; } });
    const pick = (k) => (v) => { f[k] = v; renderSheet(); };
    const compassPad = h('div', { class: 'wind-grid obs' }, ['NW', 'N', 'NE', 'W', 'calm', 'E', 'SW', 'S', 'SE'].map((k) =>
      h('button', { class: 'wg ' + (f.obs === k ? 'good' : 'none'), type: 'button', 'aria-pressed': f.obs === k ? 'true' : 'false',
        'aria-label': k === 'calm' ? 'Calm, no drift' : 'Wind from the ' + k, onclick: () => pick('obs')(f.obs === k ? null : k) },
      h('span', null, k === 'calm' ? 'Calm' : k))));
    box.appendChild(h('div', { class: 'logform' },
      h('label', { class: 'field', for: 'log-date' }, h('span', null, 'Date'), d),
      h('div', { class: 'field' }, h('span', null, 'Sit'), choiceRow([['AM', 'Morning'], ['PM', 'Evening']], f.kind, (v) => pick('kind')(v || f.kind))),
      h('div', { class: 'field wide' }, h('span', null, 'Which way was the wind coming FROM at the stand? (milkweed, smoke, powder)'), compassPad,
        choiceRow([['swirl', 'Swirling, kept changing']], f.obs, pick('obs'))),
      h('div', { class: 'field wide' }, h('span', null, 'How did it go?'), choiceRow(OUTCOMES, f.outcome, pick('outcome'))),
      h('label', { class: 'field', for: 'log-deer' }, h('span', null, 'Deer seen'), n),
      h('label', { class: 'field wide', for: 'log-note' }, h('span', null, 'Note'), t),
      h('div', { class: 'row2' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => {
          if (!d.value) return;
          const sit = { date: d.value, kind: f.kind, deer: n.value === '' ? null : +n.value, note: t.value.trim() };
          if (f.obs) sit.obs = f.obs;
          if (f.outcome) sit.outcome = f.outcome;
          const p = predFor(s, sit.date, sit.kind);
          if (p) sit.pred = p;
          const order = (x) => x.date + (x.kind === 'PM' ? '2' : '1');
          const sits = all.concat([sit]).sort((a, b) => (order(a) < order(b) ? -1 : 1));
          ui.logOpen = false; saveSits(s, sits);
          const c = E.checkSit(sit);
          toast(c ? (c.hit ? 'Sit logged. Our wind call matched.' : 'Sit logged. Our wind call missed; noted for this stand.') :
            f.obs && !p ? 'Sit logged. No saved call for that day, so the wind check is not scored.' : 'Sit logged');
          recompute();
        } }, 'Save sit'),
        h('button', { class: 'btn', type: 'button', onclick: () => { ui.logOpen = false; renderSheet(); } }, 'Cancel'))));
    return box;
  }
  /* ---- the walk in and out ----
   * stand.routes = { in: [[lat,lng],...] drawn from the truck to the stand, out: the same or null (= same way out) }.
   * Ground slope along the walk comes from lidar (5 heights round each point), kept in routeTerrain by route,
   * so the check itself (engine.routeScent) is quick enough to redo whenever the hunt window changes. */
  const routeTerrain = {}, routeBusy = {};
  function routeLine(s, which) { const r = s.routes || {}; return which === 'out' ? (r.out || r.in || null) : (r.in || null); }
  function routePts(line) {
    const key = JSON.stringify(line);
    if (routeTerrain[key]) return routeTerrain[key];
    if (routeBusy[key]) return null;
    const pts = E.resampleLine(line).pts, probes = [];
    pts.forEach((p) => E.terrainProbePoints(p.lat, p.lng, 25).forEach((q) => probes.push(q)));
    routeBusy[key] = true;
    W.elevations(probes).then((z) => {
      let missing = 0;
      pts.forEach((p, i) => {
        const k = i * 5, zz = z.slice(k, k + 5);
        if (zz.some((v) => v == null)) { missing++; return; }
        p.terrain = E.terrainFromSamples(zz[1], zz[2], zz[3], zz[4], 25);
      });
      routeTerrain[key] = { pts: pts, missing: missing };
    }).catch(() => { routeTerrain[key] = { pts: pts, missing: pts.length }; })
      .then(() => { delete routeBusy[key]; renderSheet(); renderMap(); });
    return null;
  }
  // The check for one stand's walk in or out in the chosen hunt window: the engine result plus timing, or a reason.
  function routeCheck(s, which) {
    const line = routeLine(s, which), fc = data.fc[s.id], sit = currentSit();
    if (!line || line.length < 2) return { none: true };
    if (!fc || !sit) return { wait: 'No forecast yet.' };
    const w = E.sitWindowFor(fc, sit.date, sit.kind);
    if (!w) return { wait: 'No forecast for this hunt yet.' };
    const rt = routePts(line);
    if (!rt) return { wait: 'Checking the wind along your route…' };
    const res = E.routeScent(rt.pts, fc, { dir: which, t0: which === 'out' ? w.end : w.start, marks: S.state.marks });
    res.noTerrain = rt.missing > rt.pts.length / 2;
    return res;
  }
  function markLabel(m) { const t = MT.TYPES[m.type] || MT.TYPES.other; return t.label + (m.name ? ' "' + m.name + '"' : ''); }
  function routeSummary(s, which) {
    const r = routeCheck(s, which), sit = currentSit(), same = which === 'out' && !(s.routes || {}).out;
    const head = which === 'in' ? 'Walk in' : 'Walk out' + (same ? ' (same way)' : '');
    if (r.none) return null;
    if (r.wait) return h('div', { class: 'route-sum' }, h('b', null, head), h('p', { class: 'line dim' }, r.wait));
    const when = which === 'in' ? 'leave the truck about ' + E.fmtClock(r.start) + ' to be in by ' + E.fmtClock(r.end)
      : 'leaving the stand about ' + E.fmtClock(r.start);
    const box = h('div', { class: 'route-sum ' + (r.hits.length ? 'bad' : 'good') },
      h('b', null, head + ': ' + E.fmtYards(r.lengthM) + ', about ' + Math.max(1, Math.round(r.minutes)) + ' min'),
      h('p', { class: 'line dim' }, (sit ? sit.label + ': ' : '') + when + '.'));
    if (!r.hits.length) box.appendChild(h('p', { class: 'why good' }, 'Clean: your scent stays off the sign you have marked.'));
    r.hits.slice(0, 4).forEach((x) => box.appendChild(h('p', { class: 'why bad' },
      'About ' + E.fmtClock(x.t) + ' your scent drifts over ' + markLabel(x.mark) + ', ' + E.fmtYards(x.dM) + ' downwind of your path.')));
    if (r.hits.length > 4) box.appendChild(h('p', { class: 'why bad' }, 'And ' + (r.hits.length - 4) + ' more marks.'));
    if (r.noTerrain) box.appendChild(h('p', { class: 'fine tight' }, 'Ground slope along the route did not load, so thermals are left out.'));
    return box;
  }
  function routeBlock(s) {
    const r = s.routes || {};
    const box = h('div', { class: 'block' }, h('h3', null, 'Walk in and out'));
    if (!r.in) {
      box.appendChild(h('p', { class: 'line dim' }, 'Draw the way you walk in, from your truck to this stand. StandCast runs the wind and thermals along it at walking pace for the hunt you picked, and warns you if your scent drifts over bedding, trails or other sign you have marked.'));
      box.appendChild(h('button', { class: 'btn small', type: 'button', onclick: () => startRoute(s, 'in') }, icon('plus', 15), 'Draw my walk in'));
      return box;
    }
    box.appendChild(routeSummary(s, 'in'));
    box.appendChild(routeSummary(s, 'out'));
    box.appendChild(h('div', { class: 'row-wrap' },
      h('button', { class: 'btn small', type: 'button', onclick: () => showRoute(s) }, icon('locate', 15), 'Show on map'),
      h('button', { class: 'btn small', type: 'button', onclick: () => startRoute(s, 'in') }, 'Redraw walk in'),
      h('button', { class: 'btn small', type: 'button', onclick: () => startRoute(s, 'out') }, r.out ? 'Redraw way out' : 'Different way out'),
      r.out ? h('button', { class: 'btn small', type: 'button', onclick: () => { S.updateStand(s.id, { routes: { in: r.in, out: null } }); renderAll(); } }, 'Same way out') : null,
      confirmTwice('Delete routes', () => { S.updateStand(s.id, { routes: null }); renderAll(); })));
    box.appendChild(h('p', { class: 'fine tight' }, 'Walking pace about 2 mph. Red ticks on the map show where your scent drifts over sign; wind and thermals are estimates.'));
    return box;
  }
  // The selected stand's walk in and out for the map, with scent ticks (none while a route is being drawn).
  function mapRoutes() {
    const s = ui.view === 'stand' && S.getStand(ui.selStand);
    if (!s || !s.routes || (ui.measure && ui.measure.route)) return [];
    const r = s.routes, out = [];
    ['in', 'out'].forEach((w) => {
      if (w === 'out' && !r.out) return;
      const line = routeLine(s, w); if (!line) return;
      const c = routeCheck(s, w);
      out.push({ which: w, line: line, samples: c.samples || [] });
    });
    // same way out: show the way-out scent too, on the walk-in line
    if (r.in && !r.out && out[0]) { const c = routeCheck(s, 'out'); if (c.samples) out[0].samplesOut = c.samples; }
    return out;
  }
  function showRoute(s) {
    const line = (routeLine(s, 'in') || []).concat(routeLine(s, 'out') || []);
    if (isMobile()) setSheet('peek');
    M.fitPoints(line.map((p) => ({ lat: p[0], lng: p[1] })));
  }
  // Drawing a route reuses the measuring tool: tap from the truck to the stand, then Save.
  function startRoute(s, which) {
    startMeasure();
    ui.measure.route = { standId: s.id, which: which };
    const old = routeLine(s, which);
    if (old && (which === 'in' || (s.routes || {}).out)) ui.measure.pts = old.map((p) => ({ lat: p[0], lng: p[1] }));
    drawMeasure(); renderMap();
    if (old) showRoute(s);
  }
  function saveRoute() {
    const m = ui.measure, rt = m.route, s = S.getStand(rt.standId);
    if (!s) return endMeasure();
    const line = m.pts.map((p) => [p.lat, p.lng]);
    // the walk ends at the stand: add it if the last tap was not on it
    const last = line[line.length - 1];
    if (!last || E.distanceM(last[0], last[1], s.lat, s.lng) > 12) line.push([s.lat, s.lng]);
    if (line.length < 2) { toast('Tap at least one point between your truck and the stand.'); return; }
    const r = Object.assign({ in: null, out: null }, s.routes);
    r[rt.which] = line;
    S.updateStand(s.id, { routes: r });
    endMeasure();
    selectStand(s.id);
    if (isMobile()) setSheet('half');
    toast(rt.which === 'in' ? 'Walk in saved. Checking the wind along it…' : 'Way out saved.');
  }
  function standView() {
    const s = S.getStand(ui.selStand);
    if (!s) { ui.view = 'list'; return listView(); }
    const ev = data.evals[s.id], fc = data.fc[s.id], sit = currentSit();
    const root = h('div', { class: 'view' });
    root.appendChild(backHeader('Stand', () => go('list')));
    if (ui.draft) root.appendChild(draftBar());
    root.appendChild(h('div', { class: 'stand-head' },
      h('input', {
        class: 'name-input', id: 'stand-name', type: 'text', value: s.name, maxlength: 40, 'aria-label': 'Stand name',
        oninput: (e) => { S.updateStand(s.id, { name: e.target.value }); renderMap(); }
      }),
      ev ? h('div', { class: 'big-score ' + ev.label.cls }, h('b', null, String(ev.score)), h('span', null, ev.label.text)) : null));
    if (ev && sit) root.appendChild(h('p', { class: 'sub' }, sit.label + '  ·  ' + E.fmtClock(sit.start) + ' to ' + E.fmtClock(sit.end) + (data.ranks[0] === s.id ? '  ·  your best bet' : '')));
    if (s.example) root.appendChild(h('p', { class: 'note' }, 'This is an example stand. Drag its pin, rename it or delete it.'));

    if (fc) {
      root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Next 36 hours here'), timeline(s, fc)));
    } else {
      root.appendChild(h('div', { class: 'note warn' }, h('p', null, data.loading ? 'Loading the forecast…' : 'No forecast for this stand yet.'),
        data.loading ? null : h('button', { class: 'btn', type: 'button', onclick: () => refresh(true) }, icon('refresh', 16), 'Try again')));
    }
    if (ev) {
      root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Why this score'),
        h('div', { class: 'meters' }, meter('Wind fit', ev.parts.wind), meter('Steady', ev.parts.steady), meter('Wind speed', ev.parts.speed), meter('Conditions', ev.parts.conditions), meter('Swirl-free', 1 - (ev.parts.swirl || 0))),
        ev.reasons.map((r) => h('p', { class: 'why block-why ' + r.kind }, r.text))));
    }
    root.appendChild(h('div', { class: 'block' },
      h('h3', null, 'Winds that work here'),
      h('p', { class: 'fine tight' }, 'Wind direction is where the wind blows from. Tap a direction to cycle good, bad and does not matter.'),
      windGrid(s),
      h('div', { class: 'legend-row' }, h('span', { class: 'lg good' }, 'Good here'), h('span', { class: 'lg bad' }, 'Bad here'), h('span', { class: 'lg none' }, 'Does not matter'))));
    root.appendChild(terrainPanel(s));
    if (!s.example) root.appendChild(routeBlock(s));
    root.appendChild(h('div', { class: 'block' },
      h('h3', null, 'Stand details'),
      h('label', { class: 'field', for: 'stand-type' }, h('span', null, 'Type'),
        h('select', { id: 'stand-type', value: s.type, onchange: (e) => S.updateStand(s.id, { type: e.target.value }) },
          [['tree', 'Tree stand'], ['saddle', 'Saddle'], ['blind', 'Ground blind'], ['other', 'Other']].map((o) => h('option', { value: o[0] }, o[1])))),
      h('label', { class: 'field', for: 'stand-notes' }, h('span', null, 'Notes'),
        h('textarea', { id: 'stand-notes', rows: 4, maxlength: 1500, placeholder: 'Entry and exit route, scent control, where deer come from.', oninput: (e) => S.updateStand(s.id, { notes: e.target.value }) }, s.notes || ''))));
    root.appendChild(sitLog(s));
    root.appendChild(h('div', { class: 'block actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => M.flyTo(s.lat, s.lng, 17, isMobile() ? $('sheet').offsetHeight : 0) }, icon('locate', 16), 'Show on map'),
      h('p', { class: 'fine tight wide-row' }, 'Drag the pin on the map to move this stand.'),
      confirmTwice('Delete stand', () => { S.removeStand(s.id); toast('Stand deleted'); ui.selStand = null; recompute(); go('list'); refresh(); })));
    return root;
  }

  // The spot's coordinates with a button to copy them, for sharing a location or looking it up elsewhere.
  function coordsRow(lat, lng) {
    const text = lat.toFixed(5) + ', ' + lng.toFixed(5);
    const copy = () => {
      const done = () => toast('Location copied: ' + text);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast(text));
      else toast(text);
    };
    return h('div', { class: 'coords' }, h('span', null, text), h('button', { class: 'btn small', type: 'button', onclick: copy }, 'Copy location'));
  }

  /* ---- marks ---- */
  function photoBlock(m) {
    const wrap = h('div', { class: 'photo-block' });
    if (m.photoId) {
      const img = h('img', { class: 'photo', alt: (MT.TYPES[m.type] || MT.TYPES.other).label + ' photo', loading: 'lazy' });
      S.photoUrl(m.photoId).then((u) => { if (u) img.src = u; else wrap.replaceChildren(h('p', { class: 'note warn' }, 'The photo could not be loaded.')); });
      wrap.appendChild(img);
      wrap.appendChild(h('div', { class: 'row2' },
        h('button', { class: 'btn small', type: 'button', onclick: () => pickPhoto((f) => attachPhoto(m.id, f)) }, icon('photo', 15), 'Replace photo'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { const id = m.photoId; S.updateMark(m.id, { photoId: null }); S.deletePhoto(id); renderAll(); } }, 'Remove photo')));
    } else {
      wrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => pickPhoto((f) => attachPhoto(m.id, f)) }, icon('photo', 16), 'Add a photo'));
    }
    return wrap;
  }
  function markView() {
    const m = S.getMark(ui.selMark);
    if (!m) { ui.view = 'list'; return marksView(); }
    const t = MT.TYPES[m.type] || MT.TYPES.other;
    const root = h('div', { class: 'view' });
    root.appendChild(backHeader(t.label, () => { go('list'); }));
    if (ui.draft) root.appendChild(draftBar());
    root.appendChild(h('div', { class: 'stand-head' },
      h('input', {
        class: 'name-input', id: 'mark-name', type: 'text', value: m.name || '', maxlength: 40, placeholder: 'Name it (optional)', 'aria-label': 'Name of this mark',
        oninput: (e) => { S.updateMark(m.id, { name: e.target.value.trim() ? e.target.value : '' }); renderMap(); }
      })));
    root.appendChild(h('div', { class: 'type-grid', role: 'radiogroup', 'aria-label': 'Kind of sign' }, MT.ORDER.map((k) => {
      const b = h('button', { class: 'type-btn' + (k === m.type ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': k === m.type ? 'true' : 'false', onclick: () => { S.updateMark(m.id, { type: k }); renderAll(); } },
        h('span', { class: 'type-dot', style: 'background:' + MT.TYPES[k].color }, MT.icon(k, 16)), MT.TYPES[k].label);
      return b;
    })));
    root.appendChild(h('label', { class: 'field', for: 'mark-note' }, h('span', null, 'Note'),
      h('textarea', { id: 'mark-note', rows: 4, maxlength: 1500, placeholder: 'Fresh or old, size, direction it faces, what you noticed.', oninput: (e) => S.updateMark(m.id, { note: e.target.value }) }, m.note || '')));
    root.appendChild(photoBlock(m));
    if (m.type === 'camera' || (m.shots || []).length) root.appendChild(cameraBlock(m));
    root.appendChild(h('p', { class: 'fine' }, 'Added ' + new Date(m.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + '. Drag the pin on the map to move it.'));
    root.appendChild(coordsRow(m.lat, m.lng));
    root.appendChild(h('div', { class: 'block actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => M.flyTo(m.lat, m.lng, 18, isMobile() ? $('sheet').offsetHeight : 0) }, icon('locate', 16), 'Show on map'),
      confirmTwice('Delete mark', () => { S.removeMark(m.id); toast('Mark deleted'); go('list', { tab: 'marks' }); })));
    return root;
  }
  function marksView() {
    const root = h('div', { class: 'view' });
    const all = S.state.marks;
    root.appendChild(h('div', { class: 'view-head' }, h('h2', null, 'Marks and photos'), h('p', { class: 'sub' }, all.length ? all.length + ' on the map' : 'Scrapes, rubs, bedding, food and trails')));
    if (!all.length) {
      root.appendChild(h('div', { class: 'empty small' }, h('p', null, 'Drop a pin where you find sign, add a note and a photo, and it stays on your map. Photos with location data place their own pin.'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => go('add') }, icon('plus', 16), 'Add a mark'),
          h('button', { class: 'btn', type: 'button', onclick: () => go('photo') }, icon('photo', 16), 'Add a photo'),
          h('button', { class: 'btn', type: 'button', onclick: pickPins }, 'Import pins from onX, HuntStand or Garmin'))));
      return root;
    }
    const note = backupNote(); if (note) root.appendChild(note);
    root.appendChild(h('button', { class: 'btn wide-btn', type: 'button', onclick: () => go('photo') }, icon('photo', 16), 'Add a photo'));
    root.appendChild(pinsRow());
    const counts = {}; all.forEach((m) => { counts[m.type] = (counts[m.type] || 0) + 1; });
    root.appendChild(h('div', { class: 'chips' },
      [['all', 'All ' + all.length]].concat(MT.ORDER.filter((k) => counts[k]).map((k) => [k, MT.TYPES[k].label + ' ' + counts[k]]))
        .map((p) => h('button', { class: 'chip-btn' + (ui.markFilter === p[0] ? ' on' : ''), type: 'button', onclick: () => { ui.markFilter = p[0]; renderSheet(); } }, p[1]))));
    all.filter((m) => ui.markFilter === 'all' || m.type === ui.markFilter).slice().reverse().forEach((m) => {
      const t = MT.TYPES[m.type] || MT.TYPES.other, thumb = h('span', { class: 'thumb' });
      if (m.photoId) S.photoUrl(m.photoId).then((u) => { if (u) { thumb.style.backgroundImage = 'url("' + u + '")'; thumb.classList.add('has'); } });
      root.appendChild(h('button', { class: 'row-card', type: 'button', onclick: () => selectMark(m.id) },
        h('span', { class: 'type-dot', style: 'background:' + t.color }, MT.icon(m.type, 16)),
        h('span', { class: 'row-main' }, h('b', null, m.name || t.label), h('span', { class: 'row-note' }, (m.name ? t.label + (m.note ? '  ·  ' : '') : '') + (m.note ? m.note : (m.name ? '' : 'No note')))), thumb));
    });
    return root;
  }

  /* ---- add flow ---- */
  function addView() {
    const root = h('div', { class: 'view' }), held = ui.pending;
    // held = you pressed and held a spot, so whatever you pick goes straight there
    const pick = (k) => { if (held) placePending(k); else startPlacing(k); };
    root.appendChild(backHeader(held ? 'Add at this spot' : 'Add to the map', () => go('list')));
    if (held) root.appendChild(h('div', { class: 'note draft-bar' },
      h('p', null, 'Pick what goes at the spot you held. Tap the map to cancel.'),
      h('button', { class: 'btn small', type: 'button', onclick: () => go('list') }, 'Cancel')));
    root.appendChild(h('div', { class: 'tiles' },
      h('button', { class: 'tile', type: 'button', onclick: () => pick('stand') }, h('span', { class: 'type-dot stand-dot' }, icon('stands', 18)), 'Stand'),
      MT.ORDER.map((k) => h('button', { class: 'tile', type: 'button', onclick: () => pick(k) },
        h('span', { class: 'type-dot', style: 'background:' + MT.TYPES[k].color }, MT.icon(k, 18)), MT.TYPES[k].label))));
    if (held) return root;
    root.appendChild(h('button', { class: 'btn wide-btn', type: 'button', onclick: () => go('photo') }, icon('photo', 16), 'Add a photo'));
    root.appendChild(h('button', { class: 'btn wide-btn', type: 'button', onclick: findSites }, icon('search', 16), 'Find stand sites in view'));
    root.appendChild(h('p', { class: 'fine' }, 'Take a photo at the sign and the pin drops where you are standing. You can also press and hold any spot on the map to add something there.'));
    return root;
  }
  /* ---- press and hold the map: choose what goes at that spot ---- */
  function clearPending() { if (ui.pending) { ui.pending = null; M.setPending(null); } }
  function holdAt(lat, lng) {
    if (ui.measure) return;
    if (ui.placing) return placeAt(lat, lng);
    ui.pending = { lat: lat, lng: lng, at: Date.now() };
    M.setPending(ui.pending);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* not allowed, no matter */ } }
    $('landcard').hidden = true;
    if (isMobile() && ui.sheet !== 'half') setSheet('half');
    go('add');
    // keep the held spot in view above the panel
    if (isMobile()) M.flyTo(lat, lng, M.zoom, $('sheet').offsetHeight);
  }
  function placePending(kind) {
    const p = ui.pending; if (!p) return;
    clearPending();
    ui.placing = { kind: kind, file: null };
    placeAt(p.lat, p.lng);
    // not saved yet: Save keeps it, a tap on the map takes it back off
    ui.draft = kind === 'stand' ? { kind: 'stand', id: ui.selStand } : { kind: 'mark', id: ui.selMark };
    renderSheet();
  }
  function draftItem() {
    const d = ui.draft; if (!d) return null;
    return d.kind === 'stand' ? S.getStand(d.id) : S.getMark(d.id);
  }
  // true once you have put work into it, so a stray tap on the map cannot throw that away
  function draftTouched() {
    const d = ui.draft, it = draftItem(); if (!it) return false;
    return d.kind === 'stand' ? !!(it.notes || E.isConfigured(it.winds) || (it.sits || []).length) : !!(it.name || it.note || it.photoId);
  }
  function saveDraft() {
    const d = ui.draft; if (!d) return;
    ui.draft = null;
    if (d.kind === 'stand') { toast('Stand saved. Mark its good and bad winds.'); renderSheet(); return; }
    toast('Mark saved');
    if (isMobile()) setSheet('peek');
    go('list');
  }
  function discardDraft() {
    const d = ui.draft; if (!d) return;
    ui.draft = null;
    if (d.kind === 'stand') { S.removeStand(d.id); recompute(); } else S.removeMark(d.id);
    toast(d.kind === 'stand' ? 'Stand removed' : 'Mark removed');
    go('list');
  }
  function draftBar() {
    return h('div', { class: 'note draft-bar' },
      h('p', null, h('b', null, 'Not saved yet. '), 'Tap Save to keep it. Tap the map to remove it.'),
      h('div', { class: 'row2' },
        h('button', { class: 'btn primary', type: 'button', onclick: saveDraft }, 'Save'),
        h('button', { class: 'btn', type: 'button', onclick: discardDraft }, 'Remove')));
  }
  // A plain tap on the map backs out of a press-and-hold: clears the target, or removes the unsaved pin.
  function tapCancels() {
    if (ui.pending) {
      if (Date.now() - ui.pending.at < 600) return true;   // the finger lifting off after the hold is not a tap
      clearPending(); go('list'); return true;
    }
    if (ui.draft) {
      if (draftTouched()) toast('This one has details now. Tap Save to keep it, or Remove to delete it.');
      else discardDraft();
      return true;
    }
    return false;
  }
  function placingView() {
    const k = ui.placing ? ui.placing.kind : 'stand';
    const label = k === 'stand' ? 'stand' : (MT.TYPES[k] || MT.TYPES.other).label.toLowerCase();
    return h('div', { class: 'view' }, h('div', { class: 'view-head' }, h('h2', null, 'Place the ' + label), h('p', { class: 'sub' }, 'Tap the map where it goes.')));
  }
  /* ---- measure: tap points on the map for yardage between them ---- */
  function measureLegs() {
    const p = ui.measure.pts, legs = []; let total = 0;
    for (let i = 1; i < p.length; i++) { const d = E.distanceM(p[i - 1].lat, p[i - 1].lng, p[i].lat, p[i].lng); legs.push(d); total += d; }
    return { legs: legs, total: total };
  }
  function drawMeasure() {
    if (!ui.measure) { M.renderMeasure(null); $('measurebar').hidden = true; return; }
    const r = measureLegs(), n = ui.measure.pts.length;
    M.renderMeasure({ pts: ui.measure.pts, legs: r.legs.map(E.fmtYards) }, {
      onDrag: (i, lat, lng, live) => {
        ui.measure.pts[i] = { lat: lat, lng: lng };
        if (live) paintMeasureBar(); else drawMeasure();
      }
    });
    paintMeasureBar(r, n);
  }
  function paintMeasureBar(r, n) {
    r = r || measureLegs(); n = n == null ? ui.measure.pts.length : n;
    const bar = $('measurebar');
    bar.hidden = false;
    bar.querySelector('.mb-total').textContent = n < 2 ? '0 yd' : E.fmtYards(r.total);
    const rt = ui.measure.route;
    bar.classList.toggle('is-route', !!rt);
    bar.querySelector('[data-m=done]').textContent = rt ? 'Save route' : 'Done';
    bar.querySelector('[data-m=cancel]').hidden = !rt;
    bar.querySelector('[data-m=me]').textContent = rt ? 'Start at me' : 'From me';
    if (rt) {
      bar.querySelector('.mb-sub').textContent = (n === 0 ? (rt.which === 'in' ? 'Walk in: tap where you park, then each turn on the way to the stand.' : 'Way out: tap from where you park, along the way you walk, to the stand.')
        : 'Keep tapping along your walk. The stand is added at the end for you.') + ' Drag a point to adjust.';
      return;
    }
    bar.querySelector('.mb-sub').textContent = n === 0 ? 'Tap the map to drop the first point. Tap a stand or mark to snap to it.'
      : n === 1 ? 'Tap the next point.'
      : (n - 1) + (n === 2 ? ' leg' : ' legs') + (n > 2 ? '  ·  last leg ' + E.fmtYards(r.legs[r.legs.length - 1]) : '') + '  ·  drag a point to adjust';
    bar.querySelector('[data-m=undo]').disabled = n === 0;
    bar.querySelector('[data-m=clear]').disabled = n === 0;
  }
  function addMeasurePoint(lat, lng) { ui.measure.pts.push({ lat: lat, lng: lng }); drawMeasure(); }
  function startMeasure() {
    if (ui.placing) cancelPlacing();
    $('landcard').hidden = true;
    ui.measure = { pts: [] };
    $('btn-measure').classList.add('on');
    if (isMobile() && ui.sheet !== 'peek') setSheet('peek');
    drawMeasure();
  }
  function endMeasure() {
    const wasRoute = ui.measure && ui.measure.route;
    ui.measure = null; $('btn-measure').classList.remove('on');
    drawMeasure();
    if (wasRoute) renderMap();
  }
  function measureFromMe() {
    wantLocation = true;
    M.locate().then((p) => { ui.measure.pts.unshift({ lat: p.lat, lng: p.lng }); drawMeasure(); }).catch((e) => toast(e.message));
  }

  function startPlacing(kind, file, why) {
    if (ui.measure) endMeasure();
    ui.placing = { kind: kind, file: file || null }; ui.view = 'placing'; ui.selStand = null; ui.selMark = null;
    if (isMobile()) setSheet('peek');
    M.setPlacing(true);
    $('banner-text').textContent = why ? why : file ? 'Tap the map where you took the photo.'
      : 'Tap the map to place your ' + (kind === 'stand' ? 'stand' : (MT.TYPES[kind] || MT.TYPES.other).label.toLowerCase()) + '.';
    $('banner').hidden = false;
    renderAll();
  }
  function endPlacing() {
    ui.placing = null; M.setPlacing(false); $('banner').hidden = true;
  }
  function cancelPlacing() { endPlacing(); if (isMobile()) setSheet('half'); go('list'); }
  function placeAt(lat, lng) {
    const p = ui.placing; if (!p) return;
    endPlacing();
    if (isMobile()) setSheet('half');
    if (p.kind === 'stand') {
      const s = S.addStand({ lat: lat, lng: lng });
      selectStand(s.id, false);
      toast('Stand placed. Rename it and mark its good winds.');
      refresh();
    } else {
      const m = S.addMark({ type: p.kind, lat: lat, lng: lng });
      selectMark(m.id, false);
      if (p.file) attachPhoto(m.id, p.file);
    }
  }
  function useMyLocation() {
    wantLocation = true;
    M.locate().then((p) => { if (ui.placing) placeAt(p.lat, p.lng); else { M.flyTo(p.lat, p.lng, 16, 0); } }).catch((e) => toast(e.message));
  }

  /* ---- photos ---- */
  let photoCb = null;
  // camera = true opens the phone's camera directly; otherwise the phone offers its photo library
  function pickPhoto(cb, camera) { photoCb = cb; const f = $(camera ? 'file-camera' : 'file-photo'); f.value = ''; f.click(); }
  function resizeToBlob(file, max, q) {
    function draw(src, w, hgt) {
      const sc = Math.min(1, max / Math.max(w, hgt)), cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(hgt * sc));
      cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
      return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Could not process that photo.'))), 'image/jpeg', q));
    }
    const viaBitmap = window.createImageBitmap ? createImageBitmap(file).then((b) => draw(b, b.width, b.height)) : Promise.reject(new Error('no bitmap'));
    return viaBitmap.catch(() => new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(draw(img, img.naturalWidth, img.naturalHeight)); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That photo could not be read.')); };
      img.src = url;
    }));
  }
  function attachPhoto(markId, file) {
    return resizeToBlob(file, 1280, 0.82).then(S.putPhoto).then((id) => {
      const m = S.getMark(markId); if (!m) return;
      const old = m.photoId; S.updateMark(markId, { photoId: id });
      if (old) S.deletePhoto(old);
      renderAll();
    }).catch((e) => toast(e.message || 'Could not add that photo.'));
  }
  // { gps, why }: the location saved in the photo, or the reason there is none
  function photoInfo(file) {
    return (file.arrayBuffer ? file.arrayBuffer() : Promise.resolve(null)).catch(() => null).then((buf) => (buf ? SC.exif.inspect(buf) : { gps: null, why: 'no-exif' }));
  }
  function photoGps(file) { return photoInfo(file).then((r) => r.gps); }
  // Plain words for why a photo from the library could not place its own pin.
  function noLocationReason(why) {
    const android = /Android/i.test(navigator.userAgent);
    if (why === 'not-jpeg') return 'This kind of picture (a screenshot or a non-JPEG photo) has no location the app can read.';
    if (why === 'no-exif') return 'This photo has had its camera details removed, which happens to copies sent by text or saved from an app.';
    if (android) return 'No location came through with this photo. Android hides photo locations from web apps, so library photos cannot place themselves on this phone.';
    if (why === 'blanked') return 'The location in this photo was left blank by the phone.';
    return 'This photo was saved without a location. Check that location is turned on for your camera.';
  }
  function dropPhotoPin(file, lat, lng, msg) {
    ui.placing = { kind: 'other', file: file };
    placeAt(lat, lng);
    M.flyTo(lat, lng, 17, isMobile() ? $('sheet').offsetHeight : 0);
    toast(msg);
  }
  // msg stays on the banner until the pin is placed, so there is time to read why
  function placePhotoByHand(file, msg) { startPlacing('other', file, msg + ' Tap the map where you took it.'); }
  // A photo from the library: use the location saved in it, if it has one.
  function placeFromPhoto(file) {
    photoInfo(file).then((r) => {
      if (r.gps) dropPhotoPin(file, r.gps.lat, r.gps.lng, 'Placed from the photo’s location. Pick the kind of sign.');
      else placePhotoByHand(file, noLocationReason(r.why));
    });
  }
  // A photo taken just now: phones leave the location out of these, so use where the phone is standing.
  function placeFromCamera(file) {
    photoGps(file).then((gps) => {
      if (gps) return dropPhotoPin(file, gps.lat, gps.lng, 'Placed where you took the photo. Pick the kind of sign.');
      wantLocation = true;
      toast('Finding where you are standing…');
      M.locate().then((p) => dropPhotoPin(file, p.lat, p.lng, 'Placed where you are standing' + (p.accuracy > 30 ? ' (within about ' + Math.round(E.yards(p.accuracy)) + ' yd)' : '') + '. Drag the pin if it is off, then pick the kind of sign.'))
        .catch((e) => placePhotoByHand(file, (e && e.message) || 'Could not get your location.'));
    });
  }
  /* ---- add a photo: take one here, or pick one already on the phone ---- */
  function photoAddView() {
    const root = h('div', { class: 'view' });
    root.appendChild(backHeader('Add a photo', () => go('list')));
    root.appendChild(h('div', { class: 'stack' },
      h('button', { class: 'btn primary big-btn', type: 'button', onclick: () => pickPhoto(placeFromCamera, true) }, icon('photo', 20), 'Take a photo here'),
      h('p', { class: 'fine' }, 'Opens your camera. The pin drops where you are standing, so take it at the sign.'),
      h('button', { class: 'btn big-btn', type: 'button', onclick: () => pickPhoto(placeFromPhoto) }, icon('photos', 20), 'Choose from my photos'),
      h('p', { class: 'fine' }, 'For photos you took earlier. If the photo has its location saved, the pin drops there. If not, you tap the spot on the map.')));
    return root;
  }
  /* ---- photo library: every photo on the map in one place ---- */
  function photoMarks() { return S.state.marks.filter((m) => m.photoId).slice().reverse(); }
  function photosView() {
    const root = h('div', { class: 'view' }), list = photoMarks();
    root.appendChild(h('div', { class: 'view-head' }, h('h2', null, 'Photos'), h('p', { class: 'sub' }, list.length ? list.length + (list.length === 1 ? ' photo' : ' photos') + ' on the map' : 'Your sign photos, all in one place')));
    root.appendChild(h('button', { class: 'btn wide-btn', type: 'button', onclick: () => go('photo') }, icon('photo', 16), 'Add a photo'));
    const cams = S.state.marks.filter((m) => m.type === 'camera');
    if (cams.length) {
      root.appendChild(h('h3', { class: 'sec-head' }, 'Trail cameras'));
      cams.forEach((m) => {
        const n = (m.shots || []).length, last = n ? Math.max.apply(null, m.shots.map((x) => x.at)) : 0;
        root.appendChild(h('button', { class: 'row-card', type: 'button', onclick: () => selectMark(m.id) },
          h('span', { class: 'type-dot', style: 'background:' + MT.TYPES.camera.color }, MT.icon('camera', 16)),
          h('span', { class: 'row-main' }, h('b', null, m.name || 'Camera'), h('span', { class: 'row-note' }, n ? n + (n === 1 ? ' photo' : ' photos') + ', newest ' + shotTime(last) : 'No card photos yet. Tap to add them.'))));
      });
      if (list.length) root.appendChild(h('h3', { class: 'sec-head' }, 'Sign photos'));
    }
    if (!list.length) {
      root.appendChild(h('div', { class: 'empty small' }, h('p', null, 'No photos yet. Take one at a scrape, rub or trail and it shows up here and as a pin on the map.')));
      return root;
    }
    root.appendChild(h('div', { class: 'gallery' }, list.map((m, i) => {
      const t = MT.TYPES[m.type] || MT.TYPES.other;
      const b = h('button', { class: 'gal-item', type: 'button', 'aria-label': t.label + ' photo', onclick: () => openViewer(i) },
        h('span', { class: 'gal-tag', style: 'background:' + t.color }, MT.icon(m.type, 12)));
      S.photoUrl(m.photoId).then((u) => { if (u) b.style.backgroundImage = 'url("' + u + '")'; });
      return b;
    })));
    return root;
  }
  /* Full-screen viewer. It pages through a list of items { pid, title, note, button: { label, icon, run } },
   * either the photo library (default) or one trail camera's photos. */
  let viewerAt = -1, viewerList = null;
  function libraryItems() {
    return photoMarks().map((m) => {
      const t = MT.TYPES[m.type] || MT.TYPES.other;
      return { pid: m.photoId, title: (m.name ? m.name + '  ·  ' : '') + t.label + '  ·  ' + new Date(m.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
        note: m.note, button: { label: 'Show on map', icon: 'locate', run: () => { closeViewer(); selectMark(m.id); } } };
    });
  }
  function closeViewer() { viewerAt = -1; viewerList = null; $('viewer').hidden = true; $('viewer').replaceChildren(); }
  function openViewer(i, list) {
    if (list) viewerList = list;
    const items = typeof viewerList === 'function' ? viewerList() : (viewerList || libraryItems()), box = $('viewer');
    if (!items.length) return closeViewer();
    viewerAt = i = (i + items.length) % items.length;
    const it = items[i];
    const img = h('img', { class: 'viewer-img', alt: it.title || 'Photo' });
    S.photoUrl(it.pid).then((u) => { if (u && viewerAt === i) img.src = u; });
    const many = items.length > 1;
    box.replaceChildren(
      h('div', { class: 'viewer-top' },
        h('span', null, many ? (i + 1) + ' of ' + items.length : ''),
        h('button', { class: 'viewer-btn', type: 'button', 'aria-label': 'Close', onclick: closeViewer }, icon('close', 22))),
      h('div', { class: 'viewer-stage' },
        many ? h('button', { class: 'viewer-btn viewer-prev', type: 'button', 'aria-label': 'Previous photo', onclick: () => openViewer(i - 1) }, icon('back', 22)) : null,
        img,
        many ? h('button', { class: 'viewer-btn viewer-next', type: 'button', 'aria-label': 'Next photo', onclick: () => openViewer(i + 1) }, icon('back', 22)) : null),
      h('div', { class: 'viewer-foot' },
        h('div', { class: 'viewer-cap' }, h('b', null, it.title), it.note ? h('span', null, it.note) : null),
        it.button ? h('button', { class: 'btn small', type: 'button', onclick: (e) => it.button.run(e) }, it.button.icon ? icon(it.button.icon, 15) : null, it.button.label) : null));
    box.hidden = false;
  }
  function viewerCount() { const v = typeof viewerList === 'function' ? viewerList() : (viewerList || libraryItems()); return v.length; }

  /* ---- trail camera photos: a camera pin keeps every card pull, sorted by the camera's date stamp ----
   * m.shots = [{ id (photo store), at (ms, the camera's local clock read as this phone's time), added }] */
  function shotTime(at) {
    const d = new Date(at);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function shotItems(markId) {
    return () => {
      const m = S.getMark(markId); if (!m) return [];
      return (m.shots || []).slice().sort((a, b) => b.at - a.at).map((x) => ({
        pid: x.id, title: (m.name || 'Camera') + '  ·  ' + shotTime(x.at), note: null,
        button: { label: 'Delete photo', icon: 'close', run: (e) => {
          const btn = e.currentTarget;   // first tap asks, second tap deletes
          if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.classList.add('danger', 'armed'); btn.textContent = 'Tap again to delete'; return; }
          const mm = S.getMark(markId); if (!mm) return;
          S.updateMark(markId, { shots: (mm.shots || []).filter((y) => y !== x) }); S.deletePhoto(x.id);
          toast('Photo deleted'); renderSheet();
          if (viewerCount()) openViewer(viewerAt); else closeViewer();
        } }
      }));
    };
  }
  function addShots(markId, files) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    toast('Adding ' + list.length + (list.length === 1 ? ' photo…' : ' photos…'));
    let bad = 0;
    // one at a time, so a big card pull does not run the phone out of memory
    const step = (k, got) => {
      if (k >= list.length) return Promise.resolve(got);
      const f = list[k];
      return f.arrayBuffer().then((buf) => {
        const stamp = SC.exif.readDate(buf), at = stamp ? new Date(stamp).getTime() : (f.lastModified || Date.now());
        return resizeToBlob(f, 1280, 0.8).then(S.putPhoto).then((id) => { got.push({ id: id, at: at, added: Date.now() }); });
      }).catch(() => { bad++; }).then(() => step(k + 1, got));
    };
    step(0, []).then((got) => {
      const m = S.getMark(markId);
      if (!m) { got.forEach((x) => S.deletePhoto(x.id)); return; }
      S.updateMark(markId, { shots: (m.shots || []).concat(got) });
      toast('Added ' + got.length + (got.length === 1 ? ' photo' : ' photos') + (bad ? '. ' + bad + ' could not be read.' : '.'));
      renderAll();
    });
  }
  function cameraBlock(m) {
    const shots = (m.shots || []).slice().sort((a, b) => b.at - a.at), box = h('div', { class: 'block' }, h('h3', null, 'Camera photos'));
    if (!shots.length) box.appendChild(h('p', { class: 'line dim' }, 'Pull the card, then add its photos here. They sort by the date and time the camera stamped on them, so you can see when deer move past this camera.'));
    else {
      const first = shots[shots.length - 1].at, last = shots[0].at;
      const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
      box.appendChild(h('p', { class: 'line' }, h('b', null, shots.length + (shots.length === 1 ? ' photo' : ' photos')), '  ·  ' + (day(first) === day(last) ? day(first) : day(first) + ' to ' + day(last))));
      // when the camera fires, by time of day (the camera's own clock)
      const when = { Dawn: 0, Day: 0, Dusk: 0, Night: 0 };
      shots.forEach((x) => { const hr = new Date(x.at).getHours(); when[hr >= 5 && hr < 8 ? 'Dawn' : hr >= 8 && hr < 16 ? 'Day' : hr >= 16 && hr < 20 ? 'Dusk' : 'Night']++; });
      box.appendChild(h('p', { class: 'line dim' }, Object.keys(when).map((k) => k + ' ' + when[k]).join('  ·  ')));
      const limit = ui.shotsAll === m.id ? shots.length : 24;
      box.appendChild(h('div', { class: 'gallery shots' }, shots.slice(0, limit).map((x, i) => {
        const b = h('button', { class: 'gal-item', type: 'button', 'aria-label': 'Camera photo ' + shotTime(x.at), onclick: () => openViewer(i, shotItems(m.id)) },
          h('span', { class: 'gal-when' }, shotTime(x.at)));
        S.photoUrl(x.id).then((u) => { if (u) b.style.backgroundImage = 'url("' + u + '")'; });
        return b;
      })));
      if (shots.length > limit) box.appendChild(h('button', { class: 'btn small', type: 'button', onclick: () => { ui.shotsAll = m.id; renderSheet(); } }, 'Show all ' + shots.length));
    }
    box.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => { shotsFor = m.id; const f = $('file-shots'); f.value = ''; f.click(); } }, icon('photos', 16), 'Add photos from the card'));
    box.appendChild(h('p', { class: 'fine tight' }, 'Photos are made smaller to save space and stay on this phone. They go into your backup file.'));
    return box;
  }
  let shotsFor = null;
  function wireViewer() {
    let x0 = null;
    const box = $('viewer');
    box.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    box.addEventListener('touchend', (e) => {
      if (x0 == null || viewerAt < 0) return;
      const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 60 && viewerCount() > 1) openViewer(viewerAt + (dx < 0 ? 1 : -1));
    });
    document.addEventListener('keydown', (e) => {
      if (viewerAt < 0) return;
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowRight') openViewer(viewerAt + 1);
      else if (e.key === 'ArrowLeft') openViewer(viewerAt - 1);
    });
  }

  /* ---- guide ---- */
  function loadExamples() {
    const c = M.center();
    const spec = [
      { name: 'Oak Flat', dx: 0, dy: 0, winds: { NW: 'good', W: 'good', N: 'good', S: 'bad', SE: 'bad', E: 'bad' } },
      { name: 'Creek Funnel', dx: 300, dy: 120, winds: { S: 'good', SW: 'good', W: 'good', N: 'bad', NE: 'bad' } },
      { name: 'Ridge Saddle', dx: -260, dy: 210, winds: { E: 'good', NE: 'good', N: 'good', SW: 'bad', W: 'bad' } }
    ];
    spec.forEach((p) => {
      const ll = E.offsetLatLng(c.lat, c.lng, E.norm(Math.atan2(p.dx, p.dy) / E.DEG), Math.hypot(p.dx, p.dy));
      S.addStand({ name: p.name, lat: ll[0], lng: ll[1], winds: p.winds, example: true, notes: 'Example stand. Delete it any time.' });
    });
    ui.tab = 'stands'; ui.view = 'list';
    M.flyTo(c.lat + 0.001, c.lng, 15.5, isMobile() ? $('sheet').offsetHeight : 0);
    toast('Added 3 example stands');
    refresh();
  }
  function download(name, blob) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  /* ---- stand-site suggestions for the area in view ----
   * Reads the ground once (zoom-15 lidar squares), finds saddles, funnels and benches, and scores them with the
   * hunter's marked bedding, food and sign and the wind for the hunt picked on the Stands tab (engine.standSites). */
  function findSites() {
    const t = M.zoom >= 15 ? E.demTiles(M.bounds(), 0, 16, 15) : null;
    if (!t) { toast('Zoom in to about a square mile around where you hunt, then try again.'); return; }
    if (ui.measure) endMeasure();
    ui.sites = { busy: true, list: [] }; ui.siteOpen = null;
    if (isMobile() && ui.sheet === 'peek') setSheet('half');
    go('spots');
    const view = M.bounds();
    W.demMosaic(t).then((dem) => {
      if (dem.missing === dem.total) throw new Error('none');
      const b = t.bounds;
      const place = (kind) => (s) => Object.assign({}, s, { kind: kind, lat: b.n - (s.row + 0.5) / dem.rows * (b.n - b.s), lng: b.w + (s.col + 0.5) / dem.cols * (b.e - b.w) });
      const sp = E.findSpots(dem.z, dem.rows, dem.cols, t.cellM), be = E.findBenches(dem.z, dem.rows, dem.cols, t.cellM);
      const inView = (c) => c.lat >= view.s && c.lat <= view.n && c.lng >= view.w && c.lng <= view.e;
      const cands = sp.saddles.map(place('saddle')).concat(sp.funnels.map(place('funnel')),
        be.benches.slice().sort((x, y) => y.areaM2 - x.areaM2).slice(0, 30).map(place('bench'))).filter(inView);
      const c = M.center(), fc = nearestFc(c.lat, c.lng), sit = currentSit();
      const windFrom = fc && sit ? E.sampleForecast(fc, sitMid(sit)).from : null;
      const marks = S.state.marks.filter(inView);
      ui.sites = { list: E.standSites(cands, S.state.marks, { stands: stands(), windFrom: windFrom }), windFrom: windFrom, sit: sit ? sit.label : null,
        hasBed: marks.some((m) => m.type === 'bed'), hasFood: marks.some((m) => ['food', 'plot', 'water', 'feeder'].indexOf(m.type) >= 0) };
      if (ui.view === 'spots') { M.renderSites(ui.sites.list, (i) => focusSite(i)); renderSheet(); }
    }).catch(() => { ui.sites = { error: 'Could not load the ground data. Check your signal and try again.' }; renderSheet(); });
  }
  function focusSite(i) {
    const s = ui.sites && ui.sites.list[i]; if (!s) return;
    ui.siteOpen = i;
    if (ui.view !== 'spots') go('spots'); else renderSheet();
    M.flyTo(s.lat, s.lng, Math.max(M.zoom, 16.5), isMobile() ? $('sheet').offsetHeight : 0);
    const card = document.querySelector('[data-site="' + i + '"]'); if (card) card.scrollIntoView({ block: 'nearest' });
  }
  const SITE_NAME = { saddle: 'Saddle', funnel: 'Funnel', bench: 'Bench', crossing: 'Crossing' };
  function siteView() {
    const st = ui.sites || {}, root = h('div', { class: 'view' });
    root.appendChild(backHeader('Stand sites', () => { ui.sites = null; M.renderSites(null); go('list'); }));
    if (st.busy) { root.appendChild(h('p', { class: 'note' }, 'Reading the ground for saddles, funnels and benches…')); return root; }
    if (st.error) { root.appendChild(h('p', { class: 'note warn' }, st.error)); return root; }
    root.appendChild(h('p', { class: 'sub' }, 'Best spots in view' + (st.sit && st.windFrom != null ? ', for ' + st.sit.toLowerCase() + ' (' + E.compass(st.windFrom) + ' wind)' : '')));
    if (!st.hasBed || !st.hasFood) root.appendChild(h('p', { class: 'note' }, 'Tip: mark ' + (!st.hasBed && !st.hasFood ? 'bedding and food' : !st.hasBed ? 'bedding' : 'food') +
      ' in this area and the picks get much better: StandCast looks for spots between them and tells you which winds keep your scent off both.'));
    if (!st.list.length) { root.appendChild(h('p', { class: 'line dim' }, 'No saddles, funnels or benches found in view. Try a hillier area, or zoom out a little.')); return root; }
    st.list.forEach((s, i) => {
      const orList = (a) => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1];
      const winds = s.goodWinds ? (s.goodWinds.length ? 'Hunt it on ' + (s.goodWinds[0] === 'E' ? 'an ' : 'a ') + orList(s.goodWinds) + ' wind.' : 'No wind keeps scent off both bedding and food here; hunt it on a wind that protects the bedding.') : 'Mark bedding or food nearby for wind advice.';
      root.appendChild(h('div', { class: 'site-card' + (ui.siteOpen === i ? ' on' : ''), 'data-site': i },
        h('div', { class: 'site-head' }, h('span', { class: 'site-pin' }, String(i + 1)),
          h('b', null, SITE_NAME[s.kind] || 'Spot'), h('span', { class: 'site-score ' + (s.score >= 0.6 ? 'good' : s.score >= 0.4 ? 'ok' : 'none') }, s.score >= 0.6 ? 'Strong' : s.score >= 0.4 ? 'Worth a look' : 'Long shot')),
        s.why.map((w) => h('p', { class: 'line' }, w)),
        h('p', { class: 'why ' + (s.windOk === false ? 'bad' : s.windOk ? 'good' : 'info') }, winds + (s.windOk === true ? ' The ' + E.compass(st.windFrom) + ' wind fits.' : s.windOk === false ? ' The ' + E.compass(st.windFrom) + ' wind does not.' : '')),
        h('div', { class: 'row2' },
          h('button', { class: 'btn small', type: 'button', onclick: () => focusSite(i) }, icon('locate', 15), 'Show'),
          h('button', { class: 'btn small primary', type: 'button', onclick: () => {
            M.renderSites(null); ui.sites = null;
            ui.pending = { lat: s.lat, lng: s.lng, at: 0 }; placePending('stand');
          } }, icon('plus', 15), 'Put a stand here'))));
    });
    root.appendChild(h('p', { class: 'fine' }, 'Picked from the shape of the ground and your own marks. It cannot see cover, fences, property lines or where deer really walk, so scout it before you hang a stand.'));
    return root;
  }
  /* ---- pins to and from other map apps (GPX, KML, KMZ) ---- */
  function pickPins() { const f = $('file-pins'); f.value = ''; f.click(); }
  function readPins(file) {
    const zipped = /\.kmz$/i.test(file.name);
    const text = zipped ? file.arrayBuffer().then(SC.pins.unzipKml) : file.text();
    return text.then((t) => {
      const r = SC.pins.parse(t);
      // skip anything already on the map: same spot (within 5 yd) and same name
      const near = (p, q) => distM(p.lat, p.lng, q.lat, q.lng) < 5;
      const fresh = r.points.filter((p) => !stands().some((s) => near(p, s) && s.name === p.name) && !S.state.marks.some((m) => near(p, m) && (m.name || '') === p.name));
      ui.importing = { file: file.name, format: r.format, points: fresh, skipped: r.points.length - fresh.length, lines: r.lines };
      if (isMobile() && ui.sheet === 'peek') setSheet('half');
      go('import');
      if (fresh.length) M.fitPoints(fresh.map((p) => ({ lat: p.lat, lng: p.lng })));
    }).catch((e) => toast(e && e.message ? e.message : 'Could not read that file.'));
  }
  // a pin with no name of its own is shown by its date, e.g. "Oct 22, 2025"
  function pinDate(p) {
    const t = p.time && Date.parse(p.time);
    return t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  function kindLabel(k) { return k === 'stand' ? 'Stand' : (MT.TYPES[k] || MT.TYPES.other).label; }
  function importView() {
    const im = ui.importing;
    if (!im) { ui.view = 'list'; return marksView(); }
    const root = h('div', { class: 'view' });
    root.appendChild(backHeader('Import pins', () => { ui.importing = null; go('list', { tab: 'marks' }); }));
    const n = im.points.length, counts = {};
    im.points.forEach((p) => { counts[p.kind] = (counts[p.kind] || 0) + 1; });
    root.appendChild(h('p', { class: 'sub' }, im.file + '  ·  ' + im.format));
    if (!n) {
      root.appendChild(h('p', { class: 'note' }, im.skipped ? 'Everything in this file is already on your map.' : 'No pins found in this file.' + (im.lines ? ' It has ' + im.lines + (im.lines === 1 ? ' line' : ' lines') + ' (tracks or boundaries), which StandCast does not bring in.' : '')));
      return root;
    }
    root.appendChild(h('p', { class: 'line' }, h('b', null, n + (n === 1 ? ' pin' : ' pins')), ' ready to add: ' +
      Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map((k) => counts[k] + ' ' + kindLabel(k).toLowerCase()).join(', ') + '.'));
    if (im.skipped) root.appendChild(h('p', { class: 'line dim' }, im.skipped + ' already on your map, so left out.'));
    if (im.lines) root.appendChild(h('p', { class: 'line dim' }, im.lines + (im.lines === 1 ? ' line (a track or boundary) is' : ' lines (tracks or boundaries) are') + ' not brought in.'));
    root.appendChild(h('p', { class: 'fine tight' }, 'The kind comes from each pin\'s onX icon, or is guessed from its name and note. Change any of them below, or later on the pin.'));
    const opts = [['stand', 'Stand']].concat(MT.ORDER.map((k) => [k, MT.TYPES[k].label]));
    const list = h('div', { class: 'imp-list' });
    im.points.slice(0, 60).forEach((p) => list.appendChild(h('div', { class: 'imp-row' },
      h('span', { class: 'imp-name' }, p.name || pinDate(p) || '(no name)'),
      h('select', { 'aria-label': 'Kind for ' + (p.name || 'pin'), onchange: (e) => { p.kind = e.target.value; } },
        opts.map((o) => h('option', { value: o[0], selected: o[0] === p.kind }, o[1]))))));
    if (n > 60) list.appendChild(h('p', { class: 'fine tight' }, 'And ' + (n - 60) + ' more, added with their guessed kinds.'));
    root.appendChild(list);
    root.appendChild(h('div', { class: 'row2' },
      h('button', { class: 'btn primary', type: 'button', onclick: addImported }, 'Add ' + n + (n === 1 ? ' pin' : ' pins')),
      h('button', { class: 'btn', type: 'button', onclick: () => { ui.importing = null; go('list', { tab: 'marks' }); } }, 'Cancel')));
    return root;
  }
  function addImported() {
    const im = ui.importing; if (!im) return;
    let ns = 0, nm = 0;
    im.points.forEach((p) => {
      const at = p.time && !isNaN(Date.parse(p.time)) ? Date.parse(p.time) : Date.now();
      if (p.kind === 'stand') { S.addStand({ name: p.name || ('Stand ' + (pinDate(p) || (ns + 1))), lat: p.lat, lng: p.lng, notes: p.note || '', createdAt: at }); ns++; }
      else { S.addMark({ type: MT.TYPES[p.kind] ? p.kind : 'other', name: p.name || '', note: p.note || '', lat: p.lat, lng: p.lng, createdAt: at }); nm++; }
    });
    ui.importing = null;
    const added = im.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    toast('Added ' + [ns ? ns + (ns === 1 ? ' stand' : ' stands') : null, nm ? nm + (nm === 1 ? ' mark' : ' marks') : null].filter(Boolean).join(' and ') + (ns ? '. Mark each stand\'s good and bad winds.' : '.'));
    go('list', { tab: ns && !nm ? 'stands' : 'marks' });
    if (ns) refresh();
    // show where they all landed, above the panel
    if (isMobile()) setSheet('peek');
    setTimeout(() => M.fitPoints(added), 350);
  }
  function exportPins() {
    if (!stands().length && !S.state.marks.length) { toast('Nothing to export yet.'); return; }
    const gpx = SC.pins.toGpx(stands().filter((s) => !s.example), S.state.marks, (t) => (MT.TYPES[t] || MT.TYPES.other).label);
    download('standcast-pins-' + new Date().toISOString().slice(0, 10) + '.gpx', new Blob([gpx], { type: 'application/gpx+xml' }));
    toast('Saved a GPX file of your stands, marks and walks. Import it in onX, HuntStand, Garmin or Google Earth.');
  }
  function pinsRow() {
    return h('div', { class: 'row2' },
      h('button', { class: 'btn small', type: 'button', onclick: pickPins }, 'Import pins'),
      h('button', { class: 'btn small', type: 'button', onclick: exportPins }, 'Export pins (GPX)'));
  }
  /* ---- backup ---- */
  function saveBackup() {
    return S.exportAll().then((b) => {
      download('standcast-backup-' + new Date().toISOString().slice(0, 10) + '.json', b);
      S.markBackedUp();
      toast('Backup saved to your downloads. Keep a copy somewhere off this phone too.');
      renderSheet();
    }).catch(() => toast('Could not make the backup.'));
  }
  function backupAge(at) {
    if (!at) return 'never';
    const d = Math.floor((Date.now() - at) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }
  // A nudge at the top of the Stands and Marks lists when there is new work that is not in a backup yet.
  function backupNote() {
    const due = S.backupDue(); if (!due) return null;
    const what = [due.stands ? due.stands + (due.stands === 1 ? ' stand' : ' stands') : null, due.marks ? due.marks + (due.marks === 1 ? ' mark' : ' marks') : null].filter(Boolean).join(' and ');
    return h('div', { class: 'note warn' },
      h('p', null, h('b', null, 'Back up your map. '), 'Your ' + what + (due.stands + due.marks === 1 ? ' is' : ' are') + ' saved only on this phone. Last backup: ' + backupAge(due.at) + '.'),
      h('div', { class: 'row2' },
        h('button', { class: 'btn small primary', type: 'button', onclick: saveBackup }, 'Save a backup'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { S.snoozeBackup(7); renderSheet(); } }, 'Remind me later')));
  }
  function guideView() {
    const root = h('div', { class: 'view' });
    root.appendChild(h('div', { class: 'view-head' }, h('h2', null, 'Guide')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'How the ranking works'),
      h('p', { class: 'line' }, 'For each stand, StandCast looks at the wind through your hunt window (the first hours after sunrise or the last hours before sunset). It adds an estimate of slope thermals to the forecast wind, then checks the result against the winds you marked good and bad for that stand.'),
      h('p', { class: 'line' }, 'The score is mostly wind fit, plus how steady the wind is, how fast it is moving, rain chances and how recently you hunted the stand. The scent cone on the map shows where your scent travels at the time you pick on the slider.')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'What to trust'),
      h('p', { class: 'line' }, 'Wind comes from the National Weather Service forecast, on a grid about a mile and a half wide. It does not see every hollow and ridge, so local swirl can differ. Thermals are an estimate from the slope, the sun and cloud cover, and they matter most in light wind on a real hillside.'),
      h('p', { class: 'line' }, 'Use it to choose between stands and to spot a bad wind swing coming. Your own read of the woods comes first.')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Wind checks: keeping StandCast honest'),
      h('p', { class: 'line' }, 'Before each sit, StandCast saves its wind call for every stand on this phone. After the sit, open the stand, tap Log a sit, and tap the way the wind was coming from (milkweed, smoke or powder at the stand). StandCast scores its own call against yours: a call within one compass point counts as a match.'),
      h('p', { class: 'line' }, 'Each stand keeps a track record. Once 3 or more of your checks agree that the air at a stand runs off the forecast, for example a draw that bends a southwest wind to the west, StandCast turns that stand\'s modeled wind to match. You can switch the correction off on the stand.'),
      h('p', { class: 'line' }, 'A sit logged days later, with no saved call for that day, is kept but not scored.')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Walk in and out'),
      h('p', { class: 'line' }, 'Open a stand and tap Draw my walk in. Tap where you park, then each turn on the way; the stand is added at the end. "Start at me" begins the line where you are standing. StandCast walks the route at about 2 mph so you reach the stand as the hunt window opens, and works out the wind and slope thermals at each step.'),
      h('p', { class: 'line' }, 'On the map, white ticks show where your scent drifts as you walk; red ticks mean it reaches bedding, a trail, a scrape, a rub, food, water or a sighting you marked. The way out is checked as you leave at the end of the window, on the same path unless you draw a different one.')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Finding stand sites'),
      h('p', { class: 'line' }, 'Zoom in to about a square mile and tap Find new stand sites in view (on the Stands tab or the + menu). StandCast reads the lidar ground for saddles, funnels and benches, then ranks them using your marks: spots between bedding and food, close to scrapes, rubs and trails, and crossings you marked. Each pick lists the winds that keep your scent off the bedding and the food.'),
      h('p', { class: 'line' }, 'It only sees the shape of the ground and your own marks, so scout a spot before you hang a stand. Mark bedding and food first for the best picks.')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Bow range and trail cameras'),
      h('p', { class: 'line' }, 'Rings at 20, 30 and 40 yd show round every stand when you zoom in. Turn them off in the layers menu.'),
      h('p', { class: 'line' }, 'A Camera pin keeps every card pull. Open it and tap Add photos from the card to add many at once. They sort by the date the camera stamped on them, and the pin shows how many came at dawn, in the day, at dusk and at night.')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Reading the thermals'),
      h('p', { class: 'line' }, 'Wind and thermals are drawn apart. The long pale streaks are the wind near the ground, slowed by the trees. The orange and purple glow marks slopes where thermals are working, and the bright beads crawling across it show which way: orange climbing uphill, purple draining downhill. Beads go faint where the wind is strong enough to overpower them. Pink spinning rings are swirl, where the two fight. The green puffs leaving each stand are your scent riding all of it together.'),
      h('p', { class: 'line' }, 'Under Map layers you can show just the wind, just the thermals, or both.'),
      h('p', { class: 'line' }, 'Map photos: Summer is USDA aerial photography with the leaves on, refreshed every few years. Leaf-off is winter photography with the trees bare, so you can see ridges, benches, trails and openings under the canopy. It covers Missouri (2023 and 2024) and Wisconsin (2018 to 2024, by county); anywhere else it shows the summer photo. The round map button cycles Summer, Leaf-off and Topo; Hybrid is under Map layers.'),
      h('p', { class: 'line' }, 'Overlays (Map layers): Lidar terrain is USGS laser-scanned ground shape blended into the photo, so ridges, benches, saddles, ditches and old roads stand out even under timber. Crops 2025 is USDA CropScape: what was grown in each field last season (corn, soybeans, wheat, hay and so on). Each has its own strength slider and works on any base map.'),
      h('p', { class: 'line' }, 'Find a place with the magnifier at the top: type a town, lake, creek, landform or piece of public land anywhere in the country and tap a result to go there. Add a state, like “Stockton WI”, to narrow it. Coordinates such as 37.8096, -93.6250 work too. For a street address, give the town and state or a ZIP, like “100 South St, Stockton, MO”. Road names are searched within about 25 miles of where the map is looking.'),
      h('p', { class: 'line' }, 'Roads and trails (Map layers) draws lines over any map: a solid line is a road, long dashes are a 4WD or closed road, and dots are a trail. Tap a line for its name. It comes from national road and trail records, so many woods roads and most unofficial trails are missing. Route numbers are written about every 5 miles along a highway. Road names adds the name of each road.'),
      h('p', { class: 'line' }, 'Property lines and owners (Map layers) draws private parcel lines in thin white when you are zoomed in. Tap inside one for the owner, acres and parcel number. It covers Wisconsin so far, from the state\'s public parcel map. Missouri has no statewide public parcel map; each county keeps its own. Tax map lines are not surveys, so get permission before you step over one.'),
      h('p', { class: 'line' }, 'Creeks and rivers (Map layers) draws the national stream records in blue over any map: a solid line runs year-round, a dashed line runs part of the year, and named streams are labelled. Roads and streams come from national records, good to within several yards in most places but not surveyed, so a creek or woods road can sit a little off its true line.'),
      h('p', { class: 'line' }, 'Town names and the names of public land are written on every map. Towns show in white and public land in pale green italics; far out you see state names and big cities, and smaller towns and public land appear as you zoom in. Names that would overlap are left out, the bigger town winning. Roads work the same way: main highways when zoomed out, local roads and trails up close. Switch them off under Map layers (Town and public land names).'),
      h('p', { class: 'line' }, 'Benches (Map layers) shades flat strips part-way up a hillside: ground that is clearly flatter than the slope above and below it. It is worked out from the lidar ground data for the area on screen, so zoom in to use it. It only knows the shape of the ground, so treat it as places worth walking, not proof deer travel there.'),
      h('p', { class: 'line' }, 'Saddles and Funnels (Map layers) show as small dark badges with a green rim, only the strongest few in view so the map stays readable. A round badge is a saddle: a low gap in a ridge. A square badge is a funnel: easy walking squeezed between steep ground or water. Tap a badge to see what it found. Like benches, they come from the shape of the ground only.'),
      h('p', { class: 'line' }, 'Stand slopes and the thermal flow use the same lidar ground data (1 m where available) for a much closer read of each hillside than before.'),
      h('p', { class: 'line' }, 'Press and hold any spot on the map to add a stand or a mark right there: a target appears and you pick what it is, then tap Save. Tap the map at any point before saving to take it back off.'),
      h('p', { class: 'line' }, 'Measure yardage with the ruler button: tap points on the map (tap a stand or mark to snap to it). Each leg shows its yards and the bar shows the total. Drag any point to adjust it.'),
      h('p', { class: 'line' }, 'Tap the locate button to follow yourself: the map keeps you in the middle as you walk and turns around you. Drag the map to stop following.'),
      h('p', { class: 'line' }, 'Turn the map with a two-finger twist (on a computer, hold Shift and drag). The compass needle always points north. Tap it to snap back to north-up, and tap it again to have the map turn with your phone so the way you are facing is up.'),
      h('p', { class: 'line' }, 'With the animation off, orange arrows show air drifting uphill on slopes the sun is warming. Purple arrows show cool air draining downhill, which usually starts on the shady side an hour or so before sunset. Purple circles mark low spots where cool air pools after dark.'),
      h('p', { class: 'line' }, 'Drag the time slider to watch the flip happen. Each stand also lists the time its air turns downhill, which is when a stand above a bedding area can go bad.'),
      h('p', { class: 'line' }, 'Pink loops mark likely swirl. That happens where draining or rising air runs into wind pushing the other way along the slope, or on the downwind side of a ridge where the wind curls back. A stand with swirl in its window gets a warning and loses a few points.'),
      h('p', { class: 'flow-note' }, 'The flow layer shows when you zoom in close. Turn layers on or off under Map layers.')));
    const sizeBtn = h('button', { class: 'btn', type: 'button' }, 'Save this map area for offline');
    sizeBtn.addEventListener('click', () => {
      sizeBtn.disabled = true; sizeBtn.textContent = 'Saving…';
      M.cacheArea((d, t) => { sizeBtn.textContent = 'Saving ' + Math.round(d / t * 100) + '%'; })
        .then((r) => toast('Saved ' + r.saved + ' map tiles' + (r.failed ? ' (' + r.failed + ' failed)' : '') + '. Works with no signal.'))
        .catch((e) => toast(e.message || 'Could not save the map.'))
        .then(() => { sizeBtn.disabled = false; sizeBtn.textContent = 'Save this map area for offline'; });
    });
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'No signal in the woods'),
      h('p', { class: 'line' }, 'Zoom to the property you hunt, then save the map. Your stands, marks and the last forecast also work offline. Install StandCast to your home screen for the best results.'), sizeBtn));
    const imp = $('file-import');
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Backup'),
      h('p', { class: 'line' }, 'Your data lives on this device. Save a backup before you clear browser data or switch phones. The backup file holds your stands, marks and photos.'),
      h('p', { class: 'fine' }, 'Last backup: ' + backupAge(settings().backup.at) + '.'),
      h('div', { class: 'row2' },
        h('button', { class: 'btn', type: 'button', onclick: saveBackup }, 'Save a backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => { imp.value = ''; imp.click(); } }, 'Restore a backup'))));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Pins from other apps'),
      h('p', { class: 'line' }, 'Bring in your pins from onX, HuntStand, Garmin, Google Earth or any app that exports GPX, KML or KMZ. In onX, open a pin folder and choose Export; save the file, then tap Import pins here. StandCast guesses each pin\'s kind from its name, and you can change it before adding.'),
      h('p', { class: 'line' }, 'Export pins saves a GPX file of your stands, marks and walks that those apps can read. Photos and sit logs stay in the StandCast backup.'),
      pinsRow()));
    const ex = stands().filter((s) => s.example);
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Example data'),
      ex.length ? h('button', { class: 'btn', type: 'button', onclick: () => { ex.forEach((s) => S.removeStand(s.id)); ui.selStand = null; toast('Examples removed'); recompute(); go('list'); refresh(); } }, 'Remove example stands')
        : h('button', { class: 'btn', type: 'button', onclick: loadExamples }, 'Add 3 example stands')));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Start over'),
      h('p', { class: 'line' }, 'Deletes every stand, mark and photo on this device.'),
      confirmTwice('Erase everything', () => { S.clearAll(); ui.selStand = ui.selMark = null; data.fc = {}; toast('All data erased'); recompute(); go('list', { tab: 'stands' }); })));
    root.appendChild(h('div', { class: 'block' }, h('h3', null, 'Data and credits'),
      h('p', { class: 'fine' }, 'Forecast: U.S. National Weather Service (weather.gov). Sunrise, sunset and sunshine are worked out in the app from the sun\'s position and the forecast cloud. Ground elevation: USGS 3D Elevation Program (lidar). Maps: U.S. Geological Survey, The National Map; Missouri leaf-off imagery: MSDIS. Wisconsin leaf-off imagery: Wisconsin DNR and the Wisconsin Regional Orthophoto Consortium. Wisconsin property lines and owners: Wisconsin Statewide Parcel Map (V12), State Cartographer\'s Office and Department of Administration. Place names and roads: USGS. Crops: USDA NASS Cropland Data Layer. Public land: USGS PAD-US. Mapping library: Leaflet with leaflet-rotate.')));
    return root;
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    $('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      ui.tab = b.dataset.tab; endPlacing(); go('list');
      if (isMobile() && ui.sheet === 'peek') setSheet('half');
    });
    $('fab').addEventListener('click', () => { endPlacing(); clearPending(); if (isMobile() && ui.sheet === 'peek') setSheet('half'); go('add'); });
    $('scrub-range').addEventListener('input', (e) => setScrub(+e.target.value, true));
    $('scrub-now').addEventListener('click', () => setScrub(data.nowMin));
    $('status').addEventListener('click', () => { if (!data.loading) refresh(true); });
    $('banner-cancel').addEventListener('click', cancelPlacing);
    $('banner-locate').addEventListener('click', useMyLocation);
    $('btn-locate').addEventListener('click', myLocationButton);
    const pop = $('layers');
    $('btn-layers').addEventListener('click', () => { closeSearch(); pop.hidden = !pop.hidden; $('btn-layers').setAttribute('aria-expanded', String(!pop.hidden)); });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && !$('btn-layers').contains(e.target)) { pop.hidden = true; $('btn-layers').setAttribute('aria-expanded', 'false'); } });
    pop.querySelectorAll('[data-base]').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
    pop.querySelectorAll('[data-ov]').forEach((c) => c.addEventListener('change', () => {
      const st = settings(); st.overlays = st.overlays || {}; st.overlays[c.dataset.ov] = c.checked; S.save(); applyOverlays(); syncLayerUi();
      if (c.checked && (c.dataset.ov === 'hillshade' || c.dataset.ov === 'contours')) toast((c.dataset.ov === 'contours' ? 'Contours' : 'Lidar terrain') + ' draw on demand, so give it a few seconds the first time.');
      if (c.checked && c.dataset.ov === 'contours' && M.zoom < 13) toast('Zoom in closer to see the 10 ft contour lines.');
      if (c.checked && c.dataset.ov === 'parcels') toast(!SC.parcels.covered() ? 'Property lines are available in Wisconsin so far. Missouri counties keep their own records.' : M.zoom < SC.parcels.MIN_ZOOM ? 'Zoom in closer to see property lines.' : 'Loading property lines. Tap inside one for the owner.');
      if (c.checked && c.dataset.ov === 'roadlines') toast(M.zoom < SC.roads.MIN_ZOOM ? 'Showing main highways. Zoom in for local roads and trails.' : 'Loading roads and trails. Tap a line for its name.');
      if (c.checked && c.dataset.ov === 'hydro' && M.zoom < 9) toast('Zoom in to see creeks and rivers.');
      if (c.checked && c.dataset.ov === 'labels') toast(M.zoom < 12 ? 'Zoom in closer to see road names.' : 'Road names draw on demand, so give them a few seconds.');
      if (c.checked && c.dataset.ov === 'benches') loadBenches(true);
      if (c.checked && (c.dataset.ov === 'saddles' || c.dataset.ov === 'funnels')) loadSpots(true);
      if (c.checked && c.dataset.ov === 'crops' && M.zoom > 16) toast('Crop map cells are 30 m, so it looks blocky up close.');
    }));
    pop.querySelectorAll('[data-ovop]').forEach((r) => r.addEventListener('input', () => {
      const st = settings(); st.ovOpacity = st.ovOpacity || {}; st.ovOpacity[r.dataset.ovop] = +r.value / 100; S.save(); applyOverlays();
    }));
    pop.querySelectorAll('[data-air]').forEach((b) => b.addEventListener('click', () => {
      settings().airMode = b.dataset.air; S.save(); if (SC.flow) SC.flow.setMode(b.dataset.air); syncLayerUi(); renderMap();
    }));
    // quick map button cycles summer -> leaf-off -> topo
    const CYCLE = ['imagery', 'leafoff', 'topo'];
    $('btn-base').addEventListener('click', () => {
      const i = CYCLE.indexOf(settings().basemap);
      const next = CYCLE[(i + 1) % CYCLE.length];
      setBase(next);
      if (next === 'leafoff') toast('Leaf-off: bare winter trees (Missouri and Wisconsin).');
    });
    pop.querySelectorAll('[data-layer]').forEach((c) => c.addEventListener('change', () => { settings().layers[c.dataset.layer] = c.checked; S.save(); if (c.dataset.layer === 'animate' && SC.flow) SC.flow.setEnabled(c.checked);
      if (c.dataset.layer === 'publand' && SC.publand) { SC.publand.setEnabled(c.checked); if (c.checked && M.zoom < 11) toast('Zoom in to see public land boundaries.'); }
      if (c.dataset.layer === 'field' || c.dataset.layer === 'swirl' || c.dataset.layer === 'animate') loadField(); renderMap(); }));
    ['file-photo', 'file-camera'].forEach((id) => $(id).addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f && photoCb) photoCb(f); }));
    $('file-shots').addEventListener('change', (e) => { if (shotsFor) addShots(shotsFor, e.target.files); });
    $('file-pins').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) readPins(f); });
    $('file-import').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      f.text().then(S.importAll).then((r) => { toast('Restored ' + r.stands + ' stands and ' + r.marks + ' marks'); refresh(); renderAll(); }).catch((err) => toast(err.message));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('landcard').hidden = true; }
      if (e.key === 'Escape' && ui.measure) { endMeasure(); return; }
      if (e.key === 'Escape') { if (ui.placing) cancelPlacing(); else if (!pop.hidden) pop.hidden = true; } });
    wireSheetDrag();
    window.addEventListener('resize', () => M.invalidate());
    if (window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty('--sheet-h', $('sheet').offsetHeight + 'px')).observe($('sheet'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) M.unwatch(); else if (wantLocation) M.watch(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && stands().length && data.at && Date.now() - data.at > W.TTL) refresh(); });
    window.addEventListener('online', () => { if (stands().length) refresh(true); });
  }
  // A tap on a road or trail line (when that layer is on and zoomed in) names it. True if there was one there.
  function roadAt(ll) {
    const info = SC.roads && ll ? SC.roads.pick(ll) : null;
    if (!info) return false;
    toast(info.kind === 'trail' ? [info.name || 'Trail (no name listed)', info.number ? 'no. ' + info.number : null, info.surface ? info.surface.toLowerCase() + ' surface' : null].filter(Boolean).join(', ')
      : (info.name || 'No name listed') + ' (' + info.label.toLowerCase() + ')');
    return true;
  }
  // A tap inside a property line (when that layer is on) shows who owns it. True if there was one there.
  function parcelAt(ll) {
    const p = SC.parcels && ll ? SC.parcels.pick(ll) : null;
    if (!p) return false;
    const card = $('landcard'), acres = p.acres != null ? p.acres : p.deedAcres;
    card.replaceChildren.apply(card, [
      h('div', { class: 'lc-top' }, h('h3', null, p.owner || 'Owner not listed'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { card.hidden = true; } }, icon('close', 18))),
      p.owner2 ? h('div', null, p.owner2) : null,
      h('div', null, h('span', { class: 'lc-tag' }, 'Private parcel'), acres != null ? h('span', { class: 'dim' }, '  ' + (Math.round(acres * 10) / 10).toLocaleString() + ' acres') : null),
      h('div', { class: 'dim' }, [p.address, p.county ? p.county.charAt(0) + p.county.slice(1).toLowerCase() + ' County' : null, p.id ? 'Parcel ' + p.id : null].filter(Boolean).join('  ·  ')),
      h('p', { class: 'lc-fine' }, 'From ' + p.credit + '. Tax map lines are not surveys and can be off on the ground. Get the owner\'s permission before entering private land.')
    ].filter(Boolean));   // replaceChildren would print a missing line as the word "null"
    card.hidden = false;
    return true;
  }
  /* ---- place search ---- */
  let searchTimer = 0, searchSeq = 0;
  function closeSearch() { $('search').hidden = true; $('btn-search').setAttribute('aria-expanded', 'false'); }
  function openSearch() {
    $('layers').hidden = true; $('landcard').hidden = true;
    $('search').hidden = false; $('btn-search').setAttribute('aria-expanded', 'true');
    const inp = $('search-input'); inp.focus(); inp.select();
  }
  function goToPlace(r) {
    closeSearch();
    if (isMobile()) setSheet('peek');
    const pad = isMobile() ? $('sheet').offsetHeight : 0;
    if (r.box) M.fitBox(r.box, pad); else M.flyTo(r.lat, r.lng, r.town ? 13.5 : 15.5, pad);
    M.setFound({ lat: r.lat, lng: r.lng, name: r.name });
    toast(r.name + '. Tap the red dot to clear it.');
  }
  function runSearch() {
    clearTimeout(searchTimer);
    const text = $('search-input').value.trim(), note = $('search-note'), list = $('search-results'), seq = ++searchSeq;
    if (text.length < 3) { list.replaceChildren(); note.textContent = 'Try a town, lake, creek, road, conservation area or address. Add a state to narrow it, like “Stockton WI”.'; return; }
    note.textContent = 'Searching…';
    const show = (res, roadsDone) => {
      if (seq !== searchSeq) return;
      note.textContent = res.length ? 'Nearest and best matches first.' + (roadsDone ? '' : ' Still checking road names…')
        : roadsDone ? 'Nothing found by that name. Check the spelling, or add a state. An address needs its town and state.' : 'Still checking road names…';
      list.replaceChildren.apply(list, res.map((r) => h('button', { class: 'search-hit', type: 'button', onclick: () => goToPlace(r) },
        h('b', null, r.name),
        h('span', null, [r.kind, r.where, r.distM > 1609 ? Math.round(r.distM / 1609.34).toLocaleString() + ' mi away' : null].filter(Boolean).join('  ·  ')))));
    };
    // places come back in about a second; road names follow a few seconds later and are merged into the list
    let roadsIn = false;
    SC.search.lookup(text, M.center(), (res) => { roadsIn = true; show(res, true); }).then((res) => { if (!roadsIn) show(res, false); })
      .catch((e) => { if (seq === searchSeq) { list.replaceChildren(); note.textContent = e.message || 'Search failed. Check your signal.'; } });
  }
  function wireSearch() {
    $('btn-search').appendChild(icon('search', 22));
    $('search-close').appendChild(icon('close', 20));
    $('btn-search').addEventListener('click', () => { if ($('search').hidden) openSearch(); else closeSearch(); });
    $('search-close').addEventListener('click', closeSearch);
    $('search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 600); });
    $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); e.target.blur(); } else if (e.key === 'Escape') closeSearch(); });
  }
  function showLand(info) {
    const card = $('landcard');
    card.replaceChildren(
      h('div', { class: 'lc-top' }, h('h3', null, info.name),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { card.hidden = true; } }, icon('close', 18))),
      h('div', null, h('span', { class: 'lc-tag' }, info.owner + ' land'), info.acres ? h('span', { class: 'dim' }, '  ' + info.acres + ' acres') : null),
      h('div', null, 'Managed by ' + info.manager + (info.kind ? ' · ' + info.kind : '')),
      h('div', { class: 'lc-acc ' + info.accessCls }, info.access),
      h('p', { class: 'lc-fine' }, 'From PAD-US, the national public land inventory. Lines can be off and public does not always mean open to hunting. Check the manager\'s maps and regulations before you go.'));
    card.hidden = false;
  }
  const OV_DEFAULT = { hillshade: 0.6, contours: 0.9, crops: 0.45, benches: 0.75, labels: 1, hydro: 1 };
  function ovOpacity(name) { const o = settings().ovOpacity || {}; return o[name] != null ? o[name] : OV_DEFAULT[name]; }
  function applyOverlays() {
    const on = settings().overlays || {};
    ['hillshade', 'contours', 'crops', 'labels', 'hydro'].forEach((n) => M.setOverlay(n, !!on[n], ovOpacity(n)));
    if (SC.roads) SC.roads.setEnabled(!!on.roadlines);
    if (SC.parcels) SC.parcels.setEnabled(!!on.parcels);
    if (SC.labels) SC.labels.setEnabled(on.names !== false);   // on unless switched off
    loadBenches(); loadSpots();
  }
  function setBase(key) { settings().basemap = key; S.save(); M.setBasemap(key); syncLayerUi(); if (SC.labels) SC.labels.refresh(); }
  function syncLayerUi() {
    const pop = $('layers'), st = settings();
    pop.querySelectorAll('[data-base]').forEach((b) => { const on = b.dataset.base === st.basemap; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const ovs = st.overlays || {};
    pop.querySelectorAll('[data-ov]').forEach((c) => { c.checked = c.dataset.ov === 'names' ? ovs.names !== false : !!ovs[c.dataset.ov]; });
    pop.querySelectorAll('[data-ovop]').forEach((r) => { r.value = Math.round(ovOpacity(r.dataset.ovop) * 100); r.disabled = !ovs[r.dataset.ovop]; });
    pop.querySelector('.crop-key').classList.toggle('off', !ovs.crops);
    pop.querySelectorAll('[data-air]').forEach((b) => { const on = b.dataset.air === (st.airMode || 'both'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    // the round map button shows the map you are ON; tapping it moves to the next one
    const bb = $('btn-base'), names = { imagery: 'Summer', leafoff: 'Leaf-off', topo: 'Topo', hybrid: 'Hybrid' };
    const cur = names[st.basemap] ? st.basemap : 'imagery';
    bb.querySelector('span').textContent = names[cur];
    bb.setAttribute('aria-label', 'Map: ' + names[cur] + '. Tap for the next map.');
    bb.dataset.cur = cur;
    pop.querySelectorAll('[data-layer]').forEach((c) => { c.checked = !!st.layers[c.dataset.layer]; });
  }

  function decorateChrome() {
    $('btn-layers').appendChild(icon('layers', 22));
    $('btn-locate').appendChild(icon('locate', 22));
    $('fab').appendChild(icon('plus', 28));
    const tabs = { stands: ['stands', 'Stands'], marks: ['marks', 'Marks'], photos: ['photos', 'Photos'], guide: ['guide', 'Guide'] };
    document.querySelectorAll('#tabs button').forEach((b) => {
      const t = tabs[b.dataset.tab];
      b.appendChild(icon(t[0], 22)); b.appendChild(h('span', null, t[1]));
    });
  }

  /* ---- your location ----
   * First open with no stands: ask, and center the map on you.
   * Later opens: if location is already allowed, the dot comes on quietly.
   * The dot follows you while the app is open and stops when it is hidden. */
  let wantLocation = false;
  function locPermission() {
    try {
      if (navigator.permissions && navigator.permissions.query)
        return navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state, () => 'unknown');
    } catch (e) {}
    return Promise.resolve('unknown');
  }
  function startLocation() {
    if (!navigator.geolocation) return;
    const first = !stands().length && !settings().askedLocation;
    locPermission().then((state) => {
      if (state === 'denied') return;
      if (state === 'granted' || first || (state === 'unknown' && settings().locationOn)) {
        settings().askedLocation = true; S.save();
        wantLocation = true;
        M.watch((err) => { wantLocation = false; if (first) toast(err.message); });
        if (first) M.locate().then((p) => { settings().locationOn = true; S.save(); M.flyTo(p.lat, p.lng, 15, isMobile() ? $('sheet').offsetHeight : 0); }).catch(() => {});
        else M.locate().then(() => { settings().locationOn = true; S.save(); }).catch(() => {});
      }
    });
  }
  // Locate button: tap to follow you (map stays centered on you and turns around you), tap again to stop.
  function setFollowUi(on) { $('btn-locate').classList.toggle('on', on); $('btn-locate').setAttribute('aria-pressed', String(on)); }
  function startFollow(quiet) {
    wantLocation = true;
    M.locate().then((p) => {
      settings().locationOn = true; S.save();
      if (isMobile() && ui.sheet !== 'peek') setSheet('peek');      // keep the center of the map, where you are, in view
      M.setFollow(true, () => { setFollowUi(false); if (heading.on) stopHeading(true); });
      setFollowUi(true);
      if (!quiet) toast('Following you. Drag the map to stop.');
    }).catch((e) => toast(e.message));
  }
  function stopFollow() { M.setFollow(false); setFollowUi(false); }
  function myLocationButton() {
    if (M.following) { if (heading.on) stopHeading(true); stopFollow(); return; }
    startFollow();
  }

  /* ---- compass and map rotation ----
   * The needle always points north. Tap it when the map is turned to spin back to north-up.
   * Tap it with north up to have the map turn with your phone (the way you are facing is up). */
  let heading = { on: false, handler: null, last: null, raf: 0 };
  function updateCompass(b) {
    const c = $('compass'); if (!c) return;
    c.querySelector('.needle').style.transform = 'rotate(' + (b || 0) + 'deg)';
    c.classList.toggle('turned', Math.abs(((b % 360) + 360) % 360) > 0.5 && Math.abs(((b % 360) + 360) % 360) < 359.5);
  }
  function spinTo(target) {
    const from = M.bearing(), start = performance.now();
    let delta = ((target - from + 540) % 360) - 180;
    const step = (now) => {
      const t = Math.min(1, (now - start) / 350), e = 1 - Math.pow(1 - t, 3);
      M.setBearing(from + delta * e);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function stopHeading(quiet) {
    if (!heading.on) return;
    heading.on = false;
    window.removeEventListener('deviceorientationabsolute', heading.handler, true);
    window.removeEventListener('deviceorientation', heading.handler, true);
    $('compass').classList.remove('following');
    M.setHeading(null);
    if (!quiet) toast('Map stays put now. North is up again.');
    spinTo(0);
  }
  function startHeading() {
    const go = () => {
      heading.on = true; heading.last = null;
      heading.handler = (e) => {
        let hd = null;
        if (typeof e.webkitCompassHeading === 'number') hd = e.webkitCompassHeading;          // iPhone
        else if (e.absolute && typeof e.alpha === 'number') hd = 360 - e.alpha;               // Android
        if (hd == null) return;
        const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
        hd = (hd + so + 360) % 360;
        // smooth out jitter
        heading.last = heading.last == null ? hd : heading.last + ((((hd - heading.last) + 540) % 360) - 180) * 0.25;
        cancelAnimationFrame(heading.raf);
        heading.raf = requestAnimationFrame(() => {
          if (!heading.on) return;
          M.setHeading(heading.last);
          // ignore sub-degree jitter so the map (and the moving air) is not redrawn constantly
          const cur = -M.bearing(), d = Math.abs((((heading.last - cur) + 540) % 360) - 180);
          if (d > 1.5) M.setBearing(-heading.last);
        });
      };
      window.addEventListener('deviceorientationabsolute', heading.handler, true);
      window.addEventListener('deviceorientation', heading.handler, true);
      $('compass').classList.add('following');
      if (!M.following) startFollow(true);       // turn around you, not around the middle of the map
      toast('Map turns with your phone. Tap the compass to stop.');
      setTimeout(() => { if (heading.on && heading.last == null) { stopHeading(true); toast('This device does not report which way it is facing.'); } }, 2500);
    };
    const D = window.DeviceOrientationEvent;
    if (!D) { toast('This device does not report which way it is facing.'); return; }
    if (typeof D.requestPermission === 'function') {
      D.requestPermission().then((r) => { if (r === 'granted') go(); else toast('Allow motion and orientation to turn the map with your phone.'); }).catch(() => toast('Could not use the compass.'));
    } else go();
  }
  function compassTap() {
    const b = ((M.bearing() % 360) + 360) % 360;
    if (heading.on) return stopHeading();
    if (b > 0.5 && b < 359.5) return spinTo(0);
    startHeading();
  }

  function boot() {
    if (!window.L) {
      $('map').textContent = 'The map could not load. Check your connection and reload.';
      $('map').classList.add('failed');
      return;
    }
    S.load();
    decorateChrome();
    let saveTimer = null;
    M.init('map', {
      view: settings().view, basemap: settings().basemap,
      onTap: (ll) => { if (ui.measure) addMeasurePoint(ll.lat, ll.lng); else if (ui.placing) placeAt(ll.lat, ll.lng); else if (!tapCancels() && !roadAt(ll)) parcelAt(ll); },
      onHold: (ll) => holdAt(ll.lat, ll.lng),
      onSelectStand: (id) => { if (ui.measure) { const s = S.getStand(id); if (s) addMeasurePoint(s.lat, s.lng); } else if (!ui.placing) selectStand(id); },
      onSelectMark: (id) => { if (ui.measure) { const m = S.getMark(id); if (m) addMeasurePoint(m.lat, m.lng); } else if (!ui.placing) selectMark(id); },
      onMoveStand: (id, lat, lng) => { S.updateStand(id, { lat: lat, lng: lng }); refresh(); },
      onMoveMark: (id, lat, lng) => { S.updateMark(id, { lat: lat, lng: lng }); renderMap(); },
      onRotate: (b) => updateCompass(b),
      onRotateEnd: (b) => { settings().view.bearing = b; S.save(); loadField(); },
      onMoveEnd: (c, z) => { loadField(); loadBenches(); loadSpots(); clearTimeout(saveTimer); saveTimer = setTimeout(() => { settings().view = { lat: c.lat, lng: c.lng, zoom: z, bearing: M.bearing() }; S.save(); }, 600); }
    });
    try { if (SC.publand && M.leaflet) {
      SC.publand.attach(M.leaflet, {
        onTap: (info, ll) => { if (ui.measure && ll) addMeasurePoint(ll.lat, ll.lng); else if (ui.placing && ll) placeAt(ll.lat, ll.lng); else if (!tapCancels() && !roadAt(ll)) showLand(info); },
        onStatus: (st) => { if (st === 'error') toast('Could not load public land. Check your signal.'); }
      });
      SC.publand.setEnabled(settings().layers.publand !== false);
    } } catch (e) { console.warn('public land layer off', e); }
    // The topo and hybrid maps already print town names, so ours are only added on the photo maps.
    try { if (SC.labels && M.leaflet) SC.labels.attach(M.leaflet, { showTowns: () => settings().basemap !== 'topo' && settings().basemap !== 'hybrid' }); }
    catch (e) { console.warn('map names off', e); }
    try { if (SC.parcels && M.leaflet) SC.parcels.attach(M.leaflet, { onStatus: (st) => { if (st === 'error') toast('Could not load property lines. Check your signal.'); } }); }
    catch (e) { console.warn('property lines off', e); }
    try { if (SC.roads && M.leaflet) {
      SC.roads.attach(M.leaflet, {
        onStatus: (st) => { if (st === 'error') toast('Could not load roads and trails. Check your signal.'); }
      });
    } } catch (e) { console.warn('roads layer off', e); }
    try { if (SC.flow && M.leaflet) { SC.flow.attach(M.leaflet); SC.flow.setMode(settings().airMode || 'both'); SC.flow.setEnabled(settings().layers.animate !== false); } }
    catch (e) { console.warn('moving air off', e); }
    if (M.canRotate) {
      const c = $('compass'); c.hidden = false;
      c.addEventListener('click', compassTap);
      updateCompass(M.bearing());
      // a manual twist takes over from following the phone
      M.leaflet.on('rotatestart', () => { if (heading.on) stopHeading(true); });
      document.getElementById('map').addEventListener('touchstart', (e) => { if (heading.on && e.touches.length >= 2) stopHeading(true); }, { passive: true });
    }
    $('btn-measure').appendChild(icon('ruler', 22));
    $('btn-measure').addEventListener('click', () => { if (ui.measure) endMeasure(); else startMeasure(); });
    $('btn-photo').insertBefore(icon('photo', 22), $('btn-photo').firstChild);
    $('btn-photo').addEventListener('click', () => { if (ui.measure) endMeasure(); endPlacing(); if (isMobile() && ui.sheet === 'peek') setSheet('half'); go('photo'); });
    wireViewer(); wireSearch();
    $('measurebar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b || !ui.measure) return;
      const k = b.dataset.m;
      if (k === 'undo') { ui.measure.pts.pop(); drawMeasure(); }
      else if (k === 'clear') { ui.measure.pts = []; drawMeasure(); }
      else if (k === 'me') measureFromMe();
      else if (k === 'done') { if (ui.measure.route) saveRoute(); else endMeasure(); }
      else if (k === 'cancel') { const id = ui.measure.route && ui.measure.route.standId; endMeasure(); if (id) { selectStand(id); if (isMobile()) setSheet('half'); } }
    });
    if (settings().layers.rings == null) { settings().layers.rings = true; S.save(); }   // new in v43: on for everyone
    applyOverlays();
    wire(); syncLayerUi(); setSheet(isMobile() ? 'half' : 'full');
    renderAll();
    refresh();
    loadField();
    startLocation();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  SC.app = { boot: boot, _ui: ui, _data: data };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
