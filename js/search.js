/* Place search: find a town, lake, creek, landform or piece of public land by name, anywhere in the U.S.
 *  - Names of towns and natural features: USGS Geographic Names (GNIS), The National Map.
 *  - Public land (conservation areas, state and national forests, parks): PAD-US.
 *  - Typed coordinates such as "37.8096, -93.6250" go straight there.
 * Free services, no key. Results near where the map is looking come first; "Stockton WI" limits it to a state. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var GNIS = 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer';
  var PADUS = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query';
  var LAYERS = [3, 5, 6, 7];   // populated places, landforms, streams, lakes and other water
  var STATES = { ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY' };
  var ABBR = {};
  Object.keys(STATES).forEach(function (k) { ABBR[STATES[k]] = k; });

  // "stockton, wi" -> { term: 'STOCKTON', state: 'WI' }; "37.81, -93.62" -> { coords: {...} }
  function parse(text) {
    var t = String(text || '').trim();
    var c = /^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(t);
    if (c && Math.abs(+c[1]) <= 90 && Math.abs(+c[2]) <= 180 && /\./.test(t)) return { coords: { lat: +c[1], lng: +c[2] } };
    var up = t.toUpperCase().replace(/\s+/g, ' '), state = null;
    var m = /^(.*?)[,\s]+([A-Z]{2})$/.exec(up);
    if (m && ABBR[m[2]] && m[1].trim().length >= 2) { state = m[2]; up = m[1].trim(); }
    else {
      for (var name in STATES) {
        if (up.length > name.length + 2 && up.slice(-name.length) === name && /[,\s]/.test(up.charAt(up.length - name.length - 1))) {
          state = STATES[name]; up = up.slice(0, -name.length).replace(/[,\s]+$/, ''); break;
        }
      }
    }
    return { term: up.replace(/[%_]/g, ''), state: state };
  }
  function getJson(url) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(url, { signal: ctl ? ctl.signal : undefined }).then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      function (e) { clearTimeout(timer); throw e; });
  }
  function sql(s) { return s.replace(/'/g, "''"); }
  function boxParam(box) {
    return box ? '&geometry=' + [box.w, box.s, box.e, box.n].map(function (v) { return v.toFixed(3); }).join('%2C') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects' : '';
  }
  function names(layer, q, box) {
    var where = "UPPER(gaz_name) LIKE '%" + sql(q.term) + "%'" + (q.state ? " AND state_alpha = '" + q.state + "'" : '');
    var url = GNIS + '/' + layer + '/query?where=' + encodeURIComponent(where) + boxParam(box) +
      '&outFields=gaz_name,gaz_featureclass,state_alpha,county_name&outSR=4326&resultRecordCount=40&f=json';
    return getJson(url).then(function (j) {
      return (j.features || []).map(function (f) {
        var a = f.attributes, g = f.geometry || {}, p = g.points ? g.points[0] : (g.x != null ? [g.x, g.y] : null);
        if (!p) return null;
        var kind = a.gaz_featureclass === 'Populated Place' ? 'Town' : a.gaz_featureclass;
        return { name: a.gaz_name, kind: kind, town: kind === 'Town', where: (a.county_name ? a.county_name + ' County, ' : '') + (a.state_alpha || ''), lat: p[1], lng: p[0] };
      }).filter(Boolean);
    });
  }
  function publicLand(q, box) {
    var where = "UPPER(Unit_Nm) LIKE '%" + sql(q.term) + "%'" + (q.state ? " AND State_Nm = '" + q.state + "'" : '');
    var url = PADUS + '?where=' + encodeURIComponent(where) + boxParam(box) +
      '&outFields=Unit_Nm,State_Nm,GIS_Acres&returnGeometry=true&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.001&resultRecordCount=40&f=json';
    return getJson(url).then(function (j) {
      var by = {};
      (j.features || []).forEach(function (f) {
        var a = f.attributes, key = a.Unit_Nm + '|' + a.State_Nm, r = by[key] || (by[key] = { name: a.Unit_Nm, kind: 'Public land', where: a.State_Nm || '', acres: 0, box: { s: 90, n: -90, w: 180, e: -180 } });
        r.acres += a.GIS_Acres || 0;
        ((f.geometry && f.geometry.rings) || []).forEach(function (ring) {
          ring.forEach(function (p) { if (p[0] < r.box.w) r.box.w = p[0]; if (p[0] > r.box.e) r.box.e = p[0]; if (p[1] < r.box.s) r.box.s = p[1]; if (p[1] > r.box.n) r.box.n = p[1]; });
        });
      });
      return Object.keys(by).map(function (k) {
        var r = by[k];
        if (r.box.s > r.box.n) return null;
        r.lat = (r.box.s + r.box.n) / 2; r.lng = (r.box.w + r.box.e) / 2;
        if (r.acres) r.where += (r.where ? ', ' : '') + Math.round(r.acres).toLocaleString() + ' acres';
        return r;
      }).filter(Boolean);
    });
  }
  function everything(q, box) {
    var jobs = LAYERS.map(function (l) { return names(l, q, box); }).concat([publicLand(q, box)]);
    var failed = 0;
    return Promise.all(jobs.map(function (p) { return p.catch(function () { failed++; return []; }); })).then(function (lists) {
      if (failed === jobs.length) throw new Error('Search could not reach the map service. Check your signal.');
      return [].concat.apply([], lists);
    });
  }
  // center: { lat, lng } the map is looking at. Resolves to up to 25 results, best match and nearest first.
  function lookup(text, center) {
    var q = parse(text);
    if (q.coords) return Promise.resolve([{ name: q.coords.lat.toFixed(5) + ', ' + q.coords.lng.toFixed(5), kind: 'Coordinates', where: '', lat: q.coords.lat, lng: q.coords.lng }]);
    if (!q.term || q.term.length < 3) return Promise.resolve([]);
    var near = q.state || !center ? null : { s: center.lat - 2.5, n: center.lat + 2.5, w: center.lng - 3.2, e: center.lng + 3.2 };
    return everything(q, near).then(function (list) {
      return list.length || !near ? list : everything(q, null);          // nothing within a few hours' drive: look everywhere
    }).then(function (list) {
      var E = SC.engine;
      list.forEach(function (r) {
        var n = r.name.toUpperCase();
        r.rank = n === q.term ? 0 : n.indexOf(q.term) === 0 ? 1 : 2;
        r.distM = center ? E.distanceM(center.lat, center.lng, r.lat, r.lng) : 0;
      });
      // nearer is better, a closer name match is worth about 25 miles, and a town a little more
      list.forEach(function (r) { r.score = r.distM / 1609.34 + r.rank * 25 - (r.town ? 15 : 0); });
      list.sort(function (a, b) { return a.score - b.score; });
      return list.slice(0, 25);
    });
  }

  SC.search = { lookup: lookup, parse: parse };
})();
