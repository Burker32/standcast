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
  // Checked against two known spots in Brush Creek Conservation Area: the bed of S 7th Rd (a 20 ft wide flat cut
  // into the hill) and a subtle bench at 37.8096, -93.6250 that only eases to about 7 degrees between 10 and 12.
  var BENCH = {
    flatMax: 8,      // degrees: a bench is no steeper than this
    steepMin: 8,     // degrees: the ground above and below must reach at least this
    contrast: 2.5,   // degrees: ...and be at least this much steeper than the bench
    ratio: 0.72,     // the bench is at most this share of the steeper ground's slope
    hillMin: 4,      // degrees: the broad hillside the bench sits on must slope at least this
    probeM: 45,      // meters: how far up and down the hill to look
    reliefM: 2,      // meters: least climb above and drop below within that distance
    smoothM: 4,      // meters: smoothing radius that takes out lidar chatter (never less than one cell)
    broadM: 30,      // meters: smoothing radius that defines "the hillside"
    grow: 1.2,    // how much easier the test is for cells touching a certain bench cell (1 = no growing)
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
    var zs = boxMean(z, rows, cols, Math.max(1, Math.round(o.smoothM / cellM)));   // light smoothing: takes the lidar chatter out
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
    // Two passes of the same test. Cells that pass the strict one are certain bench; cells that pass only the
    // easier one count when they touch a certain cell. That lets a bench that wraps around a hill show as one
    // strip even where it narrows or tilts a little, without the easier test adding benches of its own.
    var easy = { flatMax: o.flatMax * o.grow, steepMin: o.steepMin / o.grow, contrast: o.contrast / (o.grow * o.grow), ratio: Math.min(0.75, o.ratio * o.grow), reliefM: o.reliefM / o.grow };
    for (i = kb; i < rows - kb; i++) for (j = kb; j < cols - kb; j++) {
      idx = i * cols + j;
      var s0 = slope[idx];
      if (!(s0 <= easy.flatMax)) continue;
      var bx = (zb[idx + kb] - zb[idx - kb]) / (2 * kb * cellM), by = (zb[idx - kb * cols] - zb[idx + kb * cols]) / (2 * kb * cellM);
      var gm = Math.hypot(bx, by);
      if (!(gm >= hillMin)) continue;                         // not on a hillside (or no data)
      var ux = bx / gm, uy = by / gm;                         // unit vector pointing uphill (east, north)
      var up = probe(i, j, -uy, ux);
      if (!up) continue;
      var dn = probe(i, j, uy, -ux);
      if (!dn) continue;
      var steep = Math.min(up.max, dn.max), relief = Math.min(up.dz, -dn.dz);
      if (s0 <= o.flatMax && steep >= Math.max(o.steepMin, s0 + o.contrast) && relief >= o.reliefM && s0 <= o.ratio * steep) cand[idx] = 2;
      else if (steep >= Math.max(easy.steepMin, s0 + easy.contrast) && relief >= easy.reliefM && s0 <= easy.ratio * steep) cand[idx] = 1;
    }
    // join touching cells into benches and drop the scraps
    var mask = new Uint8Array(n), seen = new Uint8Array(n), stack = new Int32Array(n), benches = [];
    for (var start = 0; start < n; start++) {
      if (cand[start] !== 2 || seen[start]) continue;         // every bench starts from a certain cell
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

  /* ---------- saddles and funnels ----------
   * Point features from the same kind of elevation grid as benches (row 0 north, `cellM` meters a cell, about 4 m).
   *  saddle: a low gap in a ridge. Walk a circle around the spot and the ground goes up, down, up, down: higher
   *          both ways along the ridge, lower both ways off it. depthM is the smallest of those four changes.
   *  funnel: a pinch of walkable ground squeezed between two obstacles (steep slopes or water) that are close
   *          together across it, while it stays open for a good way along it. widthM is the gap at its narrowest.
   * Only the strongest few are returned, spaced apart, so the map stays readable. Estimates from ground shape. */
  var SPOTS = {
    saddleRadiiM: [50, 90],   // circles walked around each spot
    saddleNoiseM: 1.2,        // height change smaller than this counts as level
    saddleMinM: 2.5,          // each of the four rises and falls must be at least this
    saddleGapM: 130,          // keep saddles at least this far apart
    hardDeg: 13,              // slopes this steep (or water) are the obstacles a funnel squeezes between
    minHardM2: 500,           // ignore obstacles smaller than this (a cut bank, a boulder pile)
    minWidthM: 18,            // narrower than this is a ditch or creek channel, not ground deer travel along
    maxWidthM: 55,            // widest gap that still counts as a funnel
    minRunM: 55,              // it must stay open at least this far both ways along the corridor
    funnelGapM: 120,          // keep funnels at least this far apart
    maxEach: 10               // strongest few of each kind
  };
  function findSpots(z, rows, cols, cellM, opts) {
    var o = {}, k;
    for (k in SPOTS) o[k] = opts && opts[k] != null ? opts[k] : SPOTS[k];
    var n = rows * cols, i, j, idx, out = { saddles: [], funnels: [] };

    /* saddles */
    var zb = boxMean(z, rows, cols, Math.max(1, Math.round(8 / cellM)));   // broad shape only
    var NA = 24, rings = o.saddleRadiiM.map(function (R) {
      var pts = [];
      for (var a = 0; a < NA; a++) { var t = a / NA * 2 * Math.PI; pts.push(Math.round(-Math.cos(t) * R / cellM), Math.round(Math.sin(t) * R / cellM)); }
      return pts;
    });
    var margin = Math.ceil(Math.max.apply(null, o.saddleRadiiM) / cellM) + 1, cands = [], dz = new Float32Array(NA), lab = new Int8Array(NA);
    var stride = Math.max(1, Math.round(8 / cellM));           // saddles are broad: every other cell is plenty
    for (i = margin; i < rows - margin; i += stride) for (j = margin; j < cols - margin; j += stride) {
      var c0 = zb[i * cols + j];
      if (c0 !== c0) continue;
      var best = 0, bestAxis = 0;
      for (var ri = 0; ri < rings.length; ri++) {
        var pts = rings[ri], ok = true, nz = 0, a;
        for (a = 0; a < NA; a++) {
          var v = zb[(i + pts[2 * a]) * cols + j + pts[2 * a + 1]] - c0;
          if (v !== v) { ok = false; break; }
          dz[a] = v; lab[a] = v > o.saddleNoiseM ? 1 : v < -o.saddleNoiseM ? -1 : 0;
          if (lab[a]) nz++;
        }
        if (!ok || nz < 8) continue;
        // start on a change of sign so each run of ups or downs is read whole
        var s0 = -1, prev = 0;
        for (a = NA - 1; a >= 0; a--) if (lab[a]) { prev = lab[a]; break; }
        for (a = 0; a < NA; a++) if (lab[a]) { if (lab[a] !== prev) { s0 = a; break; } prev = lab[a]; }
        if (s0 < 0) continue;
        var runs = [], cur = null;
        for (var q = 0; q < NA; q++) {
          a = (s0 + q) % NA;
          if (!lab[a]) continue;
          if (!cur || cur.sign !== lab[a]) { cur = { sign: lab[a], peak: 0, at: a }; runs.push(cur); }
          if (Math.abs(dz[a]) > cur.peak) { cur.peak = Math.abs(dz[a]); cur.at = a; }
        }
        if (runs.length !== 4) continue;                       // up, down, up, down and nothing else
        var depth = Math.min(runs[0].peak, runs[1].peak, runs[2].peak, runs[3].peak);
        if (depth < o.saddleMinM || depth <= best) continue;
        // the two rises should be roughly across from each other, and so should the two falls
        var apart = function (r1, r2) { var d = Math.abs(r1.at - r2.at); return Math.min(d, NA - d) / NA * 360; };
        if (apart(runs[0], runs[2]) < 100 || apart(runs[1], runs[3]) < 100) continue;
        best = depth;
        var up = runs[0].sign > 0 ? runs[0] : runs[1];
        bestAxis = norm(up.at / NA * 360) % 180;               // which way the ridge runs through the gap
      }
      if (best) cands.push({ row: i, col: j, depthM: best, axisDeg: bestAxis, elevM: c0 });
    }
    function spaced(list, gapM, better) {
      list.sort(better);
      var kept = [], g2 = (gapM / cellM) * (gapM / cellM);
      for (var a = 0; a < list.length && kept.length < o.maxEach; a++) {
        var p = list[a], clash = false;
        for (var b = 0; b < kept.length; b++) { var dr = p.row - kept[b].row, dc = p.col - kept[b].col; if (dr * dr + dc * dc < g2) { clash = true; break; } }
        if (!clash) kept.push(p);
      }
      return kept;
    }
    out.saddles = spaced(cands, o.saddleGapM, function (a, b) { return b.depthM - a.depthM; });

    /* funnels */
    var zs = boxMean(z, rows, cols, 1), hard = new Uint8Array(n), tanHard = Math.tan(o.hardDeg * DEG);
    for (i = 1; i < rows - 1; i++) for (j = 1; j < cols - 1; j++) {
      idx = i * cols + j;
      var gx = (zs[idx + 1] - zs[idx - 1]) / (2 * cellM), gy = (zs[idx - cols] - zs[idx + cols]) / (2 * cellM), g = Math.hypot(gx, gy);
      if (g !== g || g >= tanHard) { hard[idx] = g !== g ? 3 : 1; continue; }
      // lidar water is drawn dead level: a patch of cells at exactly one height
      var lo = z[idx], hi = z[idx];
      for (var a2 = -1; a2 <= 1; a2++) for (var b2 = -1; b2 <= 1; b2++) { var w = z[idx + a2 * cols + b2]; if (w < lo) lo = w; if (w > hi) hi = w; }
      if (hi - lo < 0.02) hard[idx] = 2;
    }
    // small obstacles do not turn deer: drop them
    var seen = new Uint8Array(n), stack = new Int32Array(n), minCells = o.minHardM2 / (cellM * cellM);
    for (var st = 0; st < n; st++) {
      if (!hard[st] || hard[st] === 3 || seen[st]) continue;
      var top = 0, mem = [];
      stack[top++] = st; seen[st] = 1;
      while (top) {
        var p0 = stack[--top], pi = (p0 / cols) | 0, pj = p0 - pi * cols; mem.push(p0);
        for (var da = -1; da <= 1; da++) for (var db = -1; db <= 1; db++) {
          var ni = pi + da, nj = pj + db;
          if ((!da && !db) || ni < 0 || nj < 0 || ni >= rows || nj >= cols) continue;
          var nq = ni * cols + nj;
          if (hard[nq] && hard[nq] !== 3 && !seen[nq]) { seen[nq] = 1; stack[top++] = nq; }
        }
      }
      if (mem.length < minCells) for (k = 0; k < mem.length; k++) hard[mem[k]] = 0;
    }
    // steps to the nearest obstacle in each of 8 directions (255 = none in reach; grid edges and gaps count as none)
    var DI = [-1, -1, 0, 1, 1, 1, 0, -1], DJ = [0, 1, 1, 1, 0, -1, -1, -1], dist = [];
    for (var dir = 0; dir < 8; dir++) {
      var D = new Uint8Array(n).fill(255), di = DI[dir], dj = DJ[dir];
      var iA = di > 0 ? rows - 1 : 0, iB = di > 0 ? -1 : rows, iS = di > 0 ? -1 : 1;
      var jA = dj > 0 ? cols - 1 : 0, jB = dj > 0 ? -1 : cols, jS = dj > 0 ? -1 : 1;
      for (i = iA; i !== iB; i += iS) for (j = jA; j !== jB; j += jS) {
        idx = i * cols + j;
        if (hard[idx] === 1 || hard[idx] === 2) { D[idx] = 0; continue; }
        var ti = i + di, tj = j + dj;
        if (hard[idx] === 3 || ti < 0 || tj < 0 || ti >= rows || tj >= cols) continue;
        var dn = D[ti * cols + tj];
        if (dn < 254) D[idx] = dn + 1;
      }
      dist.push(D);
    }
    var fc = [];
    for (i = 1; i < rows - 1; i++) for (j = 1; j < cols - 1; j++) {
      idx = i * cols + j;
      if (hard[idx]) continue;
      var bestW = 0, bestP = -1;
      for (var p = 0; p < 4; p++) {
        var len = (p & 1 ? Math.SQRT2 : 1) * cellM, a1 = dist[p][idx], b1 = dist[p + 4][idx];
        if (a1 === 255 || b1 === 255 || Math.abs(a1 - b1) > 2) continue;           // obstacles both sides, and we are mid-gap
        var wd = (a1 + b1) * len;
        if (wd < o.minWidthM || wd > o.maxWidthM || (bestW && wd >= bestW)) continue;
        var pp = (p + 2) % 4, lenP = (pp & 1 ? Math.SQRT2 : 1) * cellM;
        var run = Math.min(dist[pp][idx], dist[pp + 4][idx]) * lenP;               // how far it stays open along the corridor
        if (run < Math.max(o.minRunM, 1.5 * wd)) continue;
        bestW = wd; bestP = p;
      }
      if (bestP < 0) continue;
      // what is on each side: higher ground, lower ground or water
      var sa = idx + dist[bestP][idx] * (DI[bestP] * cols + DJ[bestP]), sb = idx + dist[bestP + 4][idx] * (DI[bestP + 4] * cols + DJ[bestP + 4]);
      var side = function (s) { return hard[s] === 2 ? 'water' : zs[s] > zs[idx] ? 'up' : 'down'; };
      fc.push({ row: i, col: j, widthM: bestW, acrossDeg: bestP * 45, sides: [side(sa), side(sb)], elevM: zs[idx] });
    }
    out.funnels = spaced(fc, o.funnelGapM, function (a, b) { return a.widthM - b.widthM; });
    return out;
  }

  /* Ground-elevation tiles for the bench layer: standard web-map tiles at one fixed zoom, 256 cells a side,
   * so the same squares are asked for every time and can be kept for use with no signal.
   * Returns the block of tiles covering bounds {s,w,n,e} plus a margin, or null if that is too many tiles. */
  var DEM_ZOOM = 15, DEM_PX = 256;
  function demTiles(b, padM, maxTiles, zoom) {
    var tz = zoom || DEM_ZOOM, n = Math.pow(2, tz), pad = (padM || 0) / 111320, mid = (b.s + b.n) / 2;
    var padLng = pad / Math.cos(mid * DEG);
    function tx(lng) { return Math.floor((lng + 180) / 360 * n); }
    function ty(lat) { var r = lat * DEG; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); }
    function lat(y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / DEG; }
    function lng(x) { return x / n * 360 - 180; }
    var x0 = tx(b.w - padLng), x1 = tx(b.e + padLng), y0 = ty(b.n + pad), y1 = ty(b.s - pad);
    var nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    if (nx < 1 || ny < 1 || nx * ny > (maxTiles || 12)) return null;
    return {
      z: tz, x0: x0, y0: y0, nx: nx, ny: ny, px: DEM_PX, cols: nx * DEM_PX, rows: ny * DEM_PX,
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
  // An hourly block in the Open-Meteo layout -> compact object the rest of the engine uses.
  // The app no longer loads from Open-Meteo (see forecastFromNws); this stays for the tests, which use this layout.
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
  /* ---------- National Weather Service forecast ----------
   * The NWS grid forecast (api.weather.gov, U.S. government, free for any use) gives each quantity as a list of
   * time spans: { validTime: "2026-10-13T15:00:00+00:00/PT2H", value }. These helpers turn that into the same
   * hour-by-hour object normalizeForecast() makes, starting at local midnight today and running 4 days.
   * NWS does not forecast sunshine or sun times, so both are worked out here from the sun's position and the
   * forecast cloud cover. */
  // Sunrise and sunset for a local date ('YYYY-MM-DD'), as naive local minutes like everything else here.
  function sunTimes(date, lat, lng, utcOffsetSec) {
    var day0 = parseLocalMin(date + 'T00:00');
    function up(t) { return solarPosition(t * 60000 - utcOffsetSec * 1000, lat, lng).elev > -0.833; }   // the sun's top edge on the horizon
    function cross(from, to, wantUp) {
      for (var t = from; t < to; t += 5) {
        if (up(t) !== wantUp && up(t + 5) === wantUp) {
          var a = t, b = t + 5;
          for (var k = 0; k < 6; k++) { var m = (a + b) / 2; if (up(m) === wantUp) b = m; else a = m; }
          return Math.round(b);
        }
      }
      return null;
    }
    var rise = cross(day0, day0 + 1440, true);
    var set = cross(rise == null ? day0 : rise, day0 + 1440 + 180, false);
    // far north in midsummer or midwinter there may be no rise or set: fall back to 6 and 6
    return { date: date, sunrise: rise == null ? day0 + 360 : rise, sunset: set == null ? day0 + 1080 : set };
  }
  // Sunshine reaching flat ground (W/m2): clear-sky value from the sun's height (Haurwitz), cut down by cloud (Kasten and Czeplak).
  function estimateShortwave(sunElevDeg, cloudPct) {
    if (!(sunElevDeg > 0)) return 0;
    var s = Math.sin(sunElevDeg * DEG), c = clamp(cloudPct, 0, 100) / 100;
    return 1098 * s * Math.exp(-0.057 / s) * (1 - 0.75 * Math.pow(c, 3.4));
  }
  function nwsSpan(validTime) {
    var m = /^([^\/]+)\/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(validTime || '');
    if (!m) return null;
    var start = Date.parse(m[1]);
    if (isNaN(start)) return null;
    return { start: start, end: start + Math.max(1, (+m[2] || 0) * 24 + (+m[3] || 0) + (+m[4] || 0) / 60) * 3600000 };
  }
  // One NWS quantity spread over our hours. `hours` are the UTC start times (ms) of each hour; gaps come back null.
  function nwsHourly(prop, hours, convert) {
    var out = hours.map(function () { return null; });
    if (!prop || !Array.isArray(prop.values)) return out;
    prop.values.forEach(function (v) {
      var sp = nwsSpan(v.validTime);
      if (!sp || typeof v.value !== 'number') return;
      for (var i = 0; i < hours.length; i++) if (hours[i] >= sp.start && hours[i] < sp.end) out[i] = convert ? convert(v.value) : v.value;
    });
    return out;
  }
  function nwsSpeedToMph(uom) {
    return /m_s-1/.test(uom || '') ? function (v) { return v * 2.236936; } : /kn|kt/.test(uom || '') ? function (v) { return v * 1.150779; }
      : /mi_h-1|mph/.test(uom || '') ? null : function (v) { return v * 0.6213712; };   // km/h is what NWS sends
  }
  // Hours before the forecast starts take its first value, so the whole day reads sensibly.
  function fillEdges(a, fallback) {
    var first = null;
    for (var i = 0; i < a.length; i++) if (a[i] != null) { first = a[i]; break; }
    var leading = true;
    return fillNulls(a.map(function (v) { if (v != null) leading = false; return v == null && leading ? first : v; }), first == null ? fallback : first);
  }
  // props: the `properties` of an NWS gridpoint reply. utcOffsetSec: the local clock's offset at the spot (CDT = -18000).
  function forecastFromNws(props, utcOffsetSec, lat, lng, nowMs) {
    var HOURS = 96, off = utcOffsetSec | 0;
    var day0 = Math.floor(((nowMs == null ? Date.now() : nowMs) / 1000 + off) / 86400) * 1440;   // local midnight today, in naive local minutes
    var t = [], utc = [];
    for (var i = 0; i < HOURS; i++) { t.push(day0 + i * 60); utc.push((day0 + i * 60) * 60000 - off * 1000); }
    var speedRaw = nwsHourly(props.windSpeed, utc, nwsSpeedToMph(props.windSpeed && props.windSpeed.uom));
    if (speedRaw.every(function (v) { return v == null; })) throw new Error('The forecast has no wind for this spot yet.');
    var toF = /degF/.test((props.temperature && props.temperature.uom) || '') ? null : function (c) { return c * 9 / 5 + 32; };
    var cloud = fillEdges(nwsHourly(props.skyCover, utc), 50);
    var daily = [];
    for (var d = 0; d < HOURS / 24; d++) daily.push(sunTimes(dateKey(day0 + d * 1440), lat, lng, off));
    return {
      utcOffsetSec: off, t: t, source: 'nws',
      temp: fillEdges(nwsHourly(props.temperature, utc, toF), 60),
      precip: fillEdges(nwsHourly(props.probabilityOfPrecipitation, utc), 0),
      cloud: cloud,
      speed: fillEdges(speedRaw, 0),
      dir: fillEdges(nwsHourly(props.windDirection, utc), 0),
      gust: fillEdges(nwsHourly(props.windGust, utc, nwsSpeedToMph(props.windGust && props.windGust.uom)), 0),
      sw: utc.map(function (ms, k) { return estimateShortwave(solarPosition(ms + 1800000, lat, lng).elev, cloud[k]); }),   // sun at the middle of the hour
      daily: daily
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
    var effFrom = norm((eff.speed < 0.2 ? s.from : eff.from) + fixDeg(stand));
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

  /* ---------- sit log: how the wind call held up ---------- */

  // The hunter's own wind checks can show that a stand's air runs a few degrees off the forecast (a draw,
  // a point of timber). Once they agree, that turn is added to the modeled wind at this stand.
  // stand.windFix = { deg, n, off }; off = the hunter switched it off.
  function fixDeg(stand) {
    var f = stand && stand.windFix;
    return f && !f.off && isFinite(f.deg) ? f.deg : 0;
  }
  function signedDiff(a, b) { var d = norm(a - b); return d > 180 ? d - 360 : d; }
  // One logged sit against the call StandCast made for it. sit.obs is a compass point ('N'..'NW'), 'calm' or 'swirl';
  // sit.pred = { from, raw, speed, swirl } (from = the call as shown, raw = before any learned turn).
  // Returns { hit, off } (off = degrees the real wind sat clockwise of the raw call) or null when it cannot be judged.
  function checkSit(sit) {
    var p = sit && sit.pred, o = sit && sit.obs;
    if (!p || !o || !isFinite(p.from)) return null;
    if (o === 'calm') return { hit: p.speed < 3, off: null };
    if (o === 'swirl') return { hit: p.swirl >= 0.3 || p.speed < 3, off: null };
    var k = SECTORS.indexOf(o);
    if (k < 0) return null;
    // a milkweed read is good to about one compass point, so a call within 45° counts as a match
    return { hit: angDiff(k * 45, p.from) <= 45, off: signedDiff(k * 45, isFinite(p.raw) ? p.raw : p.from) };
  }
  // Track record for one stand: { checks, hits, AM: {checks, hits}, PM: {...}, sits, busted, inRange }.
  function sitRecord(sits) {
    var r = { checks: 0, hits: 0, AM: { checks: 0, hits: 0 }, PM: { checks: 0, hits: 0 }, sits: 0, busted: 0, inRange: 0 };
    (sits || []).forEach(function (s) {
      r.sits++;
      if (s.outcome === 'busted') r.busted++;
      if (s.outcome === 'range') r.inRange++;
      var c = checkSit(s);
      if (!c) return;
      r.checks++; if (c.hit) r.hits++;
      var k = r[s.kind];
      if (k) { k.checks++; if (c.hit) k.hits++; }
    });
    return r;
  }
  // The steady turn between the forecast and this stand's real air, from the last 12 compass checks.
  // Needs 3 checks that agree; shrunk toward zero while there are few, and never more than 45°.
  // Returns { deg, n } or null when there is nothing consistent to learn.
  var FIX = { min: 3, keep: 12, agree: 0.5, maxDeg: 45, smallDeg: 8 };
  function windFixFrom(sits) {
    var offs = [];
    (sits || []).forEach(function (s) { var c = checkSit(s); if (c && c.off != null) offs.push(c.off); });
    offs = offs.slice(-FIX.keep);
    if (offs.length < FIX.min) return null;
    var cs = 0, sn = 0;
    offs.forEach(function (d) { cs += Math.cos(d * DEG); sn += Math.sin(d * DEG); });
    if (Math.hypot(cs, sn) / offs.length < FIX.agree) return null;
    var deg = clamp(signedDiff(Math.atan2(sn, cs) / DEG, 0) * offs.length / (offs.length + 2), -FIX.maxDeg, FIX.maxDeg);
    if (Math.abs(deg) < FIX.smallDeg) return null;
    return { deg: Math.round(deg), n: offs.length };
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
    checkSit: checkSit, sitRecord: sitRecord, windFixFrom: windFixFrom, fixDeg: fixDeg, FIX: FIX,
    toVec: toVec, fromVec: fromVec, distanceM: distanceM, yards: yards, fmtYards: fmtYards,
    parseLocalMin: parseLocalMin, dateKey: dateKey, fmtClock: fmtClock, fmtDayClock: fmtDayClock, fmtHour: fmtHour, dayDiff: dayDiff,
    solarPosition: solarPosition,
    terrainFromSamples: terrainFromSamples, terrainProbePoints: terrainProbePoints, offsetLatLng: offsetLatLng, resolveTerrain: resolveTerrain,
    flowGrid: flowGrid, flowCells: flowCells,
    findBenches: findBenches, demTiles: demTiles, BENCH: BENCH, findSpots: findSpots, SPOTS: SPOTS,
    thermal: thermal, swirl: swirl, swirlSpots: swirlSpots, heatIndex: heatIndex, thermalWords: thermalWords, thermalSwitches: thermalSwitches,
    normalizeForecast: normalizeForecast, sampleForecast: sampleForecast, nowMinFor: nowMinFor,
    forecastFromNws: forecastFromNws, sunTimes: sunTimes, estimateShortwave: estimateShortwave,
    windRating: windRating, isConfigured: isConfigured, ratingClass: ratingClass,
    stateAt: stateAt,
    sitWindowFor: sitWindowFor, listSits: listSits, windowForStand: windowForStand,
    scoreLabel: scoreLabel, evaluateSit: evaluateSit,
    coneRing: coneRing, arrowShape: arrowShape
  };
});
