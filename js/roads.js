/* Roads and trails drawn as lines over any base map, so they show on the photo maps too.
 *   solid line   = a road
 *   long dashes  = a 4WD or closed road (two-track, forest road)
 *   dots         = a trail
 * Lines come from the USGS National Map transportation service (roads from Census TIGER, trails from the
 * agencies that manage them). Coverage is only as good as that data: many woods roads and most unofficial
 * trails are not in it.
 *
 * Detail follows the zoom:
 *   zoomed out   main highways only, from the small-scale road set (one light request per view)
 *   zoomed in    every road, 4WD road and trail, fetched in squares of about 3 miles and kept for the session
 * To keep the map smooth, all the lines of one kind are drawn as a single shape (a dozen shapes in all, not
 * thousands), and what is on screen stays there until its replacement has loaded, so lines do not blink out
 * when you cross from one level of detail to the other. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var URL = 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer';
  var KINDS = [
    { layer: 30, kind: 'road', label: 'Highway', weight: 3 },
    { layer: 31, kind: 'road', label: 'Road', weight: 2.6 },
    { layer: 32, kind: 'road', label: 'Local road', weight: 2.2 },
    { layer: 35, kind: 'track', label: '4WD road', weight: 2.4, dash: '10 7' },
    { layer: 36, kind: 'track', label: 'Closed road', weight: 2.4, dash: '10 7' },
    { layer: 37, kind: 'trail', label: 'Trail', weight: 2.6, dash: '1 7' }
  ];
  var CELL = 0.05, MIN_ZOOM = 13, MAX_FEATS = 9000;
  var map = null, ovLayer = null, detLayer = null, enabled = false, onStatus = null, timer = 0;
  var cells = {}, feats = {}, featCount = 0, detDirty = false;
  var ovCache = {}, ovOrder = [], ovSeq = 0, ovKey = '';

  function attach(m, o) {
    map = m; onStatus = o && o.onStatus;
    ovLayer = L.layerGroup(); detLayer = L.layerGroup();
    map.on('moveend', schedule);
  }
  function status(s) { if (onStatus) onStatus(s); }
  function schedule() { clearTimeout(timer); timer = setTimeout(load, 450); }
  function show(layer, on) { if (on && !map.hasLayer(layer)) layer.addTo(map); else if (!on && map.hasLayer(layer)) map.removeLayer(layer); }
  function getJson(url) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      function (e) { clearTimeout(t); throw e; });
  }
  // One dark line under one pale line for a whole class of road. noClip keeps the full shape drawn, so nothing
  // is cut off at the screen edge while you drag.
  function strokes(group, paths, weight, color, dash) {
    if (!paths.length) return;
    var base = { interactive: false, lineCap: 'round', lineJoin: 'round', noClip: true, smoothFactor: 1.5 };
    L.polyline(paths, Object.assign({ color: '#10140f', weight: weight + 2.6, opacity: 0.5 }, base)).addTo(group);
    L.polyline(paths, Object.assign({ color: color, weight: weight, opacity: 0.95, dashArray: dash || null }, base)).addTo(group);
  }

  /* ---- zoomed out: main highways ---- */
  function overview() {
    var z = map.getZoom(), b = map.getBounds();
    show(detLayer, false);
    if (z < 5) { show(ovLayer, false); return; }
    show(ovLayer, true);
    var tier = z < 8.5 ? 0 : z < 11 ? 1 : 2, g = tier === 0 ? 4 : tier === 1 ? 0.5 : 0.25;
    var box = { s: Math.floor(b.getSouth() / g) * g, n: Math.ceil(b.getNorth() / g) * g, w: Math.floor(b.getWest() / g) * g, e: Math.ceil(b.getEast() / g) * g };
    var key = [tier, box.s, box.w, box.n, box.e].join(',');
    if (key === ovKey) return;
    function paint(list) {
      ovLayer.clearLayers(); ovKey = key;
      var classes = [{ w: 1.6, c: '#fff1c9', paths: [] }, { w: 2.2, c: '#fff1c9', paths: [] }, { w: 3, c: '#ffe08a', paths: [] }];
      list.forEach(function (f) { var k = f.big ? 2 : f.us ? 1 : 0; f.paths.forEach(function (p) { classes[k].paths.push(p); }); });
      classes.forEach(function (k) { strokes(ovLayer, k.paths, k.w, k.c); });
    }
    if (ovCache[key]) { paint(ovCache[key]); return; }
    var mine = ++ovSeq, layer = tier === 0 ? 8 : 9;
    var where = tier === 2 ? "INTERSTATE <> ' ' OR US_ROUTE <> ' ' OR ST_ROUTE <> ' '" : tier === 1 ? "INTERSTATE <> ' ' OR US_ROUTE <> ' '" : '1=1';
    status('loading');
    getJson(URL + '/' + layer + '/query?where=' + encodeURIComponent(where) + '&geometry=' + [box.w, box.s, box.e, box.n].join('%2C') +
      '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=INTERSTATE,US_ROUTE&returnGeometry=true&outSR=4326' +
      '&geometryPrecision=4&maxAllowableOffset=' + ((box.e - box.w) / 500).toFixed(5) + '&f=json').then(function (j) {
      if (!j || !Array.isArray(j.features)) throw new Error('bad data');
      var list = j.features.filter(function (f) { return f.geometry && f.geometry.paths; }).map(function (f) {
        var a = f.attributes || {};
        return { big: !!String(a.INTERSTATE || '').trim(), us: !!String(a.US_ROUTE || '').trim(), paths: f.geometry.paths.map(function (p) { return p.map(function (c) { return [c[1], c[0]]; }); }) };
      });
      ovCache[key] = list; ovOrder.push(key); while (ovOrder.length > 20) delete ovCache[ovOrder.shift()];
      // the old highways stay on screen until these are ready, then swap in one go
      if (mine === ovSeq && enabled && map.getZoom() < MIN_ZOOM) paint(list);
      status('ok');
    }).catch(function () { status('error'); });
  }

  /* ---- zoomed in: every road and trail ---- */
  function load() {
    if (!enabled || !map) return;
    if (map.getZoom() < MIN_ZOOM) { overview(); return; }
    show(detLayer, true);
    if (featCount > MAX_FEATS) { cells = {}; feats = {}; featCount = 0; detDirty = true; }   // a long session: start the store over
    var b = map.getBounds(), todo = [], waiting = false;
    for (var la = Math.floor(b.getSouth() / CELL); la <= Math.floor(b.getNorth() / CELL); la++) {
      for (var ln = Math.floor(b.getWest() / CELL); ln <= Math.floor(b.getEast() / CELL); ln++) {
        var k = la + ',' + ln;
        if (!cells[k] || cells[k] === 'error') todo.push([la, ln, k]);
        else if (cells[k] === 'loading') waiting = true;
      }
    }
    draw();
    // highways from the zoomed-out view stay underneath until the detail for this view is all in
    if (!todo.length && !waiting) { show(ovLayer, false); status('ok'); return; }
    if (!todo.length) return;
    if (todo.length > 6) todo = todo.slice(0, 6);
    status('loading');
    Promise.all(todo.map(fetchCell)).then(function (r) {
      var bad = r.some(function (x) { return x === 'error'; });
      status(bad ? 'error' : 'ok');
      if (!enabled || map.getZoom() < MIN_ZOOM) return;
      if (bad) draw(); else load();    // draw what arrived and pick up any squares still missing (a failed square waits for the next move)
    });
  }

  function fetchCell(c) {
    var key = c[2], s = c[0] * CELL, w = c[1] * CELL, failed = 0;
    cells[key] = 'loading';
    var box = [w, s, w + CELL, s + CELL].map(function (v) { return v.toFixed(4); }).join('%2C');
    return Promise.all(KINDS.map(function (kd, ki) {
      var q = 'where=1%3D1&geometry=' + box + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects' +
        '&outFields=' + (kd.layer === 37 ? 'objectid,name,trailnumber,trailsurface' : 'objectid,name') +
        '&returnGeometry=true&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.00004&f=json';
      return getJson(URL + '/' + kd.layer + '/query?' + q).then(function (j) {
        if (!j || !Array.isArray(j.features)) throw new Error('bad data');
        j.features.forEach(function (f) {
          var a = f.attributes || {}, id = kd.layer + ':' + (a.objectid != null ? a.objectid : a.OBJECTID);
          if (feats[id] || !f.geometry || !f.geometry.paths) return;
          var bb = { s: 90, n: -90, w: 180, e: -180 };
          // the service gives [lng, lat]; Leaflet wants [lat, lng]
          var paths = f.geometry.paths.map(function (p) {
            return p.map(function (c2) { if (c2[0] < bb.w) bb.w = c2[0]; if (c2[0] > bb.e) bb.e = c2[0]; if (c2[1] < bb.s) bb.s = c2[1]; if (c2[1] > bb.n) bb.n = c2[1]; return [c2[1], c2[0]]; });
          });
          feats[id] = { ki: ki, name: a.name || '', number: a.trailnumber || '', surface: a.trailsurface || '', paths: paths, box: bb };
          featCount++; detDirty = true;
        });
      }).catch(function () { failed++; });
    })).then(function () {
      cells[key] = failed === KINDS.length ? 'error' : 'done';
      return cells[key];
    });
  }

  function draw() {
    if (!detDirty) return;
    detDirty = false;
    var by = KINDS.map(function () { return []; });
    Object.keys(feats).forEach(function (id) { var f = feats[id]; f.paths.forEach(function (p) { by[f.ki].push(p); }); });
    detLayer.clearLayers();
    KINDS.forEach(function (kd, ki) { strokes(detLayer, by[ki], kd.weight, kd.kind === 'trail' ? '#ffffff' : '#fff1c9', kd.dash); });
  }

  // The road or trail under a tap (within about a thumb's width), or null. Only when zoomed in to full detail.
  function pick(latlng) {
    if (!enabled || !map || !latlng || map.getZoom() < MIN_ZOOM) return null;
    var tap = map.latLngToContainerPoint(latlng), tol = 16, best = null, bd = tol * tol;
    var c = map.containerPointToLatLng([tap.x + tol, tap.y + tol]), padLat = Math.abs(c.lat - latlng.lat) * 1.5 + 1e-5, padLng = Math.abs(c.lng - latlng.lng) * 1.5 + 1e-5;
    Object.keys(feats).forEach(function (id) {
      var f = feats[id];
      if (latlng.lat < f.box.s - padLat || latlng.lat > f.box.n + padLat || latlng.lng < f.box.w - padLng || latlng.lng > f.box.e + padLng) return;
      f.paths.forEach(function (p) {
        var a = map.latLngToContainerPoint(p[0]);
        for (var i = 1; i < p.length; i++) {
          var b = map.latLngToContainerPoint(p[i]), dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
          var t = len ? Math.max(0, Math.min(1, ((tap.x - a.x) * dx + (tap.y - a.y) * dy) / len)) : 0;
          var ex = a.x + t * dx - tap.x, ey = a.y + t * dy - tap.y, d = ex * ex + ey * ey;
          if (d < bd) { bd = d; best = f; }
          a = b;
        }
      });
    });
    if (!best) return null;
    var kd = KINDS[best.ki];
    return { kind: kd.kind, label: kd.label, name: best.name, number: best.number, surface: best.surface };
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!map) return;
    if (!enabled) { show(ovLayer, false); show(detLayer, false); status('off'); }
    else load();
  }

  SC.roads = { attach: attach, setEnabled: setEnabled, pick: pick, MIN_ZOOM: MIN_ZOOM, get enabled() { return enabled; } };
})();
