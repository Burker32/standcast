/* Names on the map: towns and public land, written over whatever base map is showing.
 *  - States, far out. Then towns by size: big cities first, smaller towns as you zoom in (U.S. Census 2020
 *    incorporated places, with population), and at close zoom the small communities from USGS names (GNIS).
 *  - Public land: PAD-US unit names (national forests, conservation areas, state parks...). The name is put
 *    on the part of the unit you can see, so a big forest is still labelled when you are zoomed into it.
 * Names that would overlap are dropped, biggest and most important first, so the map stays readable.
 * Needs a signal; the names for the last places you looked at are kept for the session. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var GNIS = 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer';
  var PADUS = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query';
  var PLACES = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25/query';   // incorporated places, 2020 census
  var MIN_ZOOM = 4, MAX_LABELS = 26;
  // How much shows at each zoom, so a zoomed-out map stays quick and readable:
  //   far out: state names only, then the big cities, then smaller towns, then every community and all public land.
  function minPop(z) { return z < 6 ? Infinity : z < 7 ? 250000 : z < 8 ? 100000 : z < 9 ? 25000 : z < 10 ? 8000 : z < 11 ? 2000 : z < 12 ? 300 : 0; }
  var STATES = [['Alabama', 32.8, -86.8], ['Alaska', 64.2, -152.5], ['Arizona', 34.3, -111.7], ['Arkansas', 34.9, -92.4], ['California', 37.2, -119.4], ['Colorado', 39.0, -105.5], ['Connecticut', 41.6, -72.7], ['Delaware', 39.0, -75.5], ['Florida', 28.6, -81.7], ['Georgia', 32.7, -83.4], ['Hawaii', 20.8, -156.9], ['Idaho', 44.4, -114.6], ['Illinois', 40.0, -89.2], ['Indiana', 39.9, -86.3], ['Iowa', 42.1, -93.5], ['Kansas', 38.5, -98.4], ['Kentucky', 37.5, -85.3], ['Louisiana', 31.1, -92.0], ['Maine', 45.4, -69.2], ['Maryland', 39.0, -76.8], ['Massachusetts', 42.3, -71.8], ['Michigan', 44.3, -85.4], ['Minnesota', 46.3, -94.3], ['Mississippi', 32.7, -89.7], ['Missouri', 38.4, -92.5], ['Montana', 47.0, -109.6], ['Nebraska', 41.5, -99.8], ['Nevada', 39.3, -116.6], ['New Hampshire', 43.7, -71.6], ['New Jersey', 40.1, -74.7], ['New Mexico', 34.4, -106.1], ['New York', 42.9, -75.5], ['North Carolina', 35.6, -79.4], ['North Dakota', 47.4, -100.5], ['Ohio', 40.3, -82.8], ['Oklahoma', 35.6, -97.5], ['Oregon', 43.9, -120.6], ['Pennsylvania', 40.9, -77.8], ['Rhode Island', 41.7, -71.5], ['South Carolina', 33.9, -80.9], ['South Dakota', 44.4, -100.2], ['Tennessee', 35.8, -86.4], ['Texas', 31.5, -99.3], ['Utah', 39.3, -111.7], ['Vermont', 44.1, -72.7], ['Virginia', 37.5, -78.8], ['Washington', 47.4, -120.5], ['West Virginia', 38.6, -80.6], ['Wisconsin', 44.6, -89.9], ['Wyoming', 43.0, -107.5]];
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
    var b = map.getBounds(), z = map.getZoom(), g = z >= 13 ? 0.02 : z >= 11 ? 0.05 : z >= 9.5 ? 0.2 : z >= 7.5 ? 0.5 : 2;
    return { s: Math.floor(b.getSouth() / g) * g, n: Math.ceil(b.getNorth() / g) * g, w: Math.floor(b.getWest() / g) * g, e: Math.ceil(b.getEast() / g) * g,
      z: Math.floor(z), tier: z >= 13 ? 3 : z >= 11 ? 2 : z >= 9.5 ? 1 : 0 };
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
  // The census spells out merged city-county governments: "Nashville-Davidson metropolitan government (balance)".
  function tidy(name) {
    return String(name || '').replace(/\s*\(balance\)/i, '').replace(/\s+(metropolitan|metro|unified|consolidated|urban county)\s+government.*$/i, '')
      .replace(/\/.*$/, '').replace(/-(Davidson|Fayette|Silver Bow|Clarke County|Richmond County|Bibb County|Deer Lodge County)$/i, '').replace(/\s+(city|municipality)$/, '').trim();   // lower-case "city" is the census type word; "Kansas City" keeps its name
  }
  // Towns come with their census population, so the bigger place wins when two names would overlap and
  // only places big enough for the zoom are asked for at all. One small request, no shapes.
  function towns(b) {
    var pop = minPop(b.z);
    if (pop === Infinity) return Promise.resolve([]);
    var civic = getJson(PLACES + '?where=' + encodeURIComponent('POP100 >= ' + pop) + env(b) +
      '&outFields=BASENAME,POP100,CENTLAT,CENTLON&returnGeometry=false&orderByFields=' + encodeURIComponent('POP100 DESC') + '&resultRecordCount=70&f=json').then(function (j) {
      return (j.features || []).map(function (f) {
        var a = f.attributes, lat = parseFloat(a.CENTLAT), lng = parseFloat(a.CENTLON);
        return isFinite(lat) && isFinite(lng) ? { name: tidy(a.BASENAME), lat: lat, lng: lng, pop: a.POP100 || 0 } : null;
      }).filter(Boolean);
    });
    return civic;
  }
  // Zoomed in, the small unincorporated communities the census list leaves out are added when they arrive
  // (that service is slower, so the towns do not wait for it).
  function hamlets(b, data) {
    if (b.z < 12) return;
    gnis(3, b).then(function (list) {
      var have = {};
      data.towns.forEach(function (t) { have[t.name.toUpperCase()] = 1; });
      list.forEach(function (t) { if (!have[t.name.toUpperCase()]) { have[t.name.toUpperCase()] = 1; data.towns.push({ name: t.name, lat: t.lat, lng: t.lng, pop: 0 }); } });
      if (current === data) render();
    }).catch(function () {});
  }
  function lands(b) {
    if (b.z < 9) return Promise.resolve([]);      // far out, public land names would only be noise
    var minAcres = b.z < 10 ? 20000 : b.z < 11 ? 4000 : b.z < 12 ? 500 : b.z < 13 ? 40 : 0;
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
    var b = snapped(), key = [b.z, b.s.toFixed(2), b.w.toFixed(2), b.n.toFixed(2), b.e.toFixed(2)].join(',');
    if (cache[key]) { current = cache[key]; render(); return; }
    var mine = ++seq;
    if (current) render();      // keep the old names in the right places while the new ones load
    Promise.all([towns(b).catch(function () { return null; }), lands(b).catch(function () { return null; })]).then(function (r) {
      if (!r[0] && !r[1]) return;                            // no signal: leave what is showing
      var data = { towns: r[0] || [], lands: r[1] || [] };
      if (r[0] && r[1]) { cache[key] = data; order.push(key); while (order.length > 30) delete cache[order.shift()]; }
      if (mine === seq) { current = data; render(); }
      if (r[0]) hamlets(b, data);
    });
  }

  function render() {
    layer.clearLayers();
    if (!enabled || !current) return;
    var vb = map.getBounds(), view = { s: vb.getSouth(), n: vb.getNorth(), w: vb.getWest(), e: vb.getEast() }, c = map.getCenter(), size = map.getSize();
    var list = [], named = {};
    var z = map.getZoom(), ownNames = !showTowns || showTowns();
    if (z < 7.5 && ownNames) STATES.forEach(function (s) { list.push({ name: s[0], lat: s[1], lng: s[2], cls: 'pl-state', rank: 0, acres: 1e12, px: 9.5 }); });
    if (ownNames) current.towns.forEach(function (t) {
      var big = t.pop >= (z < 9 ? 250000 : z < 11 ? 25000 : 2500);      // "big" is relative to what else is on screen at this zoom
      list.push({ name: t.name, lat: t.lat, lng: t.lng, cls: big ? 'pl-town pl-major' : 'pl-town', rank: t.pop > 0 ? 0 : 2, acres: 1e9 + t.pop, px: big ? 8.2 : 7 });
    });
    var landMax = z < 11 ? 5 : 12, landCount = 0;       // only a few public land names until you are zoomed in
    current.lands.forEach(function (u) {
      if (named[u.name] || landCount >= landMax) return;
      var p = landPoint(u, view, c);
      if (!p) return;
      named[u.name] = 1; landCount++;
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
