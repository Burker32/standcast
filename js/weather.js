/* Forecast and terrain loading. The forecast is the U.S. National Weather Service grid forecast
 * (api.weather.gov): government data, free for any use including a paid app, no key. It covers the
 * United States only. Cached locally so the last forecast still shows with no signal.
 * (Until v40 this used Open-Meteo, whose free service is for non-commercial use only.) */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var E = SC.engine;
  var KEY = 'standcast.forecast.v2', PKEY = 'standcast.nwspoint.v1';
  var TTL = 20 * 60 * 1000;
  var NWS = 'https://api.weather.gov';
  var cache = {}; // "37.66,-93.76" -> { fc, at }
  var points = {}; // "37.66,-93.76" -> { grid: forecast grid URL, tz: 'America/Chicago' }. A spot's grid square never changes, so this is kept.

  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { cache = {}; }
  try { points = JSON.parse(localStorage.getItem(PKEY) || '{}') || {}; } catch (e) { points = {}; }
  try { localStorage.removeItem('standcast.forecast.v1'); } catch (e) { /* old Open-Meteo copy */ }

  function persist() {
    try {
      var keys = Object.keys(cache);
      if (keys.length > 30) {
        keys.sort(function (a, b) { return cache[a].at - cache[b].at; });
        keys.slice(0, keys.length - 30).forEach(function (k) { delete cache[k]; });
      }
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch (e) { /* storage full: keep working from memory */ }
  }
  function keyFor(lat, lng) { return lat.toFixed(2) + ',' + lng.toFixed(2); }

  function getJson(url, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 12000);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }

  // Seconds the local clock at a place is ahead of UTC (Central Daylight Time is -18000), from its time zone name.
  function tzOffsetSec(tz, ms) {
    ms = Math.floor(ms / 1000) * 1000;   // whole seconds, so the answer is exact
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
      var v = {};
      parts.forEach(function (p) { v[p.type] = +p.value; });
      return Math.round((Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second) - ms) / 1000);
    } catch (e) { return -new Date(ms).getTimezoneOffset() * 60; }   // no zone name: assume the phone is in the same zone as the stand
  }

  // Returns { byStand: {id: fc|null}, at: oldest fetch time, stale: bool, error: string|null }
  function loadFor(stands, force) {
    var p = loadFor_(stands, force);
    forecastBusy = p.catch(function () {}).then(function () { forecastBusy = null; });
    return p;
  }
  function loadFor_(stands, force) {
    var need = {}, wanted = {};
    stands.forEach(function (s) {
      var k = keyFor(s.lat, s.lng);
      wanted[k] = [s.lat, s.lng];
      var c = cache[k];
      if (force || !c || Date.now() - c.at > TTL) need[k] = wanted[k];
    });
    var keys = Object.keys(need), error = null, grids = {};
    // one quiet retry: on a slow phone connection the first try can stall, and NWS now and then answers "try again"
    function twice(url) { return getJson(url, 20000).catch(function (e) { if (e && e.outside) throw e; return getJson(url, 25000); }); }
    // Step 1: which forecast grid square is this spot in (asked once per spot, then remembered).
    function pointFor(k) {
      if (points[k] && points[k].grid) return Promise.resolve(points[k]);
      return getJson(NWS + '/points/' + need[k][0].toFixed(4) + ',' + need[k][1].toFixed(4), 20000).catch(function (e) {
        if (e && /HTTP 404/.test(e.message)) { var o = new Error('outside'); o.outside = true; throw o; }
        return getJson(NWS + '/points/' + need[k][0].toFixed(4) + ',' + need[k][1].toFixed(4), 25000);
      }).then(function (j) {
        var p = j && j.properties;
        if (!p || !p.forecastGridData) throw new Error('no grid');
        points[k] = { grid: p.forecastGridData, tz: p.timeZone || '' };
        try { localStorage.setItem(PKEY, JSON.stringify(points)); } catch (e2) { /* memory only */ }
        return points[k];
      });
    }
    // Step 2: that square's forecast. Stands in the same 1.5 mile square share one request.
    function gridFor(url) { return grids[url] || (grids[url] = twice(url)); }

    return Promise.all(keys.map(function (k) {
      return pointFor(k).then(function (pt) {
        return gridFor(pt.grid).then(function (j) {
          if (!j || !j.properties) throw new Error('no forecast');
          var now = Date.now();
          cache[k] = { fc: E.forecastFromNws(j.properties, tzOffsetSec(pt.tz, now), need[k][0], need[k][1], now), at: now };
        });
      }).catch(function (e) {
        error = e && e.outside ? 'The forecast covers the United States only.' : e && e.name === 'AbortError' ? 'The forecast server took too long.' : 'Could not reach the forecast server.';
      });
    })).then(function () {
      if (keys.length) persist();
      var byStand = {}, oldest = Infinity, stale = false, missing = false;
      stands.forEach(function (s) {
        var c = cache[keyFor(s.lat, s.lng)];
        byStand[s.id] = c ? c.fc : null;
        if (!c) missing = true;
        else { oldest = Math.min(oldest, c.at); if (Date.now() - c.at > TTL) stale = true; }
      });
      return { byStand: byStand, at: isFinite(oldest) ? oldest : null, stale: stale, missing: missing, error: error };
    });
  }

  /* ---------- ground elevation ----------
   * USGS 3DEP bare-earth elevation, from lidar at 1 m where flown (most of Missouri) and the national
   * 10 m model elsewhere. Government data, free, no key. */
  var DEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples';
  function dep3(pts) {   // pts: [[lat,lng]] -> Promise<[elev|null]>
    var body = 'geometry=' + encodeURIComponent(JSON.stringify({ points: pts.map(function (p) { return [+p[1].toFixed(6), +p[0].toFixed(6)]; }), spatialReference: { wkid: 4326 } })) +
      '&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json';
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(DEP, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !Array.isArray(j.samples)) throw new Error('no samples');
        var out = pts.map(function () { return null; });
        j.samples.forEach(function (sm) { var v = parseFloat(sm.value); if (sm.locationId != null && isFinite(v) && v > -500) out[sm.locationId] = v; });
        return out;
      }, function (e) { clearTimeout(t); throw e; });
  }
  // Elevation at the stand plus four points 60 m around it (the hillside the stand is on) -> slope and which way it faces.
  function fetchTerrain(lat, lng) {
    function build(z) {
      if (!z || z.length < 5 || z.some(function (v) { return typeof v !== 'number'; })) throw new Error('No elevation data');
      var t = E.terrainFromSamples(z[1], z[2], z[3], z[4], 60);
      return { slopeDeg: t.slopeDeg, aspectDeg: t.aspectDeg, elevM: z[0], lat: lat, lng: lng, at: Date.now(), src: 'lidar' };
    }
    var near = E.terrainProbePoints(lat, lng, 60);
    return dep3(near).then(build).catch(function () { return dep3(near).then(build); });   // one quiet retry
  }

  /* ---------- elevation grid for the thermal-flow layer ---------- */
  var EKEY = 'standcast.elev.v2', ELEV_MAX = 6000;   // v2: lidar elevations (v1 was 90 m only)
  var elev = {};
  try { elev = JSON.parse(localStorage.getItem(EKEY) || '{}') || {}; } catch (e) { elev = {}; }
  var elevDirty = false, elevTimer = 0;
  function ek(lat, lng) { return lat.toFixed(5) + ',' + lng.toFixed(5); }
  function persistElev() {
    clearTimeout(elevTimer);
    elevTimer = setTimeout(function () {
      if (!elevDirty) return; elevDirty = false;
      try {
        var keys = Object.keys(elev);
        if (keys.length > ELEV_MAX) keys.slice(0, keys.length - ELEV_MAX).forEach(function (k) { delete elev[k]; });
        localStorage.setItem(EKEY, JSON.stringify(elev));
      } catch (e) { /* full: memory only */ }
    }, 1500);
  }
  // points: [[lat,lng],...]. Resolves to an array of elevations (null where unknown).
  // Uses what is cached first, so the layer still works offline for areas you have viewed.
  var forecastBusy = null;
  function elevations(points) {
    // let the forecast go first; terrain for the flow layer can wait a moment
    if (forecastBusy) return forecastBusy.then(function () { return elevations(points); });
    var missing = [];
    points.forEach(function (p) { var k = ek(p[0], p[1]); if (!(k in elev) && missing.indexOf(k) < 0) missing.push(k); });
    function store(keys, z) { keys.forEach(function (k, idx) { if (typeof z[idx] === 'number') { delete elev[k]; elev[k] = z[idx]; elevDirty = true; } }); }
    function pts(keys) { return keys.map(function (k) { var a = k.split(','); return [+a[0], +a[1]]; }); }
    var chunks = [];
    for (var i = 0; i < missing.length; i += 400) chunks.push(missing.slice(i, i + 400));
    return Promise.all(chunks.map(function (chunk) {
      return dep3(pts(chunk)).then(function (z) {
        store(chunk, z);
      }, function () { /* no signal or the service is down: those points stay unknown until the next look */ });
    })).then(function () {
      persistElev();
      return points.map(function (p) { var v = elev[ek(p[0], p[1])]; return typeof v === 'number' ? v : null; });
    });
  }

  /* ---------- elevation tiles for the bench layer ----------
   * One 256 x 256 square of lidar ground heights per web-map tile, sent as raw numbers (4 bytes a cell, north row
   * first). The service worker keeps them for use offline. */
  var DEM_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  var MERC = 20037508.342789244, demCache = {}, demOrder = [], DEM_KEEP = 40;
  function demTile(z, x, y, px) {
    var key = z + '/' + x + '/' + y;
    if (demCache[key]) return demCache[key];
    var span = 2 * MERC / Math.pow(2, z), x0 = -MERC + x * span, y1 = MERC - y * span;
    var url = DEM_URL + '?bbox=' + [x0, y1 - span, x0 + span, y1].map(function (v) { return v.toFixed(2); }).join(',') +
      '&bboxSR=3857&imageSR=3857&size=' + px + ',' + px + '&format=bsq&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image';
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 25000);
    var p = fetch(url, { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        clearTimeout(t);
        var n = px * px;
        if (buf.byteLength < n * 4) throw new Error('short elevation tile');
        var v = new DataView(buf), out = new Float32Array(n);
        for (var i = 0; i < n; i++) {
          var h = v.getFloat32(i * 4, true);
          out[i] = h > -500 && h < 9000 ? h : NaN;   // anything else is the service's "no data here" filler
        }
        return out;
      });
    p.catch(function () { clearTimeout(t); delete demCache[key]; });   // failed: let the next look try again
    demCache[key] = p; demOrder.push(key);
    while (demOrder.length > DEM_KEEP) delete demCache[demOrder.shift()];
    return p;
  }
  // t: the block of tiles from engine.demTiles(). Resolves to { z, rows, cols, missing } with NaN where a tile failed.
  function demMosaic(t) {
    if (forecastBusy) return forecastBusy.then(function () { return demMosaic(t); });
    var jobs = [];
    for (var ty = 0; ty < t.ny; ty++) for (var tx = 0; tx < t.nx; tx++) {
      jobs.push(demTile(t.z, t.x0 + tx, t.y0 + ty, t.px).then(function (a) { return a; }, function () { return null; }));
    }
    return Promise.all(jobs).then(function (tiles) {
      var z = new Float32Array(t.rows * t.cols).fill(NaN), missing = 0;
      tiles.forEach(function (a, k) {
        if (!a) { missing++; return; }
        var oy = Math.floor(k / t.nx) * t.px, ox = (k % t.nx) * t.px;
        for (var r = 0; r < t.px; r++) z.set(a.subarray(r * t.px, (r + 1) * t.px), (oy + r) * t.cols + ox);
      });
      return { z: z, rows: t.rows, cols: t.cols, missing: missing, total: tiles.length };
    });
  }

  SC.weather = { loadFor: loadFor, fetchTerrain: fetchTerrain, elevations: elevations, demMosaic: demMosaic, TTL: TTL };
})();
