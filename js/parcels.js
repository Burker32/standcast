/* Property lines with owner names, drawn over any base map.
 * Source so far: the Wisconsin Statewide Parcel Map (Version 12, 2026), published by the State of Wisconsin
 * (State Cartographer's Office for the Department of Administration) from county and municipal tax parcel
 * records. Missouri has no statewide public parcel layer: each county keeps its own, mostly behind a vendor's
 * map viewer, so Missouri lines need a county's permission or a licensed data provider.
 * Parcel lines are tax maps, not surveys, and can be yards off on the ground.
 * Fetched in squares of about a mile and a quarter when zoomed in, kept for the session; tap inside a parcel
 * for its owner. All lines are drawn as one shape, like the roads, so panning stays smooth. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var SOURCES = [{
    name: 'Wisconsin', s: 42.4, n: 47.4, w: -93.0, e: -86.2,
    url: 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query',
    fields: 'OBJECTID,OWNERNME1,OWNERNME2,GISACRES,DEEDACRES,PARCELID,SITEADRESS,CONAME',
    credit: 'Wisconsin Statewide Parcel Map (V12), State of Wisconsin, from county tax records'
  }];
  var CELL = 0.02, MIN_ZOOM = 14, MAX_FEATS = 12000;
  var map = null, group = null, enabled = false, timer = 0, onStatus = null;
  var cells = {}, feats = {}, count = 0, dirty = false;

  function attach(m, o) {
    map = m; onStatus = o && o.onStatus;
    group = L.layerGroup();
    map.on('moveend', schedule);
  }
  function status(s, extra) { if (onStatus) onStatus(s, extra); }
  function schedule() { clearTimeout(timer); timer = setTimeout(load, 450); }
  function sourceAt(lat, lng) {
    for (var i = 0; i < SOURCES.length; i++) { var s = SOURCES[i]; if (lat >= s.s && lat <= s.n && lng >= s.w && lng <= s.e) return s; }
    return null;
  }
  // Is any covered state in view at all?
  function covered() {
    var b = map.getBounds();
    return SOURCES.some(function (s) { return b.getSouth() < s.n && b.getNorth() > s.s && b.getWest() < s.e && b.getEast() > s.w; });
  }
  function getJson(url) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      function (e) { clearTimeout(t); throw e; });
  }
  // up to 6,000 parcels per square: the service sends 2,000 at a time
  function pages(url, got) {
    return getJson(url + (got && got.length ? '&resultOffset=' + got.length : '')).then(function (j) {
      if (!j || !Array.isArray(j.features)) throw new Error('bad data');
      var all = (got || []).concat(j.features);
      return j.exceededTransferLimit && j.features.length && all.length < 6000 ? pages(url, all) : all;
    });
  }

  function load() {
    if (!enabled || !map) return;
    if (map.getZoom() < MIN_ZOOM || !covered()) { if (map.hasLayer(group)) map.removeLayer(group); status(map.getZoom() < MIN_ZOOM ? 'zoom' : 'uncovered'); return; }
    if (!map.hasLayer(group)) group.addTo(map);
    if (count > MAX_FEATS) { cells = {}; feats = {}; count = 0; dirty = true; }
    var b = map.getBounds(), todo = [];
    for (var la = Math.floor(b.getSouth() / CELL); la <= Math.floor(b.getNorth() / CELL); la++) {
      for (var ln = Math.floor(b.getWest() / CELL); ln <= Math.floor(b.getEast() / CELL); ln++) {
        var k = la + ',' + ln, src = sourceAt((la + 0.5) * CELL, (ln + 0.5) * CELL);
        if (src && (!cells[k] || cells[k] === 'error')) todo.push({ la: la, ln: ln, k: k, src: src });
      }
    }
    draw();
    if (!todo.length) { status('ok'); return; }
    if (todo.length > 9) todo = todo.slice(0, 9);
    status('loading');
    Promise.all(todo.map(fetchCell)).then(function (r) {
      var bad = r.some(function (x) { return x === 'error'; });
      status(bad ? 'error' : 'ok');
      if (!enabled) return;
      if (bad) draw(); else load();
    });
  }

  function fetchCell(c) {
    cells[c.k] = 'loading';
    var s = c.la * CELL, w = c.ln * CELL;
    var q = 'where=1%3D1&geometry=' + [w, s, w + CELL, s + CELL].map(function (v) { return v.toFixed(4); }).join('%2C') +
      '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=' + c.src.fields +
      '&returnGeometry=true&outSR=4326&geometryPrecision=6&maxAllowableOffset=0.00002&f=json';
    return pages(c.src.url + '?' + q).then(function (list) {
      list.forEach(function (f) {
        var a = f.attributes || {}, id = c.src.name + ':' + a.OBJECTID;
        if (feats[id] || !f.geometry || !f.geometry.rings) return;
        var bb = { s: 90, n: -90, w: 180, e: -180 };
        f.geometry.rings.forEach(function (r) { r.forEach(function (p) { if (p[0] < bb.w) bb.w = p[0]; if (p[0] > bb.e) bb.e = p[0]; if (p[1] < bb.s) bb.s = p[1]; if (p[1] > bb.n) bb.n = p[1]; }); });
        feats[id] = { a: a, src: c.src, rings: f.geometry.rings, box: bb };
        count++; dirty = true;
      });
      cells[c.k] = 'done';
      return 'done';
    }).catch(function () { cells[c.k] = 'error'; return 'error'; });
  }

  function draw() {
    if (!dirty) return;
    dirty = false;
    var rings = [];
    Object.keys(feats).forEach(function (id) { feats[id].rings.forEach(function (r) { rings.push(r.map(function (p) { return [p[1], p[0]]; })); }); });
    group.clearLayers();
    if (!rings.length) return;
    var base = { fill: false, interactive: false, noClip: true, smoothFactor: 1, lineJoin: 'round' };
    // a dark edge under a thin white line: reads on summer photos, winter photos and the topo map
    L.polygon(rings, Object.assign({ color: '#10140f', weight: 3.4, opacity: 0.45 }, base)).addTo(group);
    L.polygon(rings, Object.assign({ color: '#ffffff', weight: 1.4, opacity: 0.95 }, base)).addTo(group);
  }

  function inside(rings, lng, lat) {
    var hit = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) hit = !hit;
      }
    }
    return hit;
  }
  // The parcel under a tap: { owner, owner2, acres, deedAcres, id, address, county, credit } or null.
  function pick(latlng) {
    if (!enabled || !map || !latlng || map.getZoom() < MIN_ZOOM) return null;
    var lat = latlng.lat, lng = latlng.lng, best = null;
    Object.keys(feats).forEach(function (id) {
      var f = feats[id];
      if (best || lat < f.box.s || lat > f.box.n || lng < f.box.w || lng > f.box.e) return;
      if (inside(f.rings, lng, lat)) best = f;
    });
    if (!best) return null;
    var a = best.a;
    return { owner: a.OWNERNME1 || '', owner2: a.OWNERNME2 || '', acres: a.GISACRES, deedAcres: a.DEEDACRES, id: a.PARCELID || '',
      address: a.SITEADRESS || '', county: a.CONAME || '', credit: best.src.credit };
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!map) return;
    if (!enabled) { if (map.hasLayer(group)) map.removeLayer(group); status('off'); }
    else load();
  }

  SC.parcels = { attach: attach, setEnabled: setEnabled, pick: pick, covered: function () { return map ? covered() : false; }, MIN_ZOOM: MIN_ZOOM, STATES: SOURCES.map(function (s) { return s.name; }) };
})();
