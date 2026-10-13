/* Names on the map: towns and public land, written over whatever base map is showing.
 *  - Towns: USGS Geographic Names (GNIS). Cities, towns and villages show from far out; smaller communities
 *    join in as you zoom closer.
 *  - Public land: PAD-US unit names (national forests, conservation areas, state parks...). The name is put
 *    on the part of the unit you can see, so a big forest is still labelled when you are zoomed into it.
 * Names that would overlap are dropped, biggest and most important first, so the map stays readable.
 * Needs a signal; the names for the last places you looked at are kept for the session. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var GNIS = 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer';
  var PADUS = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query';
  var MIN_ZOOM = 8, MAX_LABELS = 26;
  var map = null, layer = null, enabled = false, showTowns = null, timer = 0, seq = 0, cache = {}, order = [], current = null;

  function attach(m, o) {
    map = m; showTowns = o && o.showTowns;
    layer = L.layerGroup().addTo(map);
    map.on('moveend', schedule);
    map.on('rotate', function () { if (enabled && current) schedule(); });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(load, 500); }

  function getJson(url) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      function (e) { clearTimeout(t); throw e; });
  }
  // The view, widened a little and snapped to a grid, so small pans reuse what is already loaded.
  function snapped() {
    var b = map.getBounds(), z = map.getZoom(), g = z >= 13 ? 0.02 : z >= 11 ? 0.05 : z >= 9.5 ? 0.2 : 0.5;
    return { s: Math.floor(b.getSouth() / g) * g, n: Math.ceil(b.getNorth() / g) * g, w: Math.floor(b.getWest() / g) * g, e: Math.ceil(b.getEast() / g) * g, tier: z >= 13 ? 3 : z >= 11 ? 2 : z >= 9.5 ? 1 : 0 };
  }
  function env(b) {
    return '&geometry=' + [b.w, b.s, b.e, b.n].map(function (v) { return v.toFixed(3); }).join('%2C') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects';
  }
  function gnis(layerId, b) {
    return getJson(GNIS + '/' + layerId + '/query?where=1%3D1' + env(b) + '&outFields=gaz_name&outSR=4326&resultRecordCount=400&f=json').then(function (j) {
      return (j.features || []).map(function (f) {
        var g = f.geometry || {}, p = g.points ? g.points[0] : (g.x != null ? [g.x, g.y] : null);
        return p ? { name: f.attributes.gaz_name, lat: p[1], lng: p[0] } : null;
      }).filter(Boolean);
    });
  }
  function towns(b) {
    // Incorporated places come as "City of Stockton"; townships and counties in that list are not towns.
    var civic = gnis(1, b).then(function (list) {
      return list.map(function (t) { var m = /^(City|Town|Village|Borough) of (.+)$/.exec(t.name); return m ? { name: m[2], lat: t.lat, lng: t.lng, major: true } : null; }).filter(Boolean);
    });
    if (b.tier < 2) return civic;
    return Promise.all([civic, gnis(3, b)]).then(function (r) {
      var major = {};
      r[0].forEach(function (t) { major[t.name.toUpperCase()] = t; });
      // the populated-place point sits on the town itself, so use it and keep the "this is a real town" flag
      var out = r[1].map(function (t) { var k = t.name.toUpperCase(), isMajor = !!major[k]; delete major[k]; return { name: t.name, lat: t.lat, lng: t.lng, major: isMajor }; });
      Object.keys(major).forEach(function (k) { out.push(major[k]); });
      return out;
    });
  }
  function lands(b) {
    var minAcres = b.tier === 0 ? 5000 : b.tier === 1 ? 500 : b.tier === 2 ? 40 : 0;
    var url = PADUS + '?where=' + encodeURIComponent('GIS_Acres >= ' + minAcres) + env(b) + '&outFields=Unit_Nm,GIS_Acres&orderByFields=' + encodeURIComponent('GIS_Acres DESC') +
      '&returnGeometry=true&outSR=4326&geometryPrecision=4&maxAllowableOffset=' + ((b.e - b.w) / 180).toFixed(5) + '&resultRecordCount=120&f=json';
    return getJson(url).then(function (j) {
      return (j.features || []).map(function (f) {
        var nm = f.attributes.Unit_Nm, rings = f.geometry && f.geometry.rings;
        if (!nm || !rings || /^unnamed|^unknown/i.test(nm)) return null;
        var bb = { s: 90, n: -90, w: 180, e: -180 };
        rings.forEach(function (r) { r.forEach(function (p) { if (p[0] < bb.w) bb.w = p[0]; if (p[0] > bb.e) bb.e = p[0]; if (p[1] < bb.s) bb.s = p[1]; if (p[1] > bb.n) bb.n = p[1]; }); });
        return { name: nm, acres: f.attributes.GIS_Acres || 0, rings: rings, box: bb };
      }).filter(Boolean);
    });
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
  // Where to write a unit's name: its middle if you can see that, otherwise the visible part nearest mid-screen.
  function landPoint(u, view, c) {
    var mx = (u.box.w + u.box.e) / 2, my = (u.box.s + u.box.n) / 2;
    if (mx > view.w && mx < view.e && my > view.s && my < view.n && inside(u.rings, mx, my)) return { lat: my, lng: mx };
    var best = null, bd = Infinity;
    for (var a = 1; a <= 7; a++) for (var b = 1; b <= 5; b++) {
      var lat = view.s + (view.n - view.s) * a / 8, lng = view.w + (view.e - view.w) * b / 6;
      if (lat < u.box.s || lat > u.box.n || lng < u.box.w || lng > u.box.e || !inside(u.rings, lng, lat)) continue;
      var d = (lat - c.lat) * (lat - c.lat) + (lng - c.lng) * (lng - c.lng);
      if (d < bd) { bd = d; best = { lat: lat, lng: lng }; }
    }
    return best;
  }

  function load() {
    if (!enabled || !map) return;
    if (map.getZoom() < MIN_ZOOM) { current = null; layer.clearLayers(); return; }
    var b = snapped(), key = [b.tier, b.s.toFixed(2), b.w.toFixed(2), b.n.toFixed(2), b.e.toFixed(2)].join(',');
    if (cache[key]) { current = cache[key]; render(); return; }
    var mine = ++seq;
    if (current) render();      // keep the old names in the right places while the new ones load
    Promise.all([towns(b).catch(function () { return null; }), lands(b).catch(function () { return null; })]).then(function (r) {
      if (!r[0] && !r[1]) return;                            // no signal: leave what is showing
      var data = { towns: r[0] || [], lands: r[1] || [] };
      if (r[0] && r[1]) { cache[key] = data; order.push(key); while (order.length > 30) delete cache[order.shift()]; }
      if (mine === seq) { current = data; render(); }
    });
  }

  function render() {
    layer.clearLayers();
    if (!enabled || !current) return;
    var vb = map.getBounds(), view = { s: vb.getSouth(), n: vb.getNorth(), w: vb.getWest(), e: vb.getEast() }, c = map.getCenter(), size = map.getSize();
    var list = [], named = {};
    if (!showTowns || showTowns()) current.towns.forEach(function (t) { list.push({ name: t.name, lat: t.lat, lng: t.lng, cls: t.major ? 'pl-town pl-major' : 'pl-town', rank: t.major ? 0 : 2, px: t.major ? 8.2 : 7 }); });
    current.lands.forEach(function (u) {
      if (named[u.name]) return;
      var p = landPoint(u, view, c);
      if (!p) return;
      named[u.name] = 1;
      list.push({ name: u.name, lat: p.lat, lng: p.lng, cls: 'pl-land', rank: 1, acres: u.acres, px: 6.6 });
    });
    list.sort(function (a, b) { return a.rank - b.rank || (b.acres || 0) - (a.acres || 0); });
    var taken = [], shown = 0;
    for (var i = 0; i < list.length && shown < MAX_LABELS; i++) {
      var it = list[i], pt = map.latLngToContainerPoint([it.lat, it.lng]);
      var w = it.name.length * it.px + 12, hgt = 20, box = { l: pt.x - w / 2, r: pt.x + w / 2, t: pt.y - hgt / 2, b: pt.y + hgt / 2 };
      if (box.r < 0 || box.l > size.x || box.b < 0 || box.t > size.y) continue;
      var clash = false;
      for (var k = 0; k < taken.length; k++) { var o = taken[k]; if (box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t) { clash = true; break; } }
      if (clash) continue;
      taken.push(box); shown++;
      var span = document.createElement('span');
      span.className = 'pl ' + it.cls; span.textContent = it.name;
      L.marker([it.lat, it.lng], { icon: L.divIcon({ className: 'pl-wrap', html: span, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: -200 }).addTo(layer);
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!layer) return;
    if (!enabled) { layer.clearLayers(); return; }
    load();
  }
  function refresh() { if (enabled && current) render(); }

  SC.labels = { attach: attach, setEnabled: setEnabled, refresh: refresh };
})();
