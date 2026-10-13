/* Public land boundaries from PAD-US 4.1 (USGS Protected Areas Database of the United States),
 * served free by Esri as a feature service. Federal, state, local and some private conservation
 * land, colored by who manages it. Tap an area for its name, manager and public access.
 * PAD-US is an inventory, not a legal survey: lines can be off, and "public" does not always mean
 * open to hunting. Check the managing agency's maps and regulations. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};

  var URL = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query';
  var FIELDS = 'OBJECTID,Unit_Nm,Mang_Name,Mang_Type,Loc_Mang,Pub_Access,Des_Tp,GIS_Acres';
  var CELL = 0.1;          // fetch in 0.1 degree squares so panning reuses what is loaded
  var MIN_ZOOM = 11;

  var map, pane, group, enabled = false, onTap = null, onStatus = null;
  var cells = {};          // "lat,lng" -> 'loading' | 'done' | 'error'
  var feats = {};          // OBJECTID -> { props, rings }
  var drawn = {};          // OBJECTID -> true
  var timer = 0;

  var TYPE = {
    FED: { color: '#f2b134', label: 'Federal' },
    STAT: { color: '#3fa7d6', label: 'State' },
    LOC: { color: '#a57fe0', label: 'Local' },
    DIST: { color: '#a57fe0', label: 'Special district' },
    JNT: { color: '#3fa7d6', label: 'Joint' },
    TRIB: { color: '#d97f6a', label: 'Tribal' },
    NGO: { color: '#8fb07a', label: 'Conservation group' },
    PVT: { color: '#9aa59a', label: 'Private' },
    UNK: { color: '#b8c2b0', label: 'Public' }
  };
  var MANAGER = {
    USACE: 'U.S. Army Corps of Engineers', FWS: 'U.S. Fish and Wildlife Service', USFS: 'U.S. Forest Service',
    NPS: 'National Park Service', BLM: 'Bureau of Land Management', BOR: 'Bureau of Reclamation',
    DOD: 'Department of Defense', TVA: 'Tennessee Valley Authority', NRCS: 'Natural Resources Conservation Service',
    SFW: 'State fish and wildlife agency', SDNR: 'State natural resources agency', SPR: 'State parks',
    SDC: 'State conservation agency', SLB: 'State land board', SDOL: 'State land office', OTHS: 'Other state agency',
    CITY: 'City', CNTY: 'County', RPD: 'Regional parks district', OTHR: 'Other', NGO: 'Conservation group',
    PVT: 'Private', UNK: 'Unknown', JNT: 'Joint management'
  };
  var ACCESS = {
    OA: { text: 'Open access', cls: 'open' },
    RA: { text: 'Restricted access (permit, season or area rules)', cls: 'restricted' },
    XA: { text: 'Closed to the public', cls: 'closed' },
    UK: { text: 'Access unknown', cls: 'unknown' }
  };

  // Many state areas (Missouri conservation areas, for one) are listed with an unknown manager.
  // Their names give them away, so color them as state land.
  var STATE_NAME = /\b(conservation area|wildlife (management )?area|state park|state forest|state natural area|state recreation area|\bWMA\b)/i;
  function typeOf(p) {
    if (p.Mang_Type && p.Mang_Type !== 'UNK') return p.Mang_Type;
    if (STATE_NAME.test(p.Unit_Nm || '')) return 'STAT';
    return 'UNK';
  }

  function attach(m, opts) {
    map = m; opts = opts || {};
    onTap = opts.onTap || null; onStatus = opts.onStatus || null;
    pane = null;   // boundaries live in the standard overlay layer (smooth zoom animation, turns with the map)
    group = L.layerGroup().addTo(map);
    map.on('moveend', schedule);
  }
  function status(s) { if (onStatus) onStatus(s); }

  function schedule() { clearTimeout(timer); timer = setTimeout(load, 400); }

  function load() {
    if (!enabled || !map) return;
    if (map.getZoom() < MIN_ZOOM) { status('zoom'); return; }
    var b = map.getBounds(), todo = [];
    for (var la = Math.floor(b.getSouth() / CELL); la <= Math.floor(b.getNorth() / CELL); la++) {
      for (var ln = Math.floor(b.getWest() / CELL); ln <= Math.floor(b.getEast() / CELL); ln++) {
        var k = la + ',' + ln;
        if (!cells[k] || cells[k] === 'error') todo.push([la, ln, k]);
      }
    }
    if (todo.length > 12) todo = todo.slice(0, 12);
    if (!todo.length) { status('ok'); return; }
    status('loading');
    Promise.all(todo.map(function (c) { return fetchCell(c[0], c[1], c[2], 0); })).then(function (r) {
      draw();
      status(r.some(function (x) { return x === 'error'; }) ? 'error' : 'ok');
    });
  }

  function fetchCell(la, ln, key, offset) {
    cells[key] = 'loading';
    var s = la * CELL, w = ln * CELL;
    var q = 'where=1%3D1&geometry=' + [w, s, w + CELL, s + CELL].map(function (v) { return v.toFixed(4); }).join('%2C') +
      '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=' + FIELDS +
      '&returnGeometry=true&outSR=4326&geometryPrecision=6&maxAllowableOffset=0.00003&resultRecordCount=1000' +
      '&resultOffset=' + offset + '&f=geojson';
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(URL + '?' + q, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !Array.isArray(j.features)) throw new Error('bad data');
      j.features.forEach(add);
      var more = j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit);
      if (more && offset < 4000) return fetchCell(la, ln, key, offset + j.features.length);
      cells[key] = 'done';
      return 'done';
    }).catch(function () { clearTimeout(t); cells[key] = 'error'; return 'error'; });
  }

  function add(f) {
    var p = f.properties || {}, id = p.OBJECTID != null ? p.OBJECTID : f.id;
    if (id == null || feats[id] || !f.geometry) return;
    var g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length) return;
    // GeoJSON is [lng, lat]; Leaflet wants [lat, lng]
    var rings = polys.map(function (poly) { return poly.map(function (ring) { return ring.map(function (c) { return [c[1], c[0]]; }); }); });
    feats[id] = { props: p, rings: rings };
  }

  function draw() {
    if (!enabled) return;
    Object.keys(feats).forEach(function (id) {
      if (drawn[id]) return;
      var f = feats[id], p = f.props, t = TYPE[typeOf(p)] || TYPE.UNK;
      var closed = p.Pub_Access === 'XA', restricted = p.Pub_Access === 'RA';
      // Boundary lines only (a dark edge under a colored line), no shading, so the photo shows through.
      // The inside stays tappable through an invisible fill. Drawn in Leaflet's standard overlay layer,
      // which moves in step with the map while zooming.
      L.polygon(f.rings, { color: '#0b0f0c', weight: 5, opacity: 0.45, fill: false, interactive: false, lineJoin: 'round' }).addTo(group);
      var shape = L.polygon(f.rings, {
        color: closed ? '#d94b3d' : t.color, weight: 2.4, opacity: 1, lineJoin: 'round',
        dashArray: restricted ? '8 6' : closed ? '2 6' : null,
        fill: true, fillColor: t.color, fillOpacity: 0, interactive: true
      });
      if (shape.on) shape.on('click', function (e) {
        if (e && e.originalEvent && L.DomEvent && L.DomEvent.stopPropagation) L.DomEvent.stopPropagation(e);
        if (onTap) onTap(describe(p), e && e.latlng);
      });
      shape.addTo(group);
      drawn[id] = true;
    });
  }

  function describe(p) {
    var ty = typeOf(p), t = TYPE[ty] || TYPE.UNK, a = ACCESS[p.Pub_Access] || ACCESS.UK;
    var loc = p.Loc_Mang && !/^unknown$/i.test(p.Loc_Mang) ? p.Loc_Mang : '';
    var known = p.Mang_Name && p.Mang_Name !== 'UNK' ? MANAGER[p.Mang_Name] : null, mgr;
    if (p.Mang_Type === 'FED' && known) mgr = known + (loc ? ' (' + loc + ' office)' : '');
    else mgr = loc || known || (ty === 'STAT' ? 'State agency (not listed)' : 'Not listed');
    return {
      name: p.Unit_Nm || 'Unnamed public land', owner: t.label, manager: mgr, access: a.text, accessCls: a.cls,
      acres: p.GIS_Acres ? Math.round(p.GIS_Acres).toLocaleString() : null, kind: p.Des_Tp || ''
    };
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!group) return;
    if (!enabled) { group.clearLayers(); drawn = {}; status('off'); }
    else { draw(); load(); }
  }

  SC.publand = {
    attach: attach, setEnabled: setEnabled, refresh: load, TYPE: TYPE, describe: describe,
    _stats: function () { return { features: Object.keys(feats).length, drawn: Object.keys(drawn).length, cells: Object.assign({}, cells) }; }
  };
})();
