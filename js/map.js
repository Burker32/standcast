/* Leaflet map: basemaps, stand pins, wind arrows, thermal arrows, scent cones, marks. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var E = SC.engine;

  var TILE_BASE = 'https://basemap.nationalmap.gov/arcgis/rest/services/';
  var BASES = {
    imagery: { label: 'Satellite', url: TILE_BASE + 'USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', attr: 'Imagery: <a href="https://www.usgs.gov/">U.S. Geological Survey</a>' },
    topo: { label: 'Topo', url: TILE_BASE + 'USGSTopo/MapServer/tile/{z}/{y}/{x}', attr: 'Map: <a href="https://www.usgs.gov/">U.S. Geological Survey</a>' },
    // Leaf-off photos: bare trees, so you see the ground. Missouri statewide 6-inch (north 2023, south 2024) from MSDIS,
    // and Wisconsin's latest statewide leaf-off set from the DNR (see LEAF below for which is used where).
    leafoff: { label: 'Leaf-off', url: 'https://stateimagery.msdis.missouri.edu/arcgis/rest/services/Missouri_6inch_Statewide_2023_2024_Cached/ImageServer/exportImage',
      fn: true, maxNative: 19, attr: 'Leaf-off imagery: <a href="https://msdis.missouri.edu/">MSDIS</a> (Missouri), <a href="https://dnr.wisconsin.gov/">Wisconsin DNR</a> and WROC (Wisconsin)' },
    hybrid: { label: 'Hybrid', url: TILE_BASE + 'USGSImageryTopo/MapServer/tile/{z}/{y}/{x}', attr: 'Imagery and topo: <a href="https://www.usgs.gov/">U.S. Geological Survey</a>' }
  };
  var MAX_NATIVE = 16;

  var map, baseLayer, baseKey, opts = {};
  var g = {}; // layer groups
  var userDot = null, fieldRenderer;

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function init(containerId, o) {
    opts = o || {};
    var v = opts.view || SC.store.DEFAULT_VIEW;
    var canRotate = !!(L.Map && L.Map.prototype.setBearing);
    map = L.map(containerId, {
      zoomControl: false, zoomSnap: 0.5, maxZoom: 19, minZoom: 5, tapTolerance: 12,
      // rotation (leaflet-rotate): twist with two fingers, or Shift + drag with a mouse
      rotate: canRotate, touchRotate: canRotate, shiftKeyRotate: canRotate, rotateControl: false, bearing: canRotate ? (v.bearing || 0) : 0
    }).setView([v.lat, v.lng], v.zoom);
    // While a zoom is animating, drawn layers (boundaries, cones, arrows) are hidden for that split second
    // and redrawn exactly in place when it ends, so nothing appears to slide around.
    var ct = map.getContainer();
    map.on('zoomstart', function () { ct.classList.add('is-zooming'); });
    map.on('zoomend', function () { setTimeout(function () { ct.classList.remove('is-zooming'); }, 30); });
    // dragging the map yourself ends follow mode
    map.on('dragstart', function () { if (follow) { follow = false; if (onFollowEnd) onFollowEnd(); } });
    if (canRotate) {
      var rotTimer = 0;
      map.on('rotate', function () {
        if (opts.onRotate) opts.onRotate(map.getBearing());
        paintHeading();
        clearTimeout(rotTimer);
        rotTimer = setTimeout(function () { if (opts.onRotateEnd) opts.onRotateEnd(map.getBearing()); }, 250);
      });
    }
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    map.attributionControl.setPrefix(false);
    function zoomClass() { map.getContainer().classList.toggle('zoom-low', map.getZoom() < 14.5); }
    map.on('zoomend', zoomClass); zoomClass();
    fieldRenderer = L.canvas ? L.canvas({ padding: 0.3 }) : undefined;
    g.field = L.layerGroup().addTo(map);
    ['cone', 'arrows', 'marks', 'stands', 'measure'].forEach(function (k) { g[k] = L.layerGroup().addTo(map); });
    setBasemap(opts.basemap || 'imagery');
    map.on('click', function (e) { if (opts.onTap) opts.onTap(e.latlng); });
    // press and hold on a phone (Leaflet turns the hold into this event), right-click on a computer
    map.on('contextmenu', function (e) { if (opts.onHold) opts.onHold(e.latlng); });
    map.on('moveend', function () { if (opts.onMoveEnd) opts.onMoveEnd(map.getCenter(), map.getZoom()); });
    return map;
  }

  // Image services (like the leaf-off photos) are asked for one Web Mercator square per map tile.
  var R = 20037508.342789244;
  // Leaf-off photos come from each state's own service. A tile is drawn from the state it falls in; anywhere
  // else gets the national summer photo, so the map is never blank. Boxes are rough state outlines.
  var LEAF = [
    { s: 35.9, n: 40.7, w: -95.9, e: -89.0, url: BASES.leafoff.url },                                    // Missouri: MSDIS 6-inch, 2023-24
    { s: 42.4, n: 47.4, w: -93.0, e: -86.2,                                                              // Wisconsin: DNR / WROC, 2018-24
      url: 'https://dnrmaps.wi.gov/arcgis_image/rest/services/DW_Imagery/EN_Image_Basemap_Latest_Leaf_Off_Raster_Tile/MapServer/export' }
  ];
  var LEAF_ELSE = TILE_BASE + 'USGSImageryOnly/MapServer/export';
  function leafUrl(xMid, yMid) {
    var lng = xMid / R * 180, lat = Math.atan(Math.sinh(yMid / R * Math.PI)) * 180 / Math.PI;
    for (var i = 0; i < LEAF.length; i++) if (lat >= LEAF[i].s && lat <= LEAF[i].n && lng >= LEAF[i].w && lng <= LEAF[i].e) return LEAF[i].url;
    return LEAF_ELSE;
  }
  function exportUrl(key, z, x, y) {
    var res = 2 * R / (256 * Math.pow(2, z));
    var x0 = -R + x * 256 * res, y1 = R - y * 256 * res, x1 = x0 + 256 * res, y0 = y1 - 256 * res;
    var sharp = (window.devicePixelRatio || 1) > 1.5, url = key === 'leafoff' ? leafUrl((x0 + x1) / 2, (y0 + y1) / 2) : BASES[key].url;
    // Picture size per tile. The Missouri service answers a 256 or 320 pixel square in about a tenth of a second
    // but takes a full second for 512 (measured), so phones get 320 there: far faster, barely softer.
    var px = !sharp ? 256 : url === BASES.leafoff.url ? 320 : 384;
    return url + '?bbox=' + [x0, y0, x1, y1].map(function (v) { return v.toFixed(2); }).join(',') +
      '&bboxSR=3857&imageSR=3857&size=' + px + ',' + px + '&format=jpg&f=image';
  }
  function setBasemap(key) {
    if (!BASES[key]) key = 'imagery';
    if (baseLayer) map.removeLayer(baseLayer);
    baseKey = key;
    var b = BASES[key];
    baseLayer = L.tileLayer(b.fn ? b.url + '?{z}/{x}/{y}' : b.url, {
      maxNativeZoom: b.maxNative || MAX_NATIVE, maxZoom: 19, attribution: b.attr, crossOrigin: true, className: 'base-' + key,
      // Phones normally wait until a drag ends before asking for new tiles. Asking while you drag, and keeping
      // a wider ring of tiles around the screen, means less grey when you stop.
      updateWhenIdle: false, updateInterval: 120, keepBuffer: 3
    });
    if (b.fn) baseLayer.getTileUrl = function (c) { return exportUrl(key, c.z, c.x, c.y); };
    baseLayer.addTo(map);
    if (baseLayer.bringToBack) baseLayer.bringToBack();
  }

  /* ---------- overlays on top of the photo ----------
   * hillshade: USGS 3DEP lidar shaded relief, blended (multiply) into the photo so the ground's shape shows
   * crops:     USDA CropScape (Cropland Data Layer) 2025, what was grown in each field, 30 m cells */
  var OVER = {
    hillshade: { url: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage', fn: 'Hillshade Multidirectional',
      attr: 'Lidar terrain: <a href="https://www.usgs.gov/3d-elevation-program">USGS 3DEP</a>' },
    contours: { url: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage', fn: 'Preset 10ft Contour Interval',
      attr: 'Contours: <a href="https://www.usgs.gov/3d-elevation-program">USGS 3DEP</a> (10 ft, lidar)' },
    crops: { url: 'https://nassgeodata.gmu.edu/CropScapeService/wms_cdlall.cgi', layer: 'cdl_2025', year: 2025,
      attr: 'Crops: <a href="https://nassgeodata.gmu.edu/CropScape/">USDA NASS CropScape</a> 2025' }
  };
  var overLayers = {};
  var OV_TILE = 512;   // tile size of the hillshade and contour layers
  var CARTO = 'https://carto.nationalmap.gov/arcgis/rest/services/';
  function depUrl(name, z, x, y, px, fmt) {
    // These layers use 512 px tiles, so each tile covers twice the ground of a normal 256 px tile at the same zoom.
    var span = 2 * R / Math.pow(2, z) * (OV_TILE / 256);
    var x0 = -R + x * span, y1 = R - y * span, x1 = x0 + span, y0 = y1 - span;
    return OVER[name].url + '?bbox=' + [x0, y0, x1, y1].map(function (v) { return v.toFixed(2); }).join(',') +
      '&bboxSR=3857&imageSR=3857&size=' + px + ',' + px + '&format=' + fmt + '&renderingRule=' +
      encodeURIComponent(JSON.stringify({ rasterFunction: OVER[name].fn })) + '&f=image';
  }
  function setOverlay(name, on, opacity) {
    var lay = overLayers[name];
    if (!on) { if (lay) { map.removeLayer(lay); delete overLayers[name]; } return; }
    if (lay) { if (lay.setOpacity) lay.setOpacity(opacity); return; }
    if (name === 'hillshade') {
      // big 512 px tiles: the lidar service draws each one on demand, so fewer requests load faster
      lay = L.tileLayer(OVER.hillshade.url + '?{z}/{x}/{y}', { tileSize: OV_TILE, zoomOffset: -1, maxNativeZoom: 17, maxZoom: 19, opacity: opacity,
        crossOrigin: true, className: 'ov-hillshade', attribution: OVER.hillshade.attr, zIndex: 5 });
      lay.getTileUrl = function (c) { return depUrl('hillshade', c.z, c.x, c.y, 512, 'jpg'); };
    } else if (name === 'contours') {
      // 10 ft lines from lidar, transparent between the lines, lightened in CSS to read on dark photos
      lay = L.tileLayer(OVER.contours.url + '?{z}/{x}/{y}', { tileSize: OV_TILE, zoomOffset: -1, minZoom: 13, maxNativeZoom: 17, maxZoom: 19, opacity: opacity,
        crossOrigin: true, className: 'ov-contours', attribution: OVER.contours.attr, zIndex: 6 });
      lay.getTileUrl = function (c) { return depUrl('contours', c.z, c.x, c.y, 512, 'png'); };
    } else if (name === 'labels') {
      // roads and place names drawn by USGS over whatever photo is showing (the Summer and Leaf-off photos have none)
      var px = (window.devicePixelRatio || 1) > 1.5 ? 1024 : 512;
      var part = function (svc, zi) {
        var tl = L.tileLayer(CARTO + svc + '?{z}/{x}/{y}', { tileSize: OV_TILE, zoomOffset: -1, minZoom: 12, maxZoom: 19, opacity: opacity, crossOrigin: true,   // drawn on demand and slow, so only when zoomed in
          className: 'ov-labels', attribution: 'Roads and names: <a href="https://www.usgs.gov/">U.S. Geological Survey</a>', zIndex: zi });
        tl.getTileUrl = function (c) {
          var span = 2 * R / Math.pow(2, c.z) * (OV_TILE / 256), x0 = -R + c.x * span, y1 = R - c.y * span;
          return CARTO + svc + '/MapServer/export?bbox=' + [x0, y1 - span, x0 + span, y1].map(function (v) { return v.toFixed(2); }).join(',') +
            '&bboxSR=3857&imageSR=3857&size=' + px + ',' + px + '&dpi=' + Math.round(96 * px / OV_TILE) + '&format=png32&transparent=true&f=image';
        };
        return tl;
      };
      lay = L.layerGroup([part('transportation', 7)]);   // town and public land names are written by labels.js
      lay.setOpacity = function (o) { lay.eachLayer(function (l) { l.setOpacity(o); }); };
    } else if (name === 'crops') {
      if (!L.tileLayer.wms || !L.CRS) return;
      if (!map.getPane('cropPane')) { var cp = map.createPane('cropPane', map._rotatePane || undefined); cp.style.zIndex = 300; cp.style.pointerEvents = 'none'; }
      lay = L.tileLayer.wms(OVER.crops.url, { layers: OVER.crops.layer, format: 'image/png', transparent: true, version: '1.1.1',
        crs: L.CRS.EPSG4326, opacity: opacity, pane: 'cropPane', className: 'ov-crops', attribution: OVER.crops.attr, maxZoom: 19 });
    }
    if (lay) { lay.addTo(map); overLayers[name] = lay; }
  }

  function arrowLayers(lat, lng, toDeg, lengthM, color, dashed, tip) {
    var a = E.arrowShape(lat, lng, toDeg, lengthM);
    var halo = L.polyline(a.shaft, { color: '#000', opacity: 0.45, weight: 6, lineCap: 'round', interactive: false });
    var shaft = L.polyline(a.shaft, { color: color, opacity: 1, weight: 3, lineCap: 'round', dashArray: dashed ? '6 6' : null, interactive: false });
    var head = L.polygon(a.head, { color: color, fillColor: color, fillOpacity: 1, weight: 1.5, interactive: false });
    var out = [halo, shaft, head];
    if (tip) shaft.bindTooltip(tip, { sticky: true });
    return out;
  }

  /* model.stands: [{ stand, state, cls, rank, windText, selected }]
   * model.marks:  [{ mark, selected }]
   * model.layers: { wind, thermal, cone, marks } */
  function render(model) {
    Object.keys(g).forEach(function (k) { if (k !== 'field' && k !== 'measure') g[k].clearLayers(); });
    var colors = { good: cssVar('--good'), ok: cssVar('--ok'), bad: cssVar('--bad'), wind: cssVar('--wind'), rise: cssVar('--map-rise'), sink: cssVar('--map-sink') };
    var L_ = model.layers;

    if (L_.marks) {
      model.marks.forEach(function (it) {
        var m = it.mark, t = SC.markTypes.TYPES[m.type] || SC.markTypes.TYPES.other;
        var node = el('div', 'mk' + (it.selected ? ' is-sel' : ''));
        node.style.background = t.color;
        node.appendChild(SC.markTypes.icon(m.type, 15));
        if (m.photoId) node.appendChild(el('span', 'mk-photo'));
        if (m.name) node.appendChild(el('div', 'mk-label', m.name));
        var mk = L.marker([m.lat, m.lng], {
          icon: L.divIcon({ className: 'mk-wrap', html: node, iconSize: [30, 30], iconAnchor: [15, 15] }),
          draggable: !!it.selected, zIndexOffset: it.selected ? 900 : 100, keyboard: false,
          title: (m.name || t.label) + (m.note ? ': ' + m.note.slice(0, 40) : '')
        });
        mk.on('click', function (e) { L.DomEvent.stopPropagation(e); if (opts.onSelectMark) opts.onSelectMark(m.id); });
        mk.on('dragend', function () { var p = mk.getLatLng(); if (opts.onMoveMark) opts.onMoveMark(m.id, p.lat, p.lng); });
        mk.addTo(g.marks);
      });
    }

    model.stands.forEach(function (it) {
      var s = it.stand, st = it.state;
      if (st) {
        var col = colors[it.cls] || colors.ok;
        if (L_.cone) {
          var ring = E.coneRing(s.lat, s.lng, E.norm(st.eff.from + 180), st.eff.speed);
          L.polygon(ring, { color: col, weight: 1.5, opacity: 0.9, fillColor: col, fillOpacity: 0.25, interactive: false }).addTo(g.cone);
        }
        if (L_.wind) {
          var wl = Math.max(35, Math.min(220, 35 + st.syn.speed * 14));
          arrowLayers(s.lat, s.lng, E.norm(st.syn.from + 180), wl, colors.wind, false,
            'Wind (modeled) from the ' + E.compass(st.syn.from) + ' at ' + Math.round(st.syn.speed) + ' mph').forEach(function (l) { l.addTo(g.arrows); });
        }
        if (L_.thermal && st.thermal.strength >= 0.06) {
          var tc = st.thermal.index < 0 ? colors.sink : colors.rise;
          var tip = 'Thermals ' + E.thermalWords(st.thermal.phase) + ' (estimated)';
          if (st.thermal.toward != null) {
            var tl = 45 + st.thermal.strength * 170;
            arrowLayers(s.lat, s.lng, st.thermal.toward, tl, tc, true, tip).forEach(function (l) { l.addTo(g.arrows); });
          } else {
            // flat ground: a ring that shows air lifting (day) or settling in place (evening)
            L.circle([s.lat, s.lng], { radius: 30 + st.thermal.strength * 60, color: tc, weight: 3, dashArray: '5 5', fill: false, interactive: false }).addTo(g.arrows);
          }
        }
      }
      if (st && L_.swirl && !model.animating && st.swirl && st.swirl.score >= 0.45) {
        swirlLayers(s.lat, s.lng, 28 + 14 * st.swirl.score, cssVar('--map-swirl'), 1).forEach(function (l) { l.addTo(g.arrows); });
      }
      var node = el('div', 'st st-' + (it.cls || 'none') + (it.selected ? ' is-sel' : '') + (it.rank === 1 ? ' is-best' : ''));
      node.appendChild(el('div', 'st-pin', it.rank ? String(it.rank) : '•'));
      var lab = el('div', 'st-label');
      lab.appendChild(el('b', null, s.name));
      if (it.windText) lab.appendChild(el('i', null, it.windText));
      node.appendChild(lab);
      var mk = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'st-wrap', html: node, iconSize: [34, 34], iconAnchor: [17, 17] }),
        draggable: !!it.selected, zIndexOffset: it.selected ? 1000 : (it.rank === 1 ? 500 : 300), keyboard: false, title: s.name
      });
      mk.on('click', function (e) { L.DomEvent.stopPropagation(e); if (opts.onSelectStand) opts.onSelectStand(s.id); });
      mk.on('dragend', function () { var p = mk.getLatLng(); if (opts.onMoveStand) opts.onMoveStand(s.id, p.lat, p.lng); });
      mk.addTo(g.stands);
    });
  }

  // A swirl mark: a broken loop with an arrowhead, sized in meters.
  function swirlLayers(lat, lng, rM, color, op, renderer) {
    var pts = [];
    for (var k = 0; k <= 14; k++) pts.push(E.offsetLatLng(lat, lng, 20 + k * 22, rM * (0.78 + 0.22 * k / 14)));
    var end = pts[pts.length - 1], dir = 20 + 14 * 22 + 90;
    var hl = rM * 0.45;
    var head = [E.offsetLatLng(end[0], end[1], dir + 180 - 35, hl), end, E.offsetLatLng(end[0], end[1], dir + 180 + 35, hl)];
    var o = { interactive: false, lineCap: 'round', lineJoin: 'round' };
    if (renderer) o.renderer = renderer;
    return [
      L.polyline(pts, Object.assign({ color: '#000', opacity: 0.4 * op, weight: 6 }, o)),
      L.polyline(head, Object.assign({ color: '#000', opacity: 0.4 * op, weight: 6 }, o)),
      L.polyline(pts, Object.assign({ color: color, opacity: op, weight: 3 }, o)),
      L.polyline(head, Object.assign({ color: color, opacity: op, weight: 3 }, o))
    ];
  }

  /* Thermal flow across the map. cells: [{lat,lng,toward,strength,sink,pool,lenM}], swirls: [{lat,lng,score,rM}] */
  function renderField(cells, swirls) {
    g.field.clearLayers();
    var sc = cssVar('--map-swirl');
    (swirls || []).forEach(function (w) {
      swirlLayers(w.lat, w.lng, w.rM, sc, 0.55 + 0.45 * Math.min(1, w.score), fieldRenderer).forEach(function (l) { l.addTo(g.field); });
    });
    if (!cells || !cells.length) return;
    var rise = cssVar('--map-rise'), sink = cssVar('--map-sink');
    cells.forEach(function (c) {
      var col = c.sink ? sink : rise, op = 0.45 + 0.55 * Math.min(1, c.strength * 1.6);
      if (c.pool) {
        L.circle([c.lat, c.lng], { radius: c.lenM * 0.22, color: col, weight: 1.5, opacity: op, fillColor: col, fillOpacity: 0.28 * op, interactive: false, renderer: fieldRenderer }).addTo(g.field);
        return;
      }
      var half = c.lenM / 2;
      var a = E.offsetLatLng(c.lat, c.lng, c.toward + 180, half), b = E.offsetLatLng(c.lat, c.lng, c.toward, half);
      var hl = Math.max(14, c.lenM * 0.32);
      var l = E.offsetLatLng(b[0], b[1], c.toward + 180 - 30, hl), r = E.offsetLatLng(b[0], b[1], c.toward + 180 + 30, hl);
      var line = [a, b, l, b, r];
      L.polyline(line, { color: '#000', opacity: 0.35 * op, weight: 4.5, lineCap: 'round', lineJoin: 'round', interactive: false, renderer: fieldRenderer }).addTo(g.field);
      L.polyline(line, { color: col, opacity: op, weight: 2.2, lineCap: 'round', lineJoin: 'round', interactive: false, renderer: fieldRenderer }).addTo(g.field);
    });
  }
  /* ---------- benches ----------
   * res: { mask, rows, cols } from engine.findBenches, bounds {n,s,w,e} of that grid. Painted once into a small
   * picture (one dot per ground cell) and stretched over the map, so it pans, zooms and turns with it. */
  var benchLayer = null;
  function renderBenches(res, bounds, opacity) {
    if (benchLayer) { map.removeLayer(benchLayer); benchLayer = null; }
    if (!res || !res.benches.length) return;
    var cv = document.createElement('canvas'), R = res.rows, C = res.cols, m = res.mask;
    cv.width = C; cv.height = R;
    var ctx = cv.getContext('2d'), img = ctx.createImageData(C, R), d = img.data;
    var hex = cssVar('--map-bench').replace('#', ''), n = parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex, 16);
    var cr = n >> 16 & 255, cg = n >> 8 & 255, cb = n & 255;
    for (var i = 0; i < R; i++) for (var j = 0; j < C; j++) {
      var k = i * C + j; if (!m[k]) continue;
      // cells on the rim are drawn dark, so each bench gets an outline that shows on any photo
      var edge = i === 0 || j === 0 || i === R - 1 || j === C - 1 || !m[k - 1] || !m[k + 1] || !m[k - C] || !m[k + C];
      var o = k * 4;
      if (edge) { d[o] = 24; d[o + 1] = 40; d[o + 2] = 10; d[o + 3] = 235; }
      else { d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = 150; }
    }
    ctx.putImageData(img, 0, 0);
    benchLayer = L.imageOverlay(cv.toDataURL('image/png'), [[bounds.s, bounds.w], [bounds.n, bounds.e]], { opacity: opacity, interactive: false, className: 'ov-bench' }).addTo(map);
  }
  function setBenchOpacity(o) { if (benchLayer) benchLayer.setOpacity(o); }

  /* ---------- saddles and funnels ----------
   * spots: [{ kind: 'saddle' | 'funnel', lat, lng, ... }]. Small symbols, not shading, so the map stays readable;
   * a tap hands the spot back to the app, which explains it. */
  var spotLayer = null;
  var SPOT_GLYPH = {
    saddle: 'M3 8 Q12 17 21 8 M3 19 Q12 13 21 19',          // a dip between two rises
    funnel: 'M4 5 L10 12 L4 19 M20 5 L14 12 L20 19'          // two sides squeezing in
  };
  function renderSpots(spots, onTap) {
    if (spotLayer) { map.removeLayer(spotLayer); spotLayer = null; }
    if (!spots || !spots.length) return;
    spotLayer = L.layerGroup();
    spots.forEach(function (s) {
      var node = el('div', 'sp sp-' + s.kind);
      node.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="' + SPOT_GLYPH[s.kind] + '" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var mk = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'sp-wrap', html: node, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false, zIndexOffset: 50, title: s.kind === 'saddle' ? 'Saddle (estimated)' : 'Funnel (estimated)'
      });
      mk.on('click', function (e) { L.DomEvent.stopPropagation(e); if (onTap) onTap(s); });
      mk.addTo(spotLayer);
    });
    spotLayer.addTo(map);
  }

  /* ---------- measuring ----------
   * pts: [{lat,lng}], legs: ['143 yd', ...], total: '312 yd'. Points are draggable; labels stay upright. */
  function renderMeasure(m, cb) {
    g.measure.clearLayers();
    if (!m || !m.pts.length) return;
    var line = m.pts.map(function (p) { return [p.lat, p.lng]; });
    if (line.length > 1) {
      L.polyline(line, { color: '#000', opacity: 0.5, weight: 7, interactive: false }).addTo(g.measure);
      L.polyline(line, { color: '#ffd23f', opacity: 1, weight: 3.5, dashArray: '10 7', interactive: false }).addTo(g.measure);
    }
    m.pts.forEach(function (p, i) {
      var node = el('div', 'ms-pt' + (i === 0 ? ' first' : '') + (i === m.pts.length - 1 ? ' last' : ''));
      var mk = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'ms-wrap', html: node, iconSize: [22, 22], iconAnchor: [11, 11] }),
        draggable: true, zIndexOffset: 1500, keyboard: false
      });
      mk.on('click', function (e) { L.DomEvent.stopPropagation(e); });
      mk.on('drag', function () { var q = mk.getLatLng(); if (cb && cb.onDrag) cb.onDrag(i, q.lat, q.lng, true); });
      mk.on('dragend', function () { var q = mk.getLatLng(); if (cb && cb.onDrag) cb.onDrag(i, q.lat, q.lng, false); });
      mk.addTo(g.measure);
    });
    for (var i = 1; i < m.pts.length; i++) {
      var a = m.pts[i - 1], b = m.pts[i];
      var lab = el('div', 'ms-leg', m.legs[i - 1]);
      L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
        icon: L.divIcon({ className: 'ms-wrap', html: lab, iconSize: [0, 0], iconAnchor: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: 1400
      }).addTo(g.measure);
    }
  }
  function bearing() { return map.getBearing ? map.getBearing() : 0; }
  function setBearing(b) { if (map.setBearing) map.setBearing(b); }
  function bounds() { var b = map.getBounds(); return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() }; }

  // padBottom (px) keeps the point clear of a bottom sheet by aiming the view a little below it.
  function flyTo(lat, lng, zoom, padBottom) {
    var z = zoom || Math.max(map.getZoom(), 16);
    var target = map.unproject(map.project([lat, lng], z).add([0, (padBottom || 0) / 2]), z);
    map.flyTo(target, z, { duration: 0.6 });
  }
  function fitPoints(points) {
    if (!points.length) return;
    if (points.length === 1) return map.setView(points[0], 16);
    map.fitBounds(L.latLngBounds(points).pad(0.35), { maxZoom: 16, animate: true });
  }
  function center() { var c = map.getCenter(); return { lat: c.lat, lng: c.lng }; }
  function setPlacing(on) { map.getContainer().classList.toggle('placing', !!on); }
  // A red dot with a name for a place found by search. It stays until the next search or until it is tapped.
  var foundPin = null;
  function setFound(p) {
    if (foundPin) { map.removeLayer(foundPin); foundPin = null; }
    if (!p) return;
    var node = el('div', 'found');
    node.appendChild(el('span', null, p.name));
    foundPin = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'found-wrap', html: node, iconSize: [22, 22], iconAnchor: [11, 11] }), keyboard: false, zIndexOffset: 1700 }).addTo(map);
    foundPin.on('click', function (e) { L.DomEvent.stopPropagation(e); setFound(null); });
  }
  function fitBox(b, padBottom) {
    map.fitBounds([[b.s, b.w], [b.n, b.e]], { paddingTopLeft: [20, 70], paddingBottomRight: [20, (padBottom || 0) + 20], maxZoom: 16, animate: true });
  }
  // A temporary pin for the spot you pressed and held, shown while you choose what goes there.
  var pendingPin = null;
  function setPending(p) {
    if (pendingPin) { map.removeLayer(pendingPin); pendingPin = null; }
    if (!p) return;
    pendingPin = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: 'pend-wrap', html: '<div class="pend"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }),
      interactive: false, keyboard: false, zIndexOffset: 1800
    }).addTo(map);
  }
  function invalidate() { if (map) map.invalidateSize(); }
  function panByPixels(dx, dy) { map.panBy([dx, dy], { animate: true }); }

  /* ---------- your location: a live dot that follows you ---------- */
  var watchId = null, lastFix = null, fixWaiters = [];
  // Your position: an upright marker (stays exactly on your spot at any map rotation), an accuracy
  // ring that turns with the map, and a soft wedge showing which way the phone faces when known.
  var follow = false, onFollowEnd = null, headingDeg = null;
  function meNode() {
    var n = el('div', 'me');
    n.appendChild(el('div', 'me-cone'));
    n.appendChild(el('div', 'me-dot'));
    return n;
  }
  function drawDot(lat, lng, acc) {
    var ll = [lat, lng], r = Math.min(acc || 30, 200);
    if (!userDot) {
      userDot = {
        ring: L.circle(ll, { radius: r, color: '#4a90e2', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map),
        node: meNode()
      };
      userDot.dot = L.marker(ll, { icon: L.divIcon({ className: 'me-wrap', html: userDot.node, iconSize: [60, 60], iconAnchor: [30, 30] }), interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map);
    } else { userDot.ring.setLatLng(ll).setRadius(r); userDot.dot.setLatLng(ll); }
    paintHeading();
    if (follow) keepCentered(lat, lng);
  }
  function paintHeading() {
    if (!userDot || !userDot.node) return;
    var cone = userDot.node.firstChild;
    if (headingDeg == null) { cone.style.display = 'none'; return; }
    cone.style.display = '';
    cone.style.transform = 'rotate(' + (headingDeg + bearing()) + 'deg)';   // screen angle = compass heading + map turn
  }
  function setHeading(deg) { headingDeg = deg; paintHeading(); }
  function keepCentered(lat, lng) {
    var c = map.latLngToContainerPoint(map.getCenter()), p = map.latLngToContainerPoint([lat, lng]);
    if (Math.hypot(p.x - c.x, p.y - c.y) < 6) return;          // close enough: skip tiny GPS jitter
    map.panTo([lat, lng], { animate: !document.hidden, duration: 0.5 });
  }
  // Follow mode keeps you at the center of the map, which is also the point the map turns around.
  function setFollow(on, onEnd) {
    follow = !!on; onFollowEnd = onEnd || onFollowEnd;
    if (follow && lastFix) map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom(), 16), { animate: false });
  }
  function geoError(err) {
    return new Error(err && err.code === 1 ? 'Location is blocked for this site. Allow it in your phone or browser settings.' : 'Could not get your location.');
  }
  // Starts following you. Safe to call more than once. onError fires only if no fix ever arrives.
  function watch(onError) {
    if (!navigator.geolocation) { if (onError) onError(new Error('This browser cannot share your location.')); return; }
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(function (pos) {
      lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() };
      drawDot(lastFix.lat, lastFix.lng, lastFix.accuracy);
      var w = fixWaiters; fixWaiters = []; w.forEach(function (f) { f.resolve(lastFix); });
    }, function (err) {
      if (err && err.code === 1) { unwatch(); }
      var w = fixWaiters; fixWaiters = []; w.forEach(function (f) { f.reject(geoError(err)); });
      if (!lastFix && onError) onError(geoError(err));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  }
  function unwatch() {
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  function watching() { return watchId != null; }
  // One position: a recent fix if we have one, otherwise waits for the next.
  function locate() {
    // While watching, the last fix is current: phones only send a new one when you move.
    if (lastFix && watchId != null && Date.now() - lastFix.at < 10 * 60000) return Promise.resolve(lastFix);
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('This browser cannot share your location.'));
      fixWaiters.push({ resolve: resolve, reject: reject });
      watch();
      setTimeout(function () {
        var i = fixWaiters.findIndex(function (f) { return f.resolve === resolve; });
        if (i >= 0) { fixWaiters.splice(i, 1); reject(new Error('Could not get your location. Try again in the open.')); }
      }, 25000);
    });
  }

  /* ---------- offline tiles ---------- */
  function lng2x(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }
  function tileList(bounds, minZ, maxZ) {
    var out = [];
    for (var z = minZ; z <= maxZ; z++) {
      var x0 = lng2x(bounds.getWest(), z), x1 = lng2x(bounds.getEast(), z);
      var y0 = lat2y(bounds.getNorth(), z), y1 = lat2y(bounds.getSouth(), z);
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) out.push({ z: z, x: x, y: y });
    }
    return out;
  }
  function tileUrl(key, t) { return BASES[key].fn ? exportUrl(key, t.z, t.x, t.y) : BASES[key].url.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y); }

  // Saves tiles for what is on screen (padded) at zoom 13-16 into the same cache the service worker reads.
  function cacheArea(progress) {
    if (!('caches' in window)) return Promise.reject(new Error('Offline maps are not supported in this browser.'));
    var bounds = map.getBounds().pad(0.2), maxZ = MAX_NATIVE, list;
    do { list = tileList(bounds, 13, maxZ); maxZ--; } while (list.length > 1400 && maxZ >= 13);
    if (list.length > 1400) return Promise.reject(new Error('That area is too large. Zoom in and try again.'));
    var key = baseKey, done = 0, saved = 0, failed = 0, idx = 0, aborted = false;
    return caches.open('sc-tiles-v1').then(function (cache) {
      function worker() {
        if (idx >= list.length || aborted) return Promise.resolve();
        var t = list[idx++], url = tileUrl(key, t);
        return cache.match(url).then(function (hit) {
          if (hit) return true;
          return fetch(url, { mode: 'cors' }).then(function (r) { if (!r.ok) throw new Error('bad'); return cache.put(url, r).then(function () { return true; }); });
        }).then(function () { saved++; }, function () { failed++; if (saved === 0 && failed >= 8) aborted = true; })
          .then(function () { done++; if (progress) progress(done, list.length); return worker(); });
      }
      return Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    }).then(function () {
      if (aborted) throw new Error('The map server did not allow saving tiles for offline use.');
      return { saved: saved, failed: failed, total: list.length };
    });
  }

  SC.map = {
    BASES: BASES, init: init, setBasemap: setBasemap, render: render, renderField: renderField, bounds: bounds, flyTo: flyTo, fitPoints: fitPoints,
    center: center, setPlacing: setPlacing, invalidate: invalidate, locate: locate, watch: watch, unwatch: unwatch, watching: watching, cacheArea: cacheArea,
    panByPixels: panByPixels, setPending: setPending, setFound: setFound, fitBox: fitBox, renderBenches: renderBenches, setBenchOpacity: setBenchOpacity, renderSpots: renderSpots, renderMeasure: renderMeasure, setOverlay: setOverlay, OVER: OVER, get leaflet() { return map; }, bearing: bearing, setBearing: setBearing, setFollow: setFollow, setHeading: setHeading, get following() { return follow; }, get lastFix() { return lastFix; }, get canRotate() { return !!map.setBearing; }, get basemap() { return baseKey; }, get zoom() { return map.getZoom(); }
  };
})();
