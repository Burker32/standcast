/* Moving air on the map, with wind and thermals kept visually apart:
 *   wind     long pale streaks moving with the forecast wind near the ground (slowed by trees)
 *   thermals a soft orange / purple glow on slopes where they are active, plus bright beads
 *            crawling uphill (orange) or downhill (purple) with the slope flow alone. Beads are
 *            bright where the thermals beat the wind and faint where the wind overpowers them.
 *   swirl    turning pink rings where the two fight
 *   scent    green puffs from each stand riding the combined air (wind + thermals + swirl)
 * Everything here is an estimate drawn from a weather model and 90 m terrain. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var E = SC.engine;

  var map, canvas, ctx, pane, glow, gctx, running = false, enabled = true, raf = 0, last = 0;
  var mode = 'both';        // 'both' | 'wind' | 'thermal'
  var beads = [];
  var data = null;          // last data from the app
  var geo = null;           // grid in screen space
  var parts = [], scent = [];
  var COLORS = { wind: '#d6f1ff', rise: '#ff8a4c', sink: '#c3a9ff', riseLo: '#ffc3a1', sinkLo: '#e0d4ff', swirl: '#ff5fd2', scent: '#eaffd9' };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function cssVar(n, f) { var v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || f; }

  function attach(m) {
    map = m;
    pane = map.createPane('flowPane');
    if (map._norotatePane) {
      // rotating map: draw in screen space between the map (which turns) and the pins (which stay upright)
      map._mapPane.insertBefore(pane, map._norotatePane);
      pane.style.zIndex = 400;
    } else pane.style.zIndex = 450;     // over the map and cones, under pins and labels
    pane.style.pointerEvents = 'none';
    canvas = document.createElement('canvas');
    canvas.className = 'flow-canvas';
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    glow = document.createElement('canvas');
    glow.className = 'flow-glow';
    glow.style.position = 'absolute';
    glow.style.pointerEvents = 'none';
    pane.appendChild(glow);
    pane.appendChild(canvas);
    ctx = canvas.getContext('2d');
    gctx = glow.getContext('2d');
    map.on('movestart zoomstart', function () { stop(); clear(); canvas.style.visibility = glow.style.visibility = 'hidden'; });
    map.on('moveend zoomend resize', function () { canvas.style.visibility = glow.style.visibility = ''; reset(); });
    var rt = 0;
    map.on('rotate', function () {
      stop(); clear(); canvas.style.visibility = glow.style.visibility = 'hidden';
      clearTimeout(rt); rt = setTimeout(function () { canvas.style.visibility = glow.style.visibility = ''; reset(); }, 260);
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    COLORS.rise = cssVar('--map-rise', COLORS.rise); COLORS.sink = cssVar('--map-sink', COLORS.sink); COLORS.swirl = cssVar('--map-swirl', COLORS.swirl);
  }

  function sizeCanvas() {
    var s = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    var mp = map._getMapPanePos ? map._getMapPanePos() : { x: 0, y: 0 };
    var tl = { x: -mp.x, y: -mp.y };      // the canvas always covers the screen
    [[canvas, ctx], [glow, gctx]].forEach(function (cc) {
      var cv = cc[0];
      L.DomUtil.setPosition(cv, tl);
      cv.style.width = s.x + 'px'; cv.style.height = s.y + 'px';
      if (cv.width !== Math.round(s.x * dpr) || cv.height !== Math.round(s.y * dpr)) { cv.width = Math.round(s.x * dpr); cv.height = Math.round(s.y * dpr); }
      cc[1].setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    return s;
  }
  function wipe(c, cv) { if (c) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); c.restore(); } }
  function clear() { wipe(ctx, canvas); wipe(gctx, glow); }

  /* ---------- screen directions of east and north (they turn when the map is rotated) ---------- */
  var axes = { ex: 1, ey: 0, nx: 0, ny: -1 };
  function buildAxes() {
    var c = map.getCenter(), p0 = map.latLngToContainerPoint(c);
    var pe = map.latLngToContainerPoint([c.lat, c.lng + 0.001]), pn = map.latLngToContainerPoint([c.lat + 0.001, c.lng]);
    var le = Math.hypot(pe.x - p0.x, pe.y - p0.y) || 1, ln = Math.hypot(pn.x - p0.x, pn.y - p0.y) || 1;
    axes = { ex: (pe.x - p0.x) / le, ey: (pe.y - p0.y) / le, nx: (pn.x - p0.x) / ln, ny: (pn.y - p0.y) / ln };
  }

  /* ---------- field in screen space ---------- */
  // cells: [{i,j,lat,lng,u,v,cls}] on a regular lat/lng grid -> fast lookups by pixel.
  function buildGeo() {
    geo = null;
    if (!data || !data.cells || !data.cells.length) return;
    var byIJ = {}, i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity, ref = null;
    data.cells.forEach(function (c) {
      byIJ[c.i + ',' + c.j] = c;
      if (c.i < i0) i0 = c.i; if (c.j < j0) j0 = c.j; if (c.i > i1) i1 = c.i; if (c.j > j1) j1 = c.j;
    });
    ref = data.cells[0];
    var dLat = data.dLat, dLng = data.dLng;
    var p0 = map.latLngToContainerPoint([ref.lat, ref.lng]);
    var pi = map.latLngToContainerPoint([ref.lat + dLat, ref.lng]);
    var pj = map.latLngToContainerPoint([ref.lat, ref.lng + dLng]);
    var a = pi.x - p0.x, b = pj.x - p0.x, c = pi.y - p0.y, d = pj.y - p0.y, det = a * d - b * c;
    if (!det) return;
    var z = map.getZoom();
    geo = {
      byIJ: byIJ, ri: ref.i, rj: ref.j, p0: p0, inv: [d / det, -b / det, -c / det, a / det],
      ax: [a, c], bx: [b, d],
      // screen pixels per second for 1 mph of near-ground air
      pxPerMph: Math.max(3, Math.min(60, 11 * Math.pow(2, z - 15))),
      mPerPx: 156543.03 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, z),
      swirls: (data.swirls || []).map(function (w) {
        var p = map.latLngToContainerPoint([w.lat, w.lng]);
        return { x: p.x, y: p.y, r: Math.max(18, w.rM / (156543.03 * Math.cos(w.lat * Math.PI / 180) / Math.pow(2, z))), s: w.score };
      })
    };
  }
  // Air at a screen point: {u, v} in mph (east, north) and which force wins there.
  function sample(x, y) {
    if (!geo) return null;
    var dx = x - geo.p0.x, dy = y - geo.p0.y;
    var fi = geo.inv[0] * dx + geo.inv[1] * dy, fj = geo.inv[2] * dx + geo.inv[3] * dy;
    var i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
    var c00 = geo.byIJ[(geo.ri + i) + ',' + (geo.rj + j)], c10 = geo.byIJ[(geo.ri + i + 1) + ',' + (geo.rj + j)];
    var c01 = geo.byIJ[(geo.ri + i) + ',' + (geo.rj + j + 1)], c11 = geo.byIJ[(geo.ri + i + 1) + ',' + (geo.rj + j + 1)];
    var o = { wu: 0, wv: 0, tu: 0, tv: 0, ts: 0, share: 0 }, wsum = 0, best = null, bw = -1;
    [[c00, (1 - ti) * (1 - tj)], [c10, ti * (1 - tj)], [c01, (1 - ti) * tj], [c11, ti * tj]].forEach(function (q) {
      var c = q[0], w = q[1];
      if (!c) return;
      o.wu += c.wu * w; o.wv += c.wv * w; o.tu += c.tu * w; o.tv += c.tv * w; o.ts += c.ts * w; o.share += c.share * w; wsum += w;
      if (w > bw) { bw = w; best = c; }
    });
    if (!wsum) return null;
    for (var k in o) o[k] /= wsum;
    o.sink = best.sink;
    return o;
  }
  // Screen velocity (px/s) at a point. part: 'wind' | 'thermal' | 'all'. Swirl spin applies to wind and all.
  function velocity(x, y, part, fallback) {
    var a = sample(x, y), k = geo ? geo.pxPerMph : 11, u, v;
    if (!a) {
      if (!fallback) return null;
      u = fallback.u; v = fallback.v;
    } else if (part === 'thermal') { u = a.tu * 1.4; v = a.tv * 1.4; }
    else if (part === 'wind') { u = a.wu; v = a.wv; }
    else { u = a.wu + a.tu; v = a.wv + a.tv; }
    var vx = (u * axes.ex + v * axes.nx) * k, vy = (u * axes.ey + v * axes.ny) * k, spin = 0;
    if (geo && part !== 'thermal') for (var n = 0; n < geo.swirls.length; n++) {
      var w = geo.swirls[n], rx = x - w.x, ry = y - w.y, d = Math.hypot(rx, ry);
      if (d < w.r * 1.6 && d > 0.5) {
        var f = (1 - d / (w.r * 1.6)) * w.s;
        var sp = k * 3.2 * f;
        vx = vx * (1 - f) + (-ry / d) * sp - (rx / d) * sp * 0.15;
        vy = vy * (1 - f) + (rx / d) * sp - (ry / d) * sp * 0.15;
        if (f > spin) spin = f;
      }
    }
    return { vx: vx, vy: vy, spin: spin, a: a };
  }

  /* ---------- thermal glow (redrawn when the data changes, not every frame) ---------- */
  function drawGlow() {
    var s = map.getSize();
    wipe(gctx, glow);
    if (!geo || mode === 'wind') return;
    var cellPx = Math.hypot(geo.ax[0], geo.ax[1]);
    var r = Math.max(10, cellPx * 0.95);
    data.cells.forEach(function (c) {
      if (c.ts < 0.18) return;
      var p = map.latLngToContainerPoint([c.lat, c.lng]);
      if (p.x < -r || p.y < -r || p.x > s.x + r || p.y > s.y + r) return;
      var col = c.sink ? COLORS.sink : COLORS.rise;
      var g = gctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, hexA(col, 0.04 + 0.13 * c.ts));   // light tint: the photo has to stay readable under it
      g.addColorStop(1, hexA(col, 0));
      gctx.fillStyle = g;
      gctx.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
    });
  }
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a.toFixed(3) + ')';
  }

  /* ---------- particles ---------- */
  function spawn(p, s) {
    p.x = Math.random() * s.x; p.y = Math.random() * s.y;
    p.age = 0; p.life = 50 + Math.random() * 90;
  }
  // Thermal beads start only where the slope flow is active (stronger slopes get more).
  function spawnBead(p, s) {
    for (var t = 0; t < 12; t++) {
      var x = Math.random() * s.x, y = Math.random() * s.y, a = sample(x, y);
      if (a && a.ts > 0.1 && Math.random() < a.ts * 1.2) { p.x = x; p.y = y; p.age = 0; p.life = 40 + Math.random() * 60; p.ok = true; return; }
    }
    p.ok = false; p.age = 0; p.life = 10;
  }
  function seed() {
    var s = map.getSize();
    var n = geo ? Math.min(800, Math.round(s.x * s.y / 1400)) : 0;
    parts = [];
    for (var k = 0; k < n; k++) { var p = {}; spawn(p, s); p.age = Math.random() * p.life; parts.push(p); }
    var nb = geo ? Math.min(420, Math.round(s.x * s.y / 2600)) : 0;
    beads = [];
    for (var j = 0; j < nb; j++) { var b = {}; spawnBead(b, s); b.age = Math.random() * b.life; beads.push(b); }
    scent = [];
  }

  function reset() {
    if (!map || !canvas) return;
    stop(); sizeCanvas(); clear(); buildAxes(); buildGeo(); seed(); drawGlow(); start();
  }
  function start() {
    if (running || !enabled || reduceMotion || document.hidden || !data) return;
    if (!geo && !(data.stands && data.stands.length)) return;
    running = true; last = 0; raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  function frame(ts) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (last && ts - last < 30) return;           // about 30 frames a second is plenty and saves battery
    var dt = last ? Math.min(0.08, (ts - last) / 1000) : 0.033;
    last = ts;
    var s = map.getSize();

    // fade the old trails
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.11)';
    ctx.fillRect(0, 0, s.x, s.y);
    ctx.restore();

    function path(b) { ctx.beginPath(); for (var q = 0; q < b.length; q += 4) { ctx.moveTo(b[q], b[q + 1]); ctx.lineTo(b[q + 2], b[q + 3]); } }
    function stroke(b, color, alpha, width, edge) {
      if (!b.length) return;
      path(b);
      if (edge) { ctx.lineCap = 'butt'; ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(10,20,14,0.42)'; ctx.lineWidth = width + edge; ctx.stroke(); }
      ctx.lineCap = 'round'; ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    }

    // wind: long thin pale streaks
    if (mode !== 'thermal') {
      var wb = [];
      for (var n = 0; n < parts.length; n++) {
        var p = parts[n];
        if (p.age++ > p.life) { spawn(p, s); continue; }
        var vel = velocity(p.x, p.y, 'wind', null);
        if (!vel) { spawn(p, s); continue; }
        var nx = p.x + vel.vx * dt, ny = p.y + vel.vy * dt;
        wb.push(p.x, p.y, nx, ny);
        p.x = nx; p.y = ny;
        if (nx < -5 || ny < -5 || nx > s.x + 5 || ny > s.y + 5) spawn(p, s);
      }
      stroke(wb, COLORS.wind, 0.8, 1.4, 1.6);
    }

    // thermals: fat bright beads moving with the slope flow only
    if (mode !== 'wind') {
      var groups = { rise: [], sink: [], riseLo: [], sinkLo: [] };
      for (var m2 = 0; m2 < beads.length; m2++) {
        var bd = beads[m2];
        if (bd.age++ > bd.life || !bd.ok) { spawnBead(bd, s); continue; }
        var tv = velocity(bd.x, bd.y, 'thermal', null);
        if (!tv || tv.a.ts < 0.05) { spawnBead(bd, s); continue; }
        var bx = bd.x + tv.vx * dt, by = bd.y + tv.vy * dt;
        var key = (tv.a.sink ? 'sink' : 'rise') + (tv.a.share < 0.4 && mode === 'both' ? 'Lo' : '');
        groups[key].push(bd.x, bd.y, bx, by);
        bd.x = bx; bd.y = by;
      }
      // faint beads = the wind is overpowering the slope flow there
      stroke(groups.riseLo, COLORS.rise, 0.45, 3.2, 2);
      stroke(groups.sinkLo, COLORS.sink, 0.45, 3.2, 2);
      stroke(groups.rise, COLORS.rise, 1, 3.6, 2.2);
      stroke(groups.sink, COLORS.sink, 1, 3.6, 2.2);
    }

    // swirl spots: a turning ring so they read at a glance
    if (geo) geo.swirls.forEach(function (w) {
      var a0 = (ts / 1000) * 2.2 * (0.6 + w.s);
      for (var r = 0; r < 2; r++) {
        ctx.beginPath(); ctx.arc(w.x, w.y, w.r * (0.55 + 0.25 * r), a0 + r * Math.PI, a0 + r * Math.PI + 1.6);
        ctx.globalAlpha = 0.6; ctx.strokeStyle = 'rgba(10,20,14,0.6)'; ctx.lineWidth = 5; ctx.stroke();
        ctx.globalAlpha = 0.6 + 0.4 * w.s; ctx.strokeStyle = COLORS.swirl; ctx.lineWidth = 2.6; ctx.stroke();
      }
    });

    // scent puffs from each stand, carried by the same air
    if (data.stands) data.stands.forEach(function (st) {
      var p0 = map.latLngToContainerPoint([st.lat, st.lng]);
      if (p0.x < -60 || p0.y < -60 || p0.x > s.x + 60 || p0.y > s.y + 60) return;
      if (Math.random() < 0.6) scent.push({ x: p0.x + (Math.random() - 0.5) * 6, y: p0.y + (Math.random() - 0.5) * 6, age: 0, maxD: st.reachM, sx: p0.x, sy: p0.y, fb: st.fb, jit: (Math.random() - 0.5) * 0.6 });
    });
    if (scent.length > 900) scent.splice(0, scent.length - 900);
    var mPerPx = geo ? geo.mPerPx : 156543.03 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, map.getZoom());
    ctx.fillStyle = COLORS.scent; ctx.strokeStyle = 'rgba(16,52,20,0.7)'; ctx.lineWidth = 1;
    var keep = [];
    for (var m = 0; m < scent.length; m++) {
      var sp = scent[m], v = velocity(sp.x, sp.y, 'all', sp.fb);
      if (!v) continue;
      // scent fans out a little as it travels
      var ang = Math.atan2(v.vy, v.vx) + sp.jit * Math.min(1, sp.age / 40);
      var spd = Math.max(Math.hypot(v.vx, v.vy), 4);
      sp.x += Math.cos(ang) * spd * dt; sp.y += Math.sin(ang) * spd * dt; sp.age++;
      var dist = Math.hypot(sp.x - sp.sx, sp.y - sp.sy) * mPerPx;
      var lifeLeft = 1 - dist / sp.maxD;
      if (lifeLeft <= 0 || sp.age > 400) continue;
      ctx.globalAlpha = 0.85 * lifeLeft;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.5 + 1.6 * (1 - lifeLeft), 0, 6.283); ctx.fill(); ctx.stroke();
      keep.push(sp);
    }
    scent = keep;
    ctx.globalAlpha = 1;
  }

  /* ---------- public ---------- */
  // d: { cells, dLat, dLng, swirls, stands: [{lat,lng,reachM,fb:{u,v,cls}}] }
  function set(d) {
    data = d;
    if (!map) return;
    if (!d) { stop(); clear(); geo = null; parts = []; scent = []; return; }
    buildAxes(); buildGeo();
    if (geo && !parts.length) seed();
    if (!geo) { parts = []; beads = []; }
    if (!running) sizeCanvas();
    drawGlow();
    if (!running) start();
  }
  function setEnabled(on) { enabled = !!on; if (!on) { stop(); clear(); } else reset(); }
  function setMode(m) { mode = m === 'wind' || m === 'thermal' ? m : 'both'; if (map && canvas) { clear(); drawGlow(); } }
  SC.flow = {
    attach: attach, set: set, setEnabled: setEnabled, setMode: setMode, get mode() { return mode; },
    get active() { return enabled && !reduceMotion; },
    get running() { return running; },
    _stats: function () { return { parts: parts.length, beads: beads.filter(function (b) { return b.ok; }).length, scent: scent.length, swirls: geo ? geo.swirls.length : 0, hasGeo: !!geo }; }
  };
})();
