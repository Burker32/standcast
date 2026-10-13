/* Forecast and terrain loading. Wind is modeled data from Open-Meteo (no key needed),
 * cached locally so the last forecast still shows with no signal. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var E = SC.engine;
  var KEY = 'standcast.forecast.v1';
  var TTL = 20 * 60 * 1000;
  var HOURLY = 'temperature_2m,precipitation_probability,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,shortwave_radiation';
  var cache = {}; // "37.66,-93.76" -> { fc, at }

  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { cache = {}; }

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
    var keys = Object.keys(need), chunks = [];
    for (var i = 0; i < keys.length; i += 20) chunks.push(keys.slice(i, i + 20));
    var error = null;

    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        var lats = chunk.map(function (k) { return need[k][0].toFixed(2); }).join(',');
        var lngs = chunk.map(function (k) { return need[k][1].toFixed(2); }).join(',');
        var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lats + '&longitude=' + lngs +
          '&hourly=' + HOURLY + '&daily=sunrise,sunset&wind_speed_unit=mph&temperature_unit=fahrenheit' +
          '&timezone=auto&forecast_days=4';
        // one quiet retry: on a slow phone connection the first try can stall
        return getJson(url, 20000).catch(function () { return getJson(url, 25000); }).then(function (j) {
          var list = Array.isArray(j) ? j : [j];
          list.forEach(function (raw, idx) {
            if (!raw || !raw.hourly) return;
            cache[chunk[idx]] = { fc: E.normalizeForecast(raw), at: Date.now() };
          });
        }).catch(function (e) { error = e && e.name === 'AbortError' ? 'The forecast server took too long.' : 'Could not reach the forecast server.'; });
      });
    }, Promise.resolve()).then(function () {
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
   * First choice: USGS 3DEP bare-earth elevation, from lidar at 1 m where flown (most of Missouri).
   * Fallback: Open-Meteo's 90 m terrain model. Both free, no key. */
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
  function openMeteoElev(pts) {
    var url = 'https://api.open-meteo.com/v1/elevation?latitude=' + pts.map(function (p) { return p[0].toFixed(6); }).join(',') +
      '&longitude=' + pts.map(function (p) { return p[1].toFixed(6); }).join(',');
    return getJson(url, 15000).then(function (j) {
      var z = j && j.elevation;
      if (!z || z.length !== pts.length) throw new Error('No elevation data');
      return z.map(function (v) { return typeof v === 'number' ? v : null; });
    });
  }

  // Elevation at the stand plus four points around it -> slope and which way it faces.
  // With lidar the probes sit 60 m out (the hillside the stand is on); with 90 m data they need 150 m.
  function fetchTerrain(lat, lng) {
    function build(z, spacing, src) {
      if (!z || z.length < 5 || z.some(function (v) { return typeof v !== 'number'; })) throw new Error('No elevation data');
      var t = E.terrainFromSamples(z[1], z[2], z[3], z[4], spacing);
      return { slopeDeg: t.slopeDeg, aspectDeg: t.aspectDeg, elevM: z[0], lat: lat, lng: lng, at: Date.now(), src: src };
    }
    var near = E.terrainProbePoints(lat, lng, 60);
    return dep3(near).then(function (z) { return build(z, 60, 'lidar'); }).catch(function () {
      var far = E.terrainProbePoints(lat, lng, 150);
      return openMeteoElev(far).then(function (z) { return build(z, 150, '90m'); });
    });
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
        return chunk.filter(function (k, idx) { return z[idx] == null; });   // gaps (outside lidar coverage) fall back below
      }, function () { return chunk; }).then(function (left) {
        var subs = [];
        for (var j = 0; j < left.length; j += 100) subs.push(left.slice(j, j + 100));
        return Promise.all(subs.map(function (sub) { return openMeteoElev(pts(sub)).then(function (z) { store(sub, z); }).catch(function () {}); }));
      });
    })).then(function () {
      persistElev();
      return points.map(function (p) { var v = elev[ek(p[0], p[1])]; return typeof v === 'number' ? v : null; });
    });
  }

  /* ---------- elevation tiles for the bench layer ----------
   * One 256 x 256 square of lidar ground heights per web-map tile, sent as raw numbers (4 bytes a cell, north row
   * first). The service worker keeps them for use offline. */
  var DEM_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  var MERC = 20037508.342789244, demCache = {}, demOrder = [], DEM_KEEP = 24;
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
