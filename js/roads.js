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

  function load() {
    if (!enabled || !map) return;
    if (map.getZoom() < MIN_ZOOM) { group.clearLayers(); drawn = {}; status('zoom'); return; }
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
      L.polyline(f.paths, { color: '#10140f', weight: kd.weight + 2.6, opacity: 0.55, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(group);
      L.polyline(f.paths, { color: kd.kind === 'trail' ? '#ffffff' : '#fff1c9', weight: kd.weight, opacity: 0.95, dashArray: kd.dash || null,
        lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
      // a wide invisible line on top makes it easy to tap with a thumb
      var hit = L.polyline(f.paths, { color: '#000', weight: 18, opacity: 0, interactive: true });
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
    if (!enabled) { group.clearLayers(); drawn = {}; status('off'); }
    else load();
  }

  SC.roads = { attach: attach, setEnabled: setEnabled, MIN_ZOOM: MIN_ZOOM, get enabled() { return enabled; } };
})();
