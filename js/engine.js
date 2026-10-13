/* StandCast engine
 * Pure functions only (no DOM, no network). Runs in the browser as SC.engine and in Node for tests.
 *
 * Conventions
 *  - Wind direction is where the wind blows FROM, in degrees clockwise from north (met convention).
 *  - "toward" is where the air is moving to (from + 180).
 *  - Times are "naive local minutes": minutes since 1970-01-01 of the wall-clock time at the stand,
 *    so a 6:48 PM sunset in Missouri is stored as if it were 18:48 UTC. This keeps everything
 *    independent of the viewer's own time zone. utcOffsetSec converts back to real UTC when needed.
 *  - Speeds are mph, temperatures °F, elevations meters.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SC = root.SC || {}; root.SC.engine = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEG = Math.PI / 180;
  var SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function norm(d) { return ((d % 360) + 360) % 360; }
  function angDiff(a, b) { var d = Math.abs(norm(a) - norm(b)); return d > 180 ? 360 - d : d; }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function compass(deg) { return SECTORS[Math.round(norm(deg) / 45) % 8]; }

  /* ---------- vectors ---------- */

  // Wind that blows FROM `from` at `speed` moves toward from+180: components are (east, north).
  function toVec(from, speed) {
    return { u: -speed * Math.sin(from * DEG), v: -speed * Math.cos(from * DEG) };
  }
  function fromVec(u, v) {
    return { speed: Math.hypot(u, v), from: norm(Math.atan2(-u, -v) / DEG) };
  }

  /* ---------- distance ---------- */
  function distanceM(lat1, lng1, lat2, lng2) {
    var R = 6371008.8, p1 = lat1 * DEG, p2 = lat2 * DEG, dp = (lat2 - lat1) * DEG, dl = (lng2 - lng1) * DEG;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function yards(m) { return m * 1.0936133; }
  function fmtYards(m) {
    var y = yards(m);
    if (y >= 1760) return (y / 1760).toFixed(y >= 17600 ? 0 : 2) + ' mi';   // yards up to a mile, like a rangefinder
    return Math.round(y) + ' yd';
  }

  /* ---------- time ---------- */

  function parseLocalMin(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
  }
  function dateKey(tMin) { return new Date(tMin * 60000).toISOString().slice(0, 10); }
  function fmtClock(tMin) {
    var d = new Date(tMin * 60000), h = d.getUTCHours(), m = d.getUTCMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  function fmtDayClock(tMin) {
    return DOW[new Date(tMin * 60000).getUTCDay()] + ' ' + fmtClock(tMin);
  }
  function fmtHour(tMin) {
    var h = new Date(tMin * 60000).getUTCHours();
    return (h % 12 || 12) + (h >= 12 ? 'p' : 'a');
  }
  function dayDiff(dateA, dateB) { // whole days from A to B ('YYYY-MM-DD')
    return Math.round((Date.parse(dateB + 'T00:00:00Z') - Date.parse(dateA + 'T00:00:00Z')) / 86400000);
  }

  /* ---------- sun ---------- */

  // Low-precision solar position (good to a fraction of a degree), plenty for slope heating.
  function solarPosition(utcMs, latDeg, lonDeg) {
    var jd = utcMs / 86400000 + 2440587.5;
    var n = jd - 2451545.0;
    var L = norm(280.460 + 0.9856474 * n);
    var g = norm(357.528 + 0.9856003 * n) * DEG;
    var lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    var eps = (23.439 - 0.0000004 * n) * DEG;
    var dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    var gmst = norm(280.46061837 + 360.98564736629 * n);
    var H = norm(gmst + lonDeg) * DEG - ra;
    var lat = latDeg * DEG;
    var sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
    var elev = Math.asin(clamp(sinAlt, -1, 1)) / DEG;
    var A = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
    return { elev: elev, az: norm(A / DEG + 180) };
  }

  /* ---------- terrain ---------- */

  // Four elevation samples (N, E, S, W of the stand, `spacingM` away) give slope and the compass
  // direction the slope faces (downhill bearing). 90 m DEM data, so this is the broad hillside only.
  function terrainFromSamples(zN, zE, zS, zW, spacingM) {
    var dzdx = (zE - zW) / (2 * spacingM);
    var dzdy = (zN - zS) / (2 * spacingM);
    var slopeDeg = Math.atan(Math.hypot(dzdx, dzdy)) / DEG;
    var aspectDeg = slopeDeg < 1 ? null : norm(Math.atan2(-dzdx, -dzdy) / DEG);
    return { slopeDeg: slopeDeg, aspectDeg: aspectDeg };
  }
  function offsetLatLng(lat, lng, bearingDeg, meters) {
    var b = bearingDeg * DEG;
    return [
      lat + (meters * Math.cos(b)) / 111320,
      lng + (meters * Math.sin(b)) / (111320 * Math.cos(lat * DEG))
    ];
  }
  function terrainProbePoints(lat, lng, spacingM) {
    return [
      [lat, lng],
      offsetLatLng(lat, lng, 0, spacingM),
      offsetLatLng(lat, lng, 90, spacingM),
      offsetLatLng(lat, lng, 180, spacingM),
      offsetLatLng(lat, lng, 270, spacingM)
    ];
  }
  var STEEP = { flat: 0, gentle: 6, moderate: 12, steep: 22 };
  function resolveTerrain(stand) {
    var ov = stand.override || {}, auto = stand.terrain || null;
    var slope = auto ? auto.slopeDeg : 0;
    var aspect = auto && auto.aspectDeg != null ? auto.aspectDeg : null;
    var source = auto ? 'auto' : 'none';
    if (ov.steep && STEEP[ov.steep] != null) { slope = STEEP[ov.steep]; source = 'manual'; }
    if (ov.aspect) {
      aspect = ov.aspect === 'flat' ? null : SECTORS.indexOf(ov.aspect) * 45;
      source = 'manual';
    }
    return { slopeDeg: slope, aspectDeg: aspect, source: source };
  }

  /* ---------- thermals ---------- */

  // Rule-based estimate of slope (anabatic / katabatic) air movement. Not a measurement.
  //   index  -1..+1   negative = air sinking downhill, positive = rising uphill
  //   strength 0..1   how much it matters (needs a real slope and light synoptic wind)
  //   mph             rough drift speed added to the wind vector
  // Sign of slope heating: + the slope is being warmed (air flows uphill), - it is cooling (downhill).
  function heatIndex(slopeDeg, aspectDeg, sun, sw, cloud) {
    var clear = 1 - clamp(cloud, 0, 100) / 100;
    var rad = 0;
    if (sun.elev > 0) {
      if (aspectDeg == null || slopeDeg < 1) rad = sw || 0;
      else {
        var s = slopeDeg * DEG, e = sun.elev * DEG;
        var cosInc = Math.sin(s) * Math.cos(e) * Math.cos((sun.az - aspectDeg) * DEG) + Math.cos(s) * Math.sin(e);
        rad = (sw || 0) * clamp(cosInc / Math.max(Math.sin(e), 0.12), 0, 2);
      }
    }
    if (rad >= 90) return Math.min(1, (rad - 90) / 260);
    return -(0.35 + 0.65 * clear) * (1 - rad / 90);
  }
  function thermal(p) {
    var T = heatIndex(p.slopeDeg, p.aspectDeg, p.sun, p.sw, p.cloud);
    // Under the canopy the air near the ground is far calmer than the 10 m forecast wind,
    // so slope flow still steers scent in moderate wind. It fades out by about 20 mph.
    var windF = clamp(1 - p.windMph / 20, 0, 1);
    if (p.aspectDeg == null || p.slopeDeg < 1) {
      // Flat ground: air lifts straight up by day and settles and pools after sundown.
      var fs = Math.abs(T) * 0.35 * windF;
      return { index: T, strength: fs, mph: 0, u: 0, v: 0, toward: null, potential: 0,
        phase: fs < 0.06 ? 'weak' : (T < 0 ? 'falling' : 'rising'), flat: true };
    }
    var slopeF = clamp(Math.sqrt((p.slopeDeg - 1) / 11), 0, 1);
    var strength = Math.abs(T) * slopeF * windF;
    var mph = strength * 3;
    var toward = T < 0 ? p.aspectDeg : norm(p.aspectDeg + 180);
    var phase = strength < 0.06 ? 'weak' : (T < 0 ? 'falling' : 'rising');
    return {
      index: T, strength: strength, mph: mph, phase: phase, toward: toward, flat: false,
      potential: Math.abs(T) * slopeF * 3, // mph the slope flow would run with no wind
      u: mph * Math.sin(toward * DEG), v: mph * Math.cos(toward * DEG)
    };
  }
  function thermalWords(phase) {
    return phase === 'falling' ? 'sinking downhill' : phase === 'rising' ? 'rising uphill' : 'weak';
  }
  /* ---------- swirl ----------
   * Estimated spots where scent is likely to eddy instead of carrying one way:
   *  fight: slope air (thermals) runs against the part of the wind going along the slope.
   *         Worst when the two are about even; if either is much stronger it just wins.
   *  lee:   the downwind side of a ridge or bluff, where wind rolling over the top curls back.
   * Wind near the ground under trees is taken as about a third of the forecast 10 m wind. */
  var CANOPY = 0.3;
  function swirl(p) {
    var none = { score: 0, kind: null };
    if (p.aspectDeg == null || p.slopeDeg < 2 || !p.th) return none;
    var windTo = norm(p.windFrom + 180), g = CANOPY * p.windMph, fight = 0, lee = 0;
    if (p.th.toward != null && p.th.potential >= 0.3) {
      var a = g * Math.cos((windTo - p.th.toward) * DEG); // wind along the thermal's path (negative = against it)
      if (a < -0.15) {
        var r = -a / p.th.potential;
        fight = clamp(1 - Math.abs(Math.log(r) / Math.LN2) / 1.8, 0, 1) * clamp(p.th.potential / 0.9, 0, 1);
      }
    }
    var d = Math.abs(angDiff(p.aspectDeg, windTo));
    if (d < 70 && p.slopeDeg >= 5 && p.windMph >= 5) {
      lee = Math.sqrt(clamp((p.slopeDeg - 5) / 10, 0, 1)) * clamp((p.windMph - 4) / 8, 0, 1) * (1 - d / 70);
    }
    if (fight < 0.05 && lee < 0.05) return none;
    return fight >= lee ? { score: fight, kind: 'fight' } : { score: lee, kind: 'lee' };
  }

  // Times between a and b (local minutes) when slope air flips direction at this stand.
  function thermalSwitches(stand, fc, a, b) {
    var terr = resolveTerrain(stand), out = [], prev = null;
    for (var t = Math.ceil(a / 10) * 10; t <= b; t += 10) {
      var s = sampleForecast(fc, t);
      var sun = solarPosition(t * 60000 - fc.utcOffsetSec * 1000, stand.lat, stand.lng);
      var sign = heatIndex(terr.slopeDeg, terr.aspectDeg, sun, s.sw, s.cloud) < 0 ? -1 : 1;
      if (prev != null && sign !== prev) out.push({ t: t, to: sign < 0 ? 'falling' : 'rising' });
      prev = sign;
    }
    return out;
  }

  /* ---------- thermal-flow grid ---------- */

  // A grid snapped to fixed ground positions (so cached elevations line up as you pan),
  // covering bounds {s,w,n,e} with one extra ring for slope math. Coarser when zoomed out
  // and stretched further if it would need more than maxPts points.
  function flowGrid(b, zoom, maxPts) {
    // finer when zoomed in: the lidar ground data supports it, and swirl spots need it
    var base = zoom >= 17 ? 45 : zoom >= 16 ? 60 : zoom >= 15 ? 100 : zoom >= 14 ? 180 : 300;
    var lat0 = Math.round((b.s + b.n) / 2 * 10) / 10;
    var spacing = base, dLat, dLng, i0, i1, j0, j1;
    for (var guard = 0; guard < 12; guard++) {
      dLat = spacing / 111320; dLng = spacing / (111320 * Math.cos(lat0 * DEG));
      i0 = Math.floor(b.s / dLat) - 1; i1 = Math.ceil(b.n / dLat) + 1;
      j0 = Math.floor(b.w / dLng) - 1; j1 = Math.ceil(b.e / dLng) + 1;
      if ((i1 - i0 + 1) * (j1 - j0 + 1) <= (maxPts || 420)) break;
      spacing = Math.round(spacing * 1.35);
    }
    var pts = [], rows = i1 - i0 + 1, cols = j1 - j0 + 1;
    for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) pts.push([+(i * dLat).toFixed(5), +(j * dLng).toFixed(5)]);
    return { spacing: spacing, rows: rows, cols: cols, pts: pts, dLat: dLat, dLng: dLng };
  }
  // Slope and facing for every inner grid point that has all four neighbours.
  function flowCells(grid, z) {
    var out = [], R = grid.rows, C = grid.cols;
    function at(i, j) { return z[i * C + j]; }
    for (var i = 1; i < R - 1; i++) for (var j = 1; j < C - 1; j++) {
      var n = at(i + 1, j), s = at(i - 1, j), e = at(i, j + 1), w = at(i, j - 1), c = at(i, j);
      if (n == null || s == null || e == null || w == null || c == null) continue;
      var t = terrainFromSamples(n, e, s, w, grid.spacing);
      // Low spots (hollows, creek bottoms) are where cool air pools after dark.
      var low = c < (n + s + e + w) / 4 - 1.5;
      out.push({ i: i, j: j, lat: grid.pts[i * C + j][0], lng: grid.pts[i * C + j][1], slopeDeg: t.slopeDeg, aspectDeg: t.aspectDeg, elev: c, low: low });
    }
    return out;
  }

  /* ---------- swirl spots across the map ----------
   * Works on the elevation grid (cells from flowCells, with i/j indexes) for one moment in time.
   * The near-ground air at each cell = forecast wind slowed by the trees + slope flow (thermals).
   * A spot scores high where:
   *   balance:  slope air and the wind along the slope are about evenly matched and opposed
   *   collide:  air from neighbouring cells runs together (convergence), as where draining air in a
   *             hollow meets wind pushing up it
   *   turn:     the air field rotates (vorticity), as where flows bend around a point or bench
   *   lee:      just below a crest on the downwind side, where wind rolling over the top curls back
   * Peaks are found over a 5x5 neighbourhood and nudged between cells to where the score is highest,
   * so rings sit on the spot rather than on a grid corner. Estimated, like everything here. */
  function swirlSpots(cells, grid, ctx) {
    var by = {}, s = grid.spacing, smp = ctx.smp;
    cells.forEach(function (c) { by[c.i + ',' + c.j] = c; });
    var gw = toVec(smp.from, CANOPY * smp.speed), windTo = norm(smp.from + 180);
    var calm = clamp(smp.speed / 4, 0.3, 1);
    // pass 1: air vector and the balance / lee scores per cell
    cells.forEach(function (c) {
      var th = thermal({ slopeDeg: c.slopeDeg, aspectDeg: c.aspectDeg, sun: ctx.sun, sw: smp.sw, cloud: smp.cloud, windMph: smp.speed });
      var tm = th.toward != null ? th.potential : 0;
      c._u = gw.u + (tm ? tm * Math.sin(th.toward * DEG) : 0);
      c._v = gw.v + (tm ? tm * Math.cos(th.toward * DEG) : 0);
      var sw = swirl({ slopeDeg: c.slopeDeg, aspectDeg: c.aspectDeg, th: th, windFrom: smp.from, windMph: smp.speed });
      c._bal = sw.kind === 'fight' ? sw.score : 0;
      var lee = sw.kind === 'lee' ? sw.score : 0;
      if (lee > 0) {
        // The eddy hangs right under the crest: walk upwind until the ground stops rising (the crest)
        // and fade the score with distance from it, so the spot lands just over the top, not mid-slope.
        var di = Math.round(Math.cos(smp.from * DEG)), dj = Math.round(Math.sin(smp.from * DEG)), d = 0, cur = c;
        while (d < 6) {
          var up = by[(cur.i + di) + ',' + (cur.j + dj)];
          if (!up || up.elev - cur.elev < 0.5) break;
          cur = up; d++;
        }
        lee *= d === 0 ? 0 : clamp(1 - (d - 1) / 2.5, 0, 1);
      }
      c._lee = lee;
    });
    // pass 2: how the air field turns and collides between neighbours
    cells.forEach(function (c) {
      var n = by[(c.i + 1) + ',' + c.j], so = by[(c.i - 1) + ',' + c.j], e = by[c.i + ',' + (c.j + 1)], w = by[c.i + ',' + (c.j - 1)];
      var turn = 0, collide = 0;
      if (n && so && e && w) {
        var spd = Math.hypot(c._u, c._v) + 0.4;
        var vort = ((e._v - w._v) - (n._u - so._u)) / 2;            // per cell spacing
        var conv = -((e._u - w._u) + (n._v - so._v)) / 2;
        turn = clamp((Math.abs(vort) / spd - 0.35) / 1.1, 0, 1);
        collide = clamp((conv / spd - 0.45) / 1.2, 0, 1) * calm;
      }
      c._score = Math.max(0.9 * c._bal, c._lee, 0.85 * Math.max(turn, collide));
      c._kind = c._score === c._lee && c._lee > 0 ? 'lee' : (c._score === 0.9 * c._bal ? 'fight' : (turn >= collide ? 'turn' : 'collide'));
    });
    // pass 3: peaks, nudged to the best spot between cells. A cell is a peak when nothing within two
    // cells beats it and it stands out from its surroundings; broad even bands get one spot at their middle.
    var out = [], used = {};
    function jit(q) { var h = Math.sin(q.i * 12.9898 + q.j * 78.233) * 43758.5453; return (h - Math.floor(h)) * 1e-4; }
    cells.forEach(function (c) {
      if (c._score < 0.5) return;
      var sum = 0, n = 0;
      for (var a = -2; a <= 2; a++) for (var b = -2; b <= 2; b++) {
        if (!a && !b) continue;
        var o = by[(c.i + a) + ',' + (c.j + b)];
        if (!o) continue;
        if (o._score + jit(o) > c._score + jit(c)) return;   // ties broken by a tiny fixed jitter, so even ridges get evenly spaced spots
        sum += o._score; n++;
      }
      if (n && c._score - sum / n < 0.03) return;      // flat band, handled below
      used[c.i + ',' + c.j] = 1;
      function nudge(m, p) {   // parabola through three scores -> offset of the top, in cells
        if (!m || !p) return 0;
        var d = m._score - 2 * c._score + p._score;
        return d < 0 ? clamp((m._score - p._score) / (2 * d), -0.5, 0.5) : 0;
      }
      var di = nudge(by[(c.i - 1) + ',' + c.j], by[(c.i + 1) + ',' + c.j]);
      var dj = nudge(by[c.i + ',' + (c.j - 1)], by[c.i + ',' + (c.j + 1)]);
      out.push({ lat: c.lat + di * grid.dLat, lng: c.lng + dj * grid.dLng, score: c._score, kind: c._kind, rM: s * (0.22 + 0.12 * c._score) });
    });
    // even bands (a whole hillside about equally matched): one spot at the middle of each band
    var seen = {};
    cells.forEach(function (c) {
      var k0 = c.i + ',' + c.j;
      if (c._score < 0.6 || seen[k0]) return;
      var stack = [c], members = [], top = 0; seen[k0] = 1;
      while (stack.length) {
        var q = stack.pop(); members.push(q); if (q._score > top) top = q._score;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dd) {
          var k = (q.i + dd[0]) + ',' + (q.j + dd[1]), o = by[k];
          if (o && !seen[k] && o._score >= 0.6 && Math.abs(o._score - c._score) < 0.08) { seen[k] = 1; stack.push(o); }
        });
      }
      if (members.length < 3 || members.some(function (m) { return used[m.i + ',' + m.j]; })) return;
      var la = 0, lo = 0; members.forEach(function (m) { la += m.lat; lo += m.lng; });
      la /= members.length; lo /= members.length;
      // snap to the member nearest the middle so the ring sits on ground that is really in the band
      var best = members.reduce(function (b, m) { return Math.hypot(m.lat - la, m.lng - lo) < Math.hypot(b.lat - la, b.lng - lo) ? m : b; });
      out.push({ lat: best.lat, lng: best.lng, score: top, kind: best._kind, rM: s * (0.22 + 0.12 * top), band: members.length });
    });
    return out;
  }

  /* ---------- benches ----------
   * A bench is a strip of flatter ground part-way up a hillside, with steeper ground above and below it.
   * Works on a square grid of ground elevations (meters), row 0 at the north edge, `cellM` meters per cell.
   * For each flat-enough cell it looks up and down the fall line of the surrounding hillside: there must be
   * clearly steeper ground both ways, with real climb above and real drop below, which rules out ridge tops,
   * flats and creek bottoms. Connected cells become one bench; scraps too small to matter are dropped.
   * An estimate from the shape of the ground only. Thresholds are in BENCH and can be passed in to tune. */
  // Set for rolling Ozark-border hills (most slopes around Stockton Lake are under 15 degrees), not mountains.
  var BENCH = {
    flatMax: 6,      // degrees: a bench is no steeper than this
    steepMin: 8,     // degrees: the ground above and below must reach at least this
    contrast: 4,     // degrees: ...and be at least this much steeper than the bench
    ratio: 0.5,      // the bench is at most this share of the steeper ground's slope
    hillMin: 4,      // degrees: the broad hillside the bench sits on must slope at least this
    probeM: 45,      // meters: how far up and down the hill to look
    reliefM: 2,      // meters: least climb above and drop below within that distance
    broadM: 30,      // meters: smoothing radius that defines "the hillside"
    minAreaM2: 250,  // drop patches smaller than this
    minLenM: 25      // ...or shorter than this from end to end
  };
  // Mean of each cell's (2r+1) square window. NaN where the window leaves the grid or touches missing data.
  function boxMean(z, rows, cols, r) {
    var W = cols + 1, sum = new Float64Array((rows + 1) * W), bad = new Int32Array((rows + 1) * W), i, j;
    for (i = 0; i < rows; i++) {
      var rs = 0, rb = 0;
      for (j = 0; j < cols; j++) {
        var v = z[i * cols + j];
        if (v === v) rs += v; else rb++;
        sum[(i + 1) * W + j + 1] = sum[i * W + j + 1] + rs;
        bad[(i + 1) * W + j + 1] = bad[i * W + j + 1] + rb;
      }
    }
    var out = new Float32Array(rows * cols).fill(NaN), n = (2 * r + 1) * (2 * r + 1);
    for (i = r; i < rows - r; i++) for (j = r; j < cols - r; j++) {
      var a = (i - r) * W + (j - r), b = (i - r) * W + (j + r + 1), c = (i + r + 1) * W + (j - r), d = (i + r + 1) * W + (j + r + 1);
      if (bad[d] - bad[b] - bad[c] + bad[a]) continue;
      out[i * cols + j] = (sum[d] - sum[b] - sum[c] + sum[a]) / n;
    }
    return out;
  }
  function findBenches(z, rows, cols, cellM, opts) {
    var o = {}, k;
    for (k in BENCH) o[k] = opts && opts[k] != null ? opts[k] : BENCH[k];
    var n = rows * cols, i, j, idx;
    var zs = boxMean(z, rows, cols, 1);                       // light smoothing: takes the lidar chatter out
    var slope = new Float32Array(n).fill(NaN);
    for (i = 1; i < rows - 1; i++) for (j = 1; j < cols - 1; j++) {
      idx = i * cols + j;
      var gx = (zs[idx + 1] - zs[idx - 1]) / (2 * cellM), gy = (zs[idx - cols] - zs[idx + cols]) / (2 * cellM);
      slope[idx] = Math.atan(Math.hypot(gx, gy)) / DEG;       // NaN if any neighbour is missing
    }
    var rb = Math.max(2, Math.round(o.broadM / cellM)), kb = Math.max(1, Math.round(o.broadM / 2 / cellM));
    var zb = boxMean(z, rows, cols, rb);                      // the hillside with its small wrinkles ironed out
    var steps = Math.max(2, Math.round(o.probeM / cellM)), hillMin = Math.tan(o.hillMin * DEG);
    var cand = new Uint8Array(n);
    // steepest ground met walking `steps` cells from (i, j) along (di, dj), and the height change at the far end
    function probe(i0, j0, di, dj) {
      var mx = 0, r = 0, c = 0;
      for (var t = 1; t <= steps; t++) {
        r = Math.round(i0 + di * t); c = Math.round(j0 + dj * t);
        if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
        var s = slope[r * cols + c];
        if (s !== s) return null;
        if (s > mx) mx = s;
      }
      return { max: mx, dz: zs[r * cols + c] - zs[i0 * cols + j0] };
    }
    for (i = kb; i < rows - kb; i++) for (j = kb; j < cols - kb; j++) {
      idx = i * cols + j;
      var s0 = slope[idx];
      if (!(s0 <= o.flatMax)) continue;
      var bx = (zb[idx + kb] - zb[idx - kb]) / (2 * kb * cellM), by = (zb[idx - kb * cols] - zb[idx + kb * cols]) / (2 * kb * cellM);
      var gm = Math.hypot(bx, by);
      if (!(gm >= hillMin)) continue;                         // not on a hillside (or no data)
      var ux = bx / gm, uy = by / gm;                         // unit vector pointing uphill (east, north)
      var need = Math.max(o.steepMin, s0 + o.contrast);
      var up = probe(i, j, -uy, ux);
      if (!up || up.max < need || up.dz < o.reliefM) continue;
      var dn = probe(i, j, uy, -ux);
      if (!dn || dn.max < need || -dn.dz < o.reliefM) continue;
      if (s0 > o.ratio * Math.min(up.max, dn.max)) continue;
      cand[idx] = 1;
    }
    // join touching cells into benches and drop the scraps
    var mask = new Uint8Array(n), seen = new Uint8Array(n), stack = new Int32Array(n), benches = [];
    for (var start = 0; start < n; start++) {
      if (!cand[start] || seen[start]) continue;
      var top = 0, members = [], r0 = rows, r1 = -1, c0 = cols, c1 = -1, zsum = 0;
      stack[top++] = start; seen[start] = 1;
      while (top) {
        var q = stack[--top], qi = (q / cols) | 0, qj = q - qi * cols;
        members.push(q); zsum += zs[q];
        if (qi < r0) r0 = qi; if (qi > r1) r1 = qi; if (qj < c0) c0 = qj; if (qj > c1) c1 = qj;
        for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) {
          var ni = qi + a, nj = qj + b;
          if ((!a && !b) || ni < 0 || nj < 0 || ni >= rows || nj >= cols) continue;
          var nq = ni * cols + nj;
          if (cand[nq] && !seen[nq]) { seen[nq] = 1; stack[top++] = nq; }
        }
      }
      var area = members.length * cellM * cellM, len = Math.hypot(r1 - r0 + 1, c1 - c0 + 1) * cellM;
      if (area < o.minAreaM2 || len < o.minLenM) continue;
      for (k = 0; k < members.length; k++) mask[members[k]] = 1;
      benches.push({ cells: members.length, areaM2: area, lenM: len, row: (r0 + r1) / 2, col: (c0 + c1) / 2, elevM: zsum / members.length });
    }
    return { mask: mask, benches: benches, rows: rows, cols: cols };
  }

  /* Ground-elevation tiles for the bench layer: standard web-map tiles at one fixed zoom, 256 cells a side,
   * so the same squares are asked for every time and can be kept for use with no signal.
   * Returns the block of tiles covering bounds {s,w,n,e} plus a margin, or null if that is too many tiles. */
  var DEM_ZOOM = 15, DEM_PX = 256;
  function demTiles(b, padM, maxTiles) {
    var n = Math.pow(2, DEM_ZOOM), pad = (padM || 0) / 111320, mid = (b.s + b.n) / 2;
    var padLng = pad / Math.cos(mid * DEG);
    function tx(lng) { return Math.floor((lng + 180) / 360 * n); }
    function ty(lat) { var r = lat * DEG; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); }
    function lat(y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / DEG; }
    function lng(x) { return x / n * 360 - 180; }
    var x0 = tx(b.w - padLng), x1 = tx(b.e + padLng), y0 = ty(b.n + pad), y1 = ty(b.s - pad);
    var nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    if (nx < 1 || ny < 1 || nx * ny > (maxTiles || 12)) return null;
    return {
      z: DEM_ZOOM, x0: x0, y0: y0, nx: nx, ny: ny, px: DEM_PX, cols: nx * DEM_PX, rows: ny * DEM_PX,
      bounds: { n: lat(y0), s: lat(y1 + 1), w: lng(x0), e: lng(x1 + 1) },
      cellM: 40075016.686 / n / DEM_PX * Math.cos(mid * DEG)   // ground size of one cell at this latitude
    };
  }

  /* ---------- forecast ---------- */

  function fillNulls(a, fallback) {
    var out = new Array(a.length), last = fallback;
    for (var i = 0; i < a.length; i++) {
      if (a[i] == null || isNaN(a[i])) out[i] = last; else { out[i] = a[i]; last = a[i]; }
    }
    return out;
  }
  // Open-Meteo hourly block -> compact object the rest of the engine uses.
  function normalizeForecast(raw) {
    var h = raw.hourly, d = raw.daily;
    return {
      utcOffsetSec: raw.utc_offset_seconds | 0,
      t: h.time.map(parseLocalMin),
      temp: fillNulls(h.temperature_2m, 60),
      precip: fillNulls(h.precipitation_probability || h.time.map(function () { return 0; }), 0),
      cloud: fillNulls(h.cloud_cover, 50),
      speed: fillNulls(h.wind_speed_10m, 0),
      dir: fillNulls(h.wind_direction_10m, 0),
      gust: fillNulls(h.wind_gusts_10m, 0),
      sw: fillNulls(h.shortwave_radiation, 0),
      daily: d.time.map(function (day, i) {
        return { date: day, sunrise: parseLocalMin(d.sunrise[i]), sunset: parseLocalMin(d.sunset[i]) };
      })
    };
  }
  function sampleForecast(fc, tMin) {
    var t = fc.t, n = t.length, i;
    if (tMin <= t[0]) i = 0;
    else if (tMin >= t[n - 1]) i = n - 2;
    else {
      i = Math.max(0, Math.min(n - 2, Math.floor((tMin - t[0]) / 60)));
      while (i < n - 2 && t[i + 1] <= tMin) i++;
      while (i > 0 && t[i] > tMin) i--;
    }
    var f = clamp((tMin - t[i]) / (t[i + 1] - t[i]), 0, 1);
    function lerp(a) { return a[i] + (a[i + 1] - a[i]) * f; }
    var a = toVec(fc.dir[i], fc.speed[i]), b = toVec(fc.dir[i + 1], fc.speed[i + 1]);
    var u = a.u + (b.u - a.u) * f, v = a.v + (b.v - a.v) * f;
    var w = fromVec(u, v);
    return {
      t: tMin, u: u, v: v, speed: w.speed,
      from: w.speed < 0.05 ? fc.dir[i] : w.from,
      gust: lerp(fc.gust), cloud: lerp(fc.cloud), sw: lerp(fc.sw), precip: lerp(fc.precip), temp: lerp(fc.temp)
    };
  }
  function nowMinFor(fc, nowMs) {
    return Math.floor(((nowMs == null ? Date.now() : nowMs) / 1000 + fc.utcOffsetSec) / 60);
  }

  /* ---------- wind rating for a stand ---------- */

  var RATE = { good: 1, ok: 0.5, bad: 0 };
  function windRating(winds, from) {
    var p = norm(from) / 45, i0 = Math.floor(p) % 8, i1 = (i0 + 1) % 8, fr = p - Math.floor(p);
    function val(k) {
      var s = winds && winds[SECTORS[k]];
      return RATE[s] != null ? RATE[s] : 0.5;
    }
    return val(i0) * (1 - fr) + val(i1) * fr;
  }
  function isConfigured(winds) {
    if (!winds) return false;
    for (var k in winds) if (winds[k] === 'good' || winds[k] === 'bad') return true;
    return false;
  }
  function ratingClass(r) { return r >= 0.75 ? 'good' : (r >= 0.35 ? 'ok' : 'bad'); }

  /* ---------- state of one stand at one moment ---------- */

  function stateAt(stand, fc, tMin) {
    var s = sampleForecast(fc, tMin);
    var sun = solarPosition(tMin * 60000 - fc.utcOffsetSec * 1000, stand.lat, stand.lng);
    var terr = resolveTerrain(stand);
    var th = thermal({
      slopeDeg: terr.slopeDeg, aspectDeg: terr.aspectDeg, sun: sun,
      sw: s.sw, cloud: s.cloud, windMph: s.speed
    });
    var sw = swirl({ slopeDeg: terr.slopeDeg, aspectDeg: terr.aspectDeg, th: th, windFrom: s.from, windMph: s.speed });
    var eff = fromVec(s.u + th.u, s.v + th.v);
    var effFrom = eff.speed < 0.2 ? s.from : eff.from;
    var raw = windRating(stand.winds, effFrom);
    var conf = clamp(eff.speed / 2.5, 0.35, 1); // direction is shaky when the air barely moves
    return {
      t: tMin, sun: sun, isDay: sun.elev > -0.833,
      syn: { from: s.from, speed: s.speed, gust: s.gust },
      thermal: th, swirl: sw,
      eff: { from: effFrom, speed: eff.speed },
      rating: 0.5 + (raw - 0.5) * conf,
      precip: s.precip, cloud: s.cloud, temp: s.temp
    };
  }

  /* ---------- sit windows ---------- */

  function sitWindowFor(fc, date, kind) {
    var d = null;
    for (var i = 0; i < fc.daily.length; i++) if (fc.daily[i].date === date) d = fc.daily[i];
    if (!d) return null;
    return kind === 'AM'
      ? { start: d.sunrise - 30, end: d.sunrise + 150 }
      : { start: d.sunset - 180, end: d.sunset + 15 };
  }
  function sitLabel(date, kind, today) {
    var diff = dayDiff(today, date);
    if (diff === 0) return kind === 'AM' ? 'This morning' : 'Tonight';
    if (diff === 1) return kind === 'AM' ? 'Tomorrow AM' : 'Tomorrow PM';
    var dow = DOW[new Date(date + 'T00:00:00Z').getUTCDay()];
    return dow + ' ' + kind;
  }
  function listSits(fc, nowMin, max) {
    var out = [], today = dateKey(nowMin);
    for (var i = 0; i < fc.daily.length; i++) {
      var day = fc.daily[i];
      ['AM', 'PM'].forEach(function (kind) {
        var w = sitWindowFor(fc, day.date, kind);
        if (!w || w.end <= nowMin) return;
        out.push({
          id: day.date + '|' + kind, date: day.date, kind: kind,
          start: Math.max(w.start, nowMin), end: w.end, inProgress: w.start < nowMin,
          label: sitLabel(day.date, kind, today)
        });
      });
    }
    return out.slice(0, max || 6);
  }
  function windowForStand(fc, sit, nowMin) {
    var w = sitWindowFor(fc, sit.date, sit.kind);
    if (!w) return null;
    return { start: Math.max(w.start, nowMin), end: Math.max(w.end, Math.max(w.start, nowMin) + 20) };
  }

  /* ---------- scoring ---------- */

  function speedScore(mph) {
    if (mph < 1) return 0.25;
    if (mph < 3) return 0.25 + (mph - 1) / 2 * 0.35;
    if (mph <= 12) return 1;
    if (mph <= 18) return 1 - (mph - 12) / 6 * 0.5;
    return Math.max(0.1, 0.5 - (mph - 18) / 10 * 0.4);
  }
  function scoreLabel(score) {
    if (score >= 80) return { text: 'Prime', cls: 'good' };
    if (score >= 65) return { text: 'Good', cls: 'good' };
    if (score >= 45) return { text: 'Marginal', cls: 'ok' };
    return { text: 'Skip', cls: 'bad' };
  }
  function daysSinceHunted(stand, nowMin) {
    var sits = stand.sits || [];
    if (!sits.length) return null;
    var last = sits[sits.length - 1].date;
    return dayDiff(last, dateKey(nowMin));
  }

  function evaluateSit(stand, fc, win, nowMin) {
    var samples = [], t;
    for (t = win.start; t <= win.end + 0.001; t += 20) samples.push(stateAt(stand, fc, t));
    var configured = isConfigured(stand.winds);
    var ratings = samples.map(function (s) { return s.rating; });
    var dirMean = mean(ratings), dirMin = Math.min.apply(null, ratings);
    var dirScore = 0.65 * dirMean + 0.35 * dirMin;

    var cs = 0, sn = 0;
    samples.forEach(function (s) { cs += Math.cos(s.eff.from * DEG); sn += Math.sin(s.eff.from * DEG); });
    var R = Math.hypot(cs / samples.length, sn / samples.length);
    var steady = clamp((R - 0.55) / 0.4, 0, 1);
    var meanFrom = norm(Math.atan2(sn, cs) / DEG);

    var effSpeed = mean(samples.map(function (s) { return s.eff.speed; }));
    var synSpeed = mean(samples.map(function (s) { return s.syn.speed; }));
    var maxGust = Math.max.apply(null, samples.map(function (s) { return s.syn.gust; }));
    var spd = speedScore(effSpeed);
    if (maxGust > 25) spd = Math.max(0.1, spd - clamp((maxGust - 25) / 20, 0, 0.4));

    var precipMax = Math.max.apply(null, samples.map(function (s) { return s.precip; }));
    var cond = 1 - 0.7 * clamp((precipMax - 20) / 70, 0, 1);

    var days = daysSinceHunted(stand, nowMin);
    var pressure = days == null ? 0 : (days <= 1 ? 0.18 : days <= 2 ? 0.12 : days <= 4 ? 0.06 : 0);

    var swirlHits = samples.filter(function (s) { return s.swirl.score >= 0.5; });
    var swirlFrac = swirlHits.length / samples.length;
    var swirlPen = 0.10 * swirlFrac;
    var score = 100 * clamp(0.60 * dirScore + 0.15 * steady + 0.15 * spd + 0.10 * cond - pressure - swirlPen, 0, 1);
    score = Math.round(score);

    var thStrength = mean(samples.map(function (s) { return s.thermal.strength; }));
    var thIndex = mean(samples.map(function (s) { return s.thermal.index; }));
    var thToward = null;
    for (var i = 0; i < samples.length; i++) if (samples[i].thermal.toward != null) { thToward = samples[i].thermal.toward; break; }
    var thPhase = thStrength < 0.06 ? 'weak' : (thIndex < 0 ? 'falling' : 'rising');
    var flips = thermalSwitches(stand, fc, win.start, win.end);

    var reasons = [];
    var dirName = compass(meanFrom), spdTxt = Math.round(effSpeed);
    if (dirMean >= 0.75) reasons.push({ kind: 'good', text: (steady > 0.7 ? 'Steady ' : 'Mostly ') + dirName + ' wind, ' + spdTxt + ' mph. A good wind for this stand.' });
    else if (dirMean >= 0.4) reasons.push({ kind: 'info', text: dirName + ' wind, ' + spdTxt + ' mph. Workable here, not ideal.' });
    else reasons.push({ kind: 'bad', text: dirName + ' wind, ' + spdTxt + ' mph. A bad wind for this stand.' });

    if (dirMean >= 0.4 || dirMin < 0.3) {
      for (var j = 1; j < samples.length; j++) {
        if (samples[j].rating < 0.3 && samples[0].rating >= 0.3) {
          reasons.push({ kind: 'bad', text: 'Wind turns to the ' + compass(samples[j].eff.from) + ' around ' + fmtClock(samples[j].t) + '. That is a bad wind here.' });
          break;
        }
      }
    }
    if (flips.length) {
      var f = flips[flips.length - 1];
      reasons.push({
        kind: f.to === 'falling' ? 'warn' : 'info',
        text: 'Thermals flip to ' + thermalWords(f.to) + ' about ' + fmtClock(f.t) + ' (estimated).' +
          (thToward != null && f.to === 'falling' ? ' After that your scent slides toward the ' + compass(samples[samples.length - 1].thermal.toward || thToward) + '.' : '')
      });
    } else if (thStrength >= 0.12 && thToward != null) {
      reasons.push({
        kind: thPhase === 'falling' ? 'warn' : 'info',
        text: 'Thermals ' + thermalWords(thPhase) + ' (estimated). Scent drifts toward the ' + compass(thToward) + ' along the slope.'
      });
    }
    if (swirlHits.length) {
      var s0 = swirlHits[0], kindFight = swirlHits.filter(function (x) { return x.swirl.kind === 'fight'; }).length >= swirlHits.length / 2;
      var when = swirlFrac > 0.85 ? 'through most of the sit' : 'from about ' + fmtClock(s0.t);
      var sinking = s0.thermal.index < 0;
      reasons.push({ kind: 'warn', text: kindFight
        ? 'Swirl likely ' + when + ': thermals ' + (sinking ? 'sinking downhill' : 'rising uphill') + ' push against the ' + compass(s0.syn.from) +
          ' wind coming ' + (sinking ? 'up' : 'down') + ' the slope (estimated).'
        : 'Swirl likely ' + when + ': this spot sits on the downwind side of the slope, where the ' + compass(s0.syn.from) + ' wind curls back (estimated).' });
    }
    if (effSpeed < 3) reasons.push({ kind: 'warn', text: 'Very light air. Scent pools and swirls, so direction is less reliable.' });
    if (maxGust > 25) reasons.push({ kind: 'warn', text: 'Gusts to ' + Math.round(maxGust) + ' mph.' });
    if (precipMax >= 50) reasons.push({ kind: 'warn', text: Math.round(precipMax) + '% chance of rain.' });
    if (days != null && days <= 4) reasons.push({ kind: 'warn', text: 'Hunted ' + (days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago') + '. Deer may be pressured.' });
    if (!configured) reasons.push({ kind: 'info', text: 'Mark this stand\'s good and bad winds to get a real ranking.' });

    return {
      score: score, label: scoreLabel(score), configured: configured,
      parts: { wind: dirScore, steady: steady, speed: spd, conditions: cond, pressure: pressure, swirl: swirlFrac },
      summary: {
        from: meanFrom, speed: effSpeed, synSpeed: synSpeed, gust: maxGust, precipMax: precipMax,
        thermalPhase: thPhase, thermalStrength: thStrength, thermalToward: thToward, thermalFlips: flips, swirlFrac: swirlFrac, swirlFrom: swirlHits.length ? swirlHits[0].t : null, daysSince: days
      },
      reasons: reasons, samples: samples
    };
  }

  /* ---------- map geometry ---------- */

  // Scent cone: where scent travels from the stand. Narrows and lengthens as the wind picks up;
  // in near-calm air it becomes a small round puddle.
  function coneRing(lat, lng, toDeg, speed) {
    var ring = [];
    if (speed < 1.5) {
      for (var a = 0; a < 360; a += 20) ring.push(offsetLatLng(lat, lng, a, 55));
      return ring;
    }
    var len = clamp(55 + speed * 30, 55, 420);
    var half = clamp(38 - speed * 2.2, 10, 38);
    ring.push([lat, lng]);
    var steps = 2 * Math.max(1, Math.ceil(half / 6)); // even, so one point sits exactly on the wind line
    for (var k = 0; k <= steps; k++) ring.push(offsetLatLng(lat, lng, toDeg - half + (2 * half * k) / steps, len));
    return ring;
  }
  function arrowShape(lat, lng, toDeg, lengthM, headM) {
    var tip = offsetLatLng(lat, lng, toDeg, lengthM);
    var hl = headM || Math.max(10, lengthM * 0.28);
    return {
      shaft: [[lat, lng], tip],
      head: [tip, offsetLatLng(tip[0], tip[1], toDeg + 180 - 28, hl), offsetLatLng(tip[0], tip[1], toDeg + 180 + 28, hl)]
    };
  }

  return {
    SECTORS: SECTORS, DEG: DEG,
    clamp: clamp, norm: norm, angDiff: angDiff, mean: mean, compass: compass,
    toVec: toVec, fromVec: fromVec, distanceM: distanceM, yards: yards, fmtYards: fmtYards,
    parseLocalMin: parseLocalMin, dateKey: dateKey, fmtClock: fmtClock, fmtDayClock: fmtDayClock, fmtHour: fmtHour, dayDiff: dayDiff,
    solarPosition: solarPosition,
    terrainFromSamples: terrainFromSamples, terrainProbePoints: terrainProbePoints, offsetLatLng: offsetLatLng, resolveTerrain: resolveTerrain,
    flowGrid: flowGrid, flowCells: flowCells,
    findBenches: findBenches, demTiles: demTiles, BENCH: BENCH,
    thermal: thermal, swirl: swirl, swirlSpots: swirlSpots, heatIndex: heatIndex, thermalWords: thermalWords, thermalSwitches: thermalSwitches,
    normalizeForecast: normalizeForecast, sampleForecast: sampleForecast, nowMinFor: nowMinFor,
    windRating: windRating, isConfigured: isConfigured, ratingClass: ratingClass,
    stateAt: stateAt,
    sitWindowFor: sitWindowFor, listSits: listSits, windowForStand: windowForStand,
    scoreLabel: scoreLabel, evaluateSit: evaluateSit,
    coneRing: coneRing, arrowShape: arrowShape
  };
});
