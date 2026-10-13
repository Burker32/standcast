/* Roads and trails drawn as lines over any base map, so they show on the photo maps too.
 *   solid line   = a road
 *   long dashes  = a 4WD or closed road (two-track, forest road)
 *   dots         = a trail
 * Lines come from the USGS National Map transportation service (roads from Census TIGER, trails from the
 * agencies that manage them). Fetched in squares of about 3 miles when you are zoomed in, and kept for the
 * session. Tap a line for its name. Coverage is only as good as that data: many woods roads and most
 * unofficial trails are not in it. */
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
  var CELL = 0.05, MIN_ZOOM = 13;
  var map = null, group = null, enabled = false, onTap = null, onStatus = null, timer = 0;
  var cells = {}, feats = {}, drawn = {};

  function attach(m, o) {
    map = m; onTap = o && o.onTap; onStatus = o && o.onStatus;
    group = L.layerGroup().addTo(map);
    map.on('moveend', schedule);
  }
  function status(s) { if (onStatus) onStatus(s); }
  function schedule() { clearTimeout(timer); timer = setTimeout(load, 450); }
  // one shared canvas for every road line (much lighter than one page element per line)
  var cv = null;
  function canvas() { if (!cv && L.canvas) cv = L.canvas({ padding: 0.4, tolerance: 8 }); return cv || undefined; }

  /* Zoomed out, only the main highways are drawn, from the small-scale road set (one light request per view):
   *   far out      interstates and U.S. routes, coarse
   *   closer       the same, finer
   *   closer still state routes join in
   * The full detail (local roads, 4WD roads, trails) only loads at MIN_ZOOM and closer. */
  var ovCache = {}, ovOrder = [], ovSeq = 0, ovKey = '';
  function overview() {
    var z = map.getZoom(), b = map.getBounds();
    if (z < 5) { group.clearLayers(); drawn = {}; ovKey = ''; return; }
    var tier = z < 8.5 ? 0 : z < 11 ? 1 : 2, g = tier === 0 ? 4 : tier === 1 ? 0.5 : 0.25;
    var box = { s: Math.floor(b.getSouth() / g) * g, n: Math.ceil(b.getNorth() / g) * g, w: Math.floor(b.getWest() / g) * g, e: Math.ceil(b.getEast() / g) * g };
    var key = [tier, box.s, box.w, box.n, box.e].join(',');
    if (key === ovKey) return;
    function paint(list) {
      group.clearLayers(); drawn = {}; ovKey = key;
      // All roads of one class go down as a single shape on a canvas: a handful of drawings instead of thousands
      // of separate lines, which is what keeps panning smooth. Dark casings first, then the pale lines.
      var classes = [{ w: 1.6, c: '#fff1c9', paths: [] }, { w: 2.2, c: '#fff1c9', paths: [] }, { w: 3, c: '#ffe08a', paths: [] }];
      list.forEach(function (f) { var k = f.big ? 2 : f.w > 2 ? 1 : 0; f.paths.forEach(function (p) { classes[k].paths.push(p); }); });
      classes.forEach(function (k) { if (k.paths.length) L.polyline(k.paths, { color: '#10140f', weight: k.w + 2.4, opacity: 0.5, interactive: false, lineCap: 'round', lineJoin: 'round', renderer: canvas() }).addTo(group); });
      classes.forEach(function (k) { if (k.paths.length) L.polyline(k.paths, { color: k.c, weight: k.w, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round', renderer: canvas() }).addTo(group); });
    }
    if (ovCache[key]) { paint(ovCache[key]); return; }
    var mine = ++ovSeq, layer = tier === 0 ? 8 : 9;
    var where = tier === 2 ? "INTERSTATE <> ' ' OR US_ROUTE <> ' ' OR ST_ROUTE <> ' '" : tier === 1 ? "INTERSTATE <> ' ' OR US_ROUTE <> ' '" : '1=1';
    var q = 'where=' + encodeURIComponent(where) + '&geometry=' + [box.w, box.s, box.e, box.n].join('%2C') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects' +
      '&outFields=INTERSTATE,US_ROUTE&returnGeometry=true&outSR=4326&geometryPrecision=4&maxAllowableOffset=' + ((box.e - box.w) / 500).toFixed(5) + '&f=json';
    status('loading');
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    fetch(URL + '/' + layer + '/query?' + q, ctl ? { signal: ctl.signal } : {}).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) {
      if (!j || !Array.isArray(j.features)) throw new Error('bad data');
      var list = j.features.filter(function (f) { return f.geometry && f.geometry.paths; }).map(function (f) {
        var a = f.attributes || {}, inter = String(a.INTERSTATE || '').trim(), us = String(a.US_ROUTE || '').trim();
        return { big: !!inter, w: inter ? 3 : us ? 2.2 : 1.6, paths: f.geometry.paths.map(function (p) { return p.map(function (c) { return [c[1], c[0]]; }); }) };
      });
      ovCache[key] = list; ovOrder.push(key); while (ovOrder.length > 20) delete ovCache[ovOrder.shift()];
      if (mine === ovSeq && enabled && map.getZoom() < MIN_ZOOM) paint(list);
      status('ok');
    }).catch(function () { clearTimeout(t); status('error'); });
  }

  function load() {
    if (!enabled || !map) return;
    if (map.getZoom() < MIN_ZOOM) { overview(); return; }
    if (ovKey) { group.clearLayers(); drawn = {}; ovKey = ''; }      // coming in from the overview: swap to full detail
    var b = map.getBounds(), todo = [];
    for (var la = Math.floor(b.getSouth() / CELL); la <= Math.floor(b.getNorth() / CELL); la++) {
      for (var ln = Math.floor(b.getWest() / CELL); ln <= Math.floor(b.getEast() / CELL); ln++) {
        var k = la + ',' + ln;
        if (!cells[k] || cells[k] === 'error') todo.push([la, ln, k]);
      }
    }
    draw();
    if (todo.length > 6) todo = todo.slice(0, 6);
    if (!todo.length) { status('ok'); return; }
    status('loading');
    Promise.all(todo.map(fetchCell)).then(function (r) {
      draw();
      status(r.some(function (x) { return x === 'error'; }) ? 'error' : 'ok');
    });
  }

  function fetchCell(c) {
    var key = c[2], s = c[0] * CELL, w = c[1] * CELL, failed = 0;
    cells[key] = 'loading';
    var box = [w, s, w + CELL, s + CELL].map(function (v) { return v.toFixed(4); }).join('%2C');
    return Promise.all(KINDS.map(function (kd) {
      var q = 'where=1%3D1&geometry=' + box + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects' +
        '&outFields=' + (kd.layer === 37 ? 'objectid,name,trailnumber,trailsurface' : 'objectid,name') +
        '&returnGeometry=true&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.00004&f=json';
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var t = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
      return fetch(URL + '/' + kd.layer + '/query?' + q, ctl ? { signal: ctl.signal } : {}).then(function (r) {
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (!j || !Array.isArray(j.features)) throw new Error('bad data');
        j.features.forEach(function (f) {
          var a = f.attributes || {}, id = kd.layer + ':' + (a.objectid != null ? a.objectid : a.OBJECTID);
          if (feats[id] || !f.geometry || !f.geometry.paths) return;
          // the service gives [lng, lat]; Leaflet wants [lat, lng]
          feats[id] = { kd: kd, name: a.name || '', number: a.trailnumber || '', surface: a.trailsurface || '',
            paths: f.geometry.paths.map(function (p) { return p.map(function (c2) { return [c2[1], c2[0]]; }); }) };
        });
      }).catch(function () { clearTimeout(t); failed++; });
    })).then(function () {
      cells[key] = failed === KINDS.length ? 'error' : 'done';
      return cells[key];
    });
  }

  function draw() {
    if (!enabled || !map || map.getZoom() < MIN_ZOOM) return;
    Object.keys(feats).forEach(function (id) {
      if (drawn[id]) return;
      var f = feats[id], kd = f.kd;
      // a dark line under a pale one, so it reads on a summer photo, a winter photo or the topo map
      L.polyline(f.paths, { color: '#10140f', weight: kd.weight + 2.6, opacity: 0.55, interactive: false, lineCap: 'round', lineJoin: 'round', renderer: canvas() }).addTo(group);
      L.polyline(f.paths, { color: kd.kind === 'trail' ? '#ffffff' : '#fff1c9', weight: kd.weight, opacity: 0.95, dashArray: kd.dash || null,
        lineCap: 'round', lineJoin: 'round', interactive: false, renderer: canvas() }).addTo(group);
      // the same line again, invisible but tappable; the canvas allows a thumb-sized miss (tolerance)
      var hit = L.polyline(f.paths, { color: '#000', weight: 6, opacity: 0, interactive: true, renderer: canvas() });
      hit.on('click', function (e) {
        if (e && e.originalEvent && L.DomEvent && L.DomEvent.stopPropagation) L.DomEvent.stopPropagation(e);
        if (onTap) onTap({ kind: kd.kind, label: kd.label, name: f.name, number: f.number, surface: f.surface }, e && e.latlng);
      });
      hit.addTo(group);
      drawn[id] = true;
    });
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!group) return;
    if (!enabled) { group.clearLayers(); drawn = {}; ovKey = ''; status('off'); }
    else load();
  }

  SC.roads = { attach: attach, setEnabled: setEnabled, MIN_ZOOM: MIN_ZOOM, get enabled() { return enabled; } };
})();
