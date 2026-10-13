/* Roads and trails drawn as lines over any base map, so they show on the photo maps too.
 *   solid line   = a road
 *   long dashes  = a 4WD or closed road (two-track, forest road)
 *   dots         = a trail
 * Lines come from the USGS National Map transportation service (roads from Census TIGER, trails from the
 * agencies that manage them). They are national records, good to a few yards on most roads but not surveyed:
 * a woods road can sit 10 to 20 yards off, be shown as the wrong kind, or be missing.
 *
 * Detail follows the zoom:
 *   far out      interstates and U.S. routes from the small-scale road set (one light request per view)
 *   county view  highways and the roads that connect towns, fetched in squares of about 12 miles
 *   close in     every road, ramp, 4WD road and trail, fetched in squares of about 3 miles
 * To keep the map smooth, all the lines of one kind are drawn as a single shape (a dozen shapes in all, not
 * thousands), and what is on screen stays there until its replacement has loaded, so lines do not blink out
 * when you cross from one level of detail to the next.
 * Route numbers are written about every 5 miles along a highway, never crowded together. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var URL = 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer';
  var KIND = {
    29: { kind: 'road', label: 'Highway', weight: 3.2 },
    30: { kind: 'road', label: 'Highway', weight: 3 },
    31: { kind: 'road', label: 'Road', weight: 2.6 },
    32: { kind: 'road', label: 'Local road', weight: 2.2 },
    33: { kind: 'road', label: 'Ramp', weight: 2 },
    35: { kind: 'track', label: '4WD road', weight: 2.4, dash: '10 7' },
    36: { kind: 'track', label: 'Closed road', weight: 2.4, dash: '10 7' },
    37: { kind: 'trail', label: 'Trail', weight: 2.6, dash: '1 7' }
  };
  function store(cell, layers, offset) { return { cell: cell, layers: layers, offset: offset, cells: {}, feats: {}, count: 0, dirty: false, group: null }; }
  var MID = store(0.2, [29, 30, 31], 0.00015), FULL = store(0.05, [29, 30, 31, 32, 33, 35, 36, 37], 0.00004);
  var MID_ZOOM = 11, MIN_ZOOM = 13, MAX_FEATS = 9000, FIVE_MILES = 8047;
  var map = null, ovLayer = null, shieldLayer = null, enabled = false, onStatus = null, timer = 0;
  var ovCache = {}, ovOrder = [], ovSeq = 0, ovKey = '', ovList = [];

  function attach(m, o) {
    map = m; onStatus = o && o.onStatus;
    ovLayer = L.layerGroup(); MID.group = L.layerGroup(); FULL.group = L.layerGroup(); shieldLayer = L.layerGroup();
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
    var base = { interactive: false, lineCap: 'round', lineJoin: 'round', noClip: true, smoothFactor: 1.2 };
    L.polyline(paths, Object.assign({ color: '#10140f', weight: weight + 2.6, opacity: 0.5 }, base)).addTo(group);
    L.polyline(paths, Object.assign({ color: color, weight: weight, opacity: 0.95, dashArray: dash || null }, base)).addTo(group);
  }
  function clean(v) { return String(v == null ? '' : v).trim().replace(/^I-?\s*/i, ''); }
  // which numbered route a line belongs to, biggest kind first: { text, cls } or null
  function routeOf(a) {
    var i = clean(a.interstate || a.INTERSTATE), u = clean(a.us_route || a.US_ROUTE), s = clean(a.state_route || a.ST_ROUTE);
    return i ? { text: i, cls: 'rs-i', rank: 0 } : u ? { text: u, cls: 'rs-us', rank: 1 } : s ? { text: s, cls: 'rs-st', rank: 2 } : null;
  }

  /* ---- far out: main highways ---- */
  function overview() {
    var z = map.getZoom(), b = map.getBounds();
    function closeUpOff() { show(MID.group, false); show(FULL.group, false); }
    if (z < 5) { show(ovLayer, false); closeUpOff(); shields(); return; }
    show(ovLayer, true);
    var tier = z < 8.5 ? 0 : 1, g = tier === 0 ? 4 : 0.5;
    var box = { s: Math.floor(b.getSouth() / g) * g, n: Math.ceil(b.getNorth() / g) * g, w: Math.floor(b.getWest() / g) * g, e: Math.ceil(b.getEast() / g) * g };
    var key = [tier, box.s, box.w, box.n, box.e].join(',');
    if (key === ovKey) { closeUpOff(); shields(); return; }
    function paint(list) {
      closeUpOff();          // the close-up lines stayed on screen until now, so nothing blinked out
      ovLayer.clearLayers(); ovKey = key; ovList = list;
      var classes = [{ w: 1.6, c: '#fff1c9', paths: [] }, { w: 2.2, c: '#fff1c9', paths: [] }, { w: 3, c: '#ffe08a', paths: [] }];
      list.forEach(function (f) { var k = !f.route ? 0 : f.route.rank === 0 ? 2 : f.route.rank === 1 ? 1 : 0; f.paths.forEach(function (p) { classes[k].paths.push(p); }); });
      classes.forEach(function (k) { strokes(ovLayer, k.paths, k.w, k.c); });
      shields();
    }
    if (ovCache[key]) { paint(ovCache[key]); return; }
    var mine = ++ovSeq;
    var where = tier === 1 ? "INTERSTATE <> ' ' OR US_ROUTE <> ' ' OR ST_ROUTE <> ' '" : '1=1';
    status('loading');
    pages(URL + '/' + (tier === 0 ? 8 : 9) + '/query?where=' + encodeURIComponent(where) + '&geometry=' + [box.w, box.s, box.e, box.n].join('%2C') +
      '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=INTERSTATE,US_ROUTE,ST_ROUTE&returnGeometry=true&outSR=4326' +
      '&geometryPrecision=4&maxAllowableOffset=' + ((box.e - box.w) / 600).toFixed(5) + '&f=json').then(function (features) {
      var list = features.filter(function (f) { return f.geometry && f.geometry.paths; }).map(function (f) {
        return { route: routeOf(f.attributes || {}), paths: f.geometry.paths.map(function (p) { return p.map(function (c) { return [c[1], c[0]]; }); }) };
      });
      ovCache[key] = list; ovOrder.push(key); while (ovOrder.length > 20) delete ovCache[ovOrder.shift()];
      // the old highways stay on screen until these are ready, then swap in one go
      if (mine === ovSeq && enabled && map.getZoom() < MID_ZOOM) paint(list);
      status('ok');
    }).catch(function () { status('error'); });
  }
  // The service hands back at most 2,000 lines at a time; keep asking until it has sent them all (three rounds at most).
  function pages(url, offset, got) {
    return getJson(url + (offset ? '&resultOffset=' + offset : '')).then(function (j) {
      if (!j || !Array.isArray(j.features)) throw new Error('bad data');
      var all = (got || []).concat(j.features);
      return j.exceededTransferLimit && j.features.length && all.length < 6000 ? pages(url, all.length, all) : all;
    });
  }

  /* ---- county view and close in: real road lines, fetched in squares ---- */
  function load() {
    if (!enabled || !map) return;
    var z = map.getZoom();
    if (z < MID_ZOOM) { overview(); return; }
    var st = z < MIN_ZOOM ? MID : FULL, other = st === MID ? FULL : MID;
    show(st.group, true);
    if (st.count > MAX_FEATS) { st.cells = {}; st.feats = {}; st.count = 0; st.dirty = true; }   // a long session: start the store over
    var b = map.getBounds(), todo = [], waiting = false;
    for (var la = Math.floor(b.getSouth() / st.cell); la <= Math.floor(b.getNorth() / st.cell); la++) {
      for (var ln = Math.floor(b.getWest() / st.cell); ln <= Math.floor(b.getEast() / st.cell); ln++) {
        var k = la + ',' + ln;
        if (!st.cells[k] || st.cells[k] === 'error') todo.push([la, ln, k]);
        else if (st.cells[k] === 'loading') waiting = true;
      }
    }
    draw(st);
    // whatever was showing before stays underneath until the lines for this view are all in
    if (!todo.length && !waiting) { show(ovLayer, false); show(other.group, false); shields(); status('ok'); return; }
    shields();
    if (!todo.length) return;
    if (todo.length > 6) todo = todo.slice(0, 6);
    status('loading');
    Promise.all(todo.map(function (c) { return fetchCell(st, c); })).then(function (r) {
      var bad = r.some(function (x) { return x === 'error'; });
      status(bad ? 'error' : 'ok');
      if (!enabled) return;
      if (bad) { draw(st); shields(); } else load();    // draw what arrived and pick up any squares still missing (a failed square waits for the next move)
    });
  }

  function fetchCell(st, c) {
    var key = c[2], s = c[0] * st.cell, w = c[1] * st.cell, failed = 0;
    st.cells[key] = 'loading';
    var box = [w, s, w + st.cell, s + st.cell].map(function (v) { return v.toFixed(4); }).join('%2C');
    return Promise.all(st.layers.map(function (layer) {
      var q = 'where=1%3D1&geometry=' + box + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects' +
        '&outFields=' + (layer === 37 ? 'objectid,name,trailnumber,trailsurface' : 'objectid,name,interstate,us_route,state_route') +
        '&returnGeometry=true&outSR=4326&geometryPrecision=5&maxAllowableOffset=' + st.offset + '&f=json';
      return pages(URL + '/' + layer + '/query?' + q).then(function (features) {
        features.forEach(function (f) {
          var a = f.attributes || {}, id = layer + ':' + (a.objectid != null ? a.objectid : a.OBJECTID);
          if (st.feats[id] || !f.geometry || !f.geometry.paths) return;
          var bb = { s: 90, n: -90, w: 180, e: -180 };
          // the service gives [lng, lat]; Leaflet wants [lat, lng]
          var paths = f.geometry.paths.map(function (p) {
            return p.map(function (c2) { if (c2[0] < bb.w) bb.w = c2[0]; if (c2[0] > bb.e) bb.e = c2[0]; if (c2[1] < bb.s) bb.s = c2[1]; if (c2[1] > bb.n) bb.n = c2[1]; return [c2[1], c2[0]]; });
          });
          st.feats[id] = { layer: layer, name: a.name || '', number: a.trailnumber || '', surface: a.trailsurface || '', route: layer === 37 ? null : routeOf(a), paths: paths, box: bb };
          st.count++; st.dirty = true;
        });
      }).catch(function () { failed++; });
    })).then(function () {
      st.cells[key] = failed === st.layers.length ? 'error' : 'done';
      return st.cells[key];
    });
  }

  function draw(st) {
    if (!st.dirty) return;
    st.dirty = false;
    var by = {};
    Object.keys(st.feats).forEach(function (id) { var f = st.feats[id]; (by[f.layer] || (by[f.layer] = [])).push.apply(by[f.layer], f.paths); });
    st.group.clearLayers();
    // minor roads first so the highways are drawn on top of them
    [37, 36, 35, 33, 32, 31, 30, 29].forEach(function (layer) {
      var kd = KIND[layer];
      if (by[layer]) strokes(st.group, by[layer], kd.weight, kd.kind === 'trail' ? '#ffffff' : layer <= 30 ? '#ffe08a' : '#fff1c9', kd.dash);
    });
  }

  /* ---- route numbers: one about every 5 miles along a highway, and never two close together on screen ---- */
  function shields() {
    shieldLayer.clearLayers();
    if (!enabled || !map) return;
    var z = map.getZoom();
    if (z < 6) { show(shieldLayer, false); return; }
    show(shieldLayer, true);
    var list = z < MID_ZOOM ? ovList : Object.keys((z < MIN_ZOOM ? MID : FULL).feats).map(function (id) { return (z < MIN_ZOOM ? MID : FULL).feats[id]; });
    var routed = list.filter(function (f) { return f.route; }).sort(function (a, b) { return a.route.rank - b.route.rank; });
    var b = map.getBounds(), s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast(), size = map.getSize();
    var placed = [], kLng = Math.cos((s + n) / 2 * Math.PI / 180) * 111320, minPx = 92 * 92;
    for (var i = 0; i < routed.length && placed.length < 22; i++) {
      var f = routed[i];
      for (var p = 0; p < f.paths.length && placed.length < 22; p++) {
        var path = f.paths[p], step = Math.max(1, Math.floor(path.length / 12));
        for (var v = Math.floor(step / 2); v < path.length; v += step) {
          var lat = path[v][0], lng = path[v][1];
          if (lat < s || lat > n || lng < w || lng > e) continue;
          var pt = map.latLngToContainerPoint(path[v]), ok = pt.x > 30 && pt.y > 70 && pt.x < size.x - 30 && pt.y < size.y - 30;
          for (var q = 0; ok && q < placed.length; q++) {
            var o = placed[q], dx = pt.x - o.x, dy = pt.y - o.y;
            if (dx * dx + dy * dy < minPx) ok = false;
            else if (o.text === f.route.text && o.cls === f.route.cls) {
              var my = (lat - o.lat) * 111320, mx = (lng - o.lng) * kLng;
              if (mx * mx + my * my < FIVE_MILES * FIVE_MILES) ok = false;
            }
          }
          if (!ok) continue;
          placed.push({ x: pt.x, y: pt.y, lat: lat, lng: lng, text: f.route.text, cls: f.route.cls });
          if (placed.length >= 22) break;
        }
      }
    }
    placed.forEach(function (o) {
      var span = document.createElement('span');
      span.className = 'rs ' + o.cls; span.textContent = o.text;
      L.marker([o.lat, o.lng], { icon: L.divIcon({ className: 'rs-wrap', html: span, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: -150 }).addTo(shieldLayer);
    });
  }

  // The road or trail under a tap (within about a thumb's width), or null. Only when zoomed in to full detail.
  function pick(latlng) {
    if (!enabled || !map || !latlng || map.getZoom() < MIN_ZOOM) return null;
    var tap = map.latLngToContainerPoint(latlng), tol = 16, best = null, bd = tol * tol;
    var c = map.containerPointToLatLng([tap.x + tol, tap.y + tol]), padLat = Math.abs(c.lat - latlng.lat) * 1.5 + 1e-5, padLng = Math.abs(c.lng - latlng.lng) * 1.5 + 1e-5;
    Object.keys(FULL.feats).forEach(function (id) {
      var f = FULL.feats[id];
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
    var kd = KIND[best.layer];
    return { kind: kd.kind, label: kd.label, name: best.name, number: best.number, surface: best.surface };
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!map) return;
    if (!enabled) { [ovLayer, MID.group, FULL.group, shieldLayer].forEach(function (l) { show(l, false); }); status('off'); }
    else load();
  }

  SC.roads = { attach: attach, setEnabled: setEnabled, pick: pick, MIN_ZOOM: MID_ZOOM, get enabled() { return enabled; } };
})();
