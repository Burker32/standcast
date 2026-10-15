/* Pins in and out: GPX and KML (and KMZ, which is a zipped KML) from onX, HuntStand, Garmin, Google Earth
 * and most other map apps, and a GPX file of your stands, marks and walks for them to read.
 * No DOM needed, so it runs in the tests too. Only points come in; lines (tracks, routes) are counted, not added. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SC = root.SC || {}; root.SC.pins = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- reading ---------- */

  function decode(s) {
    if (s == null) return '';
    s = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    // descriptions are often HTML: keep the words, lose the tags
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, '');
    s = s.replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    return s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }
  // first <tag>...</tag> inside a chunk of XML (any namespace prefix)
  function tag(xml, name) {
    var m = new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>', 'i').exec(xml);
    return m ? m[1] : null;
  }
  function attr(openTag, name) {
    var m = new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(openTag);
    return m ? m[1] : null;
  }
  function blocks(xml, name) {
    var re = new RegExp('<(?:\\w+:)?' + name + '(\\s[^>]*)?(/>|>([\\s\\S]*?)</(?:\\w+:)?' + name + '>)', 'gi'), out = [], m;
    while ((m = re.exec(xml))) out.push({ open: m[0].slice(0, m[0].indexOf('>') + 1), body: m[3] || '' });
    return out;
  }
  function okLatLng(lat, lng) { return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0); }

  // What a pin is, from its name, symbol and note. Words hunters use in onX, HuntStand and Garmin.
  var WORDS = [
    ['stand', /\b(tree ?stand|ladder|hang ?on|lock ?on|climber|stand|saddle set|box blind|elevated blind|seat|sit spot)\b/],
    ['crossing', /\bfunnel|pinch/],
    ['scrape', /\bscrapes?\b/], ['rub', /\brubs?\b|rub ?line/], ['bed', /\bbed(s|ding)?\b/],
    ['camera', /\b(trail ?)?cam(era)?s?\b/], ['feeder', /\bfeeder|corn pile|bait/], ['plot', /food ?plot|\bplots?\b|clover|brassica|turnips?/],
    ['food', /\bfood|acorn|oaks?\b|persimmon|apple|ag field|crop|beans?|corn/], ['water', /\bwater|pond|creek|spring|tank|wallow|seep/],
    ['crossing', /crossing|\bcross\b/], ['trail', /\btrails?\b|run\b|path/], ['shed', /\bsheds?\b|antler/],
    ['gate', /\bgate/], ['parking', /park(ing)?\b|truck|\blot\b|\batv\b|\bpull ?off/], ['blind', /\bblind/],
    ['sighting', /sighting|\bbuck\b|\bdoe\b|\bdeer\b|seen|shot|kill|harvest|blood|hit/]
  ];
  // onX Hunt keeps the pin's kind in its icon (<onx:icon>), so that wins over the name. "Location" and
  // "Point of Interest" say nothing, so those fall back to the words in the name and note.
  var ICONS = {
    'rub': 'rub', 'scrape': 'scrape', 'tree stand': 'stand', 'stand': 'stand', 'ground blind': 'blind', 'blind': 'blind',
    'bedding area': 'bed', 'bedding': 'bed', 'bed': 'bed', 'water source': 'water', 'water': 'water', 'wallow': 'water',
    'pinch point': 'crossing', 'funnel': 'crossing', 'crossing': 'crossing', 'tracks': 'trail', 'trail': 'trail', 'game trail': 'trail',
    'trail camera': 'camera', 'camera': 'camera', 'feeder': 'feeder', 'food source': 'food', 'food': 'food', 'crops': 'food',
    'food plot': 'plot', 'doe': 'sighting', 'buck': 'sighting', 'deer': 'sighting', 'sighting': 'sighting', 'shot': 'sighting',
    'blood': 'sighting', 'blood trail': 'sighting', 'kill site': 'sighting', 'scat': 'sighting', 'shed': 'shed', 'antler': 'shed',
    'gate': 'gate', 'parking': 'parking', 'truck': 'parking', '4x4': 'parking', 'atv': 'parking'
  };
  // onX (and Garmin) names a quick pin by its date, e.g. "Waypoint 10/22/25 05:35" or "My Location 10/30/25 09:31".
  // That date is when the pin was really dropped; the name itself says nothing, so it is left blank.
  function dateName(name) {
    var m = /^(waypoint|my location|location|pin|marker|point)\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2}))?\s*$/i.exec(name || '');
    if (!m) return null;
    var y = m[4].length === 2 ? 2000 + +m[4] : +m[4], p = function (n) { return (n < 10 ? '0' : '') + n; };
    return y + '-' + p(+m[2]) + '-' + p(+m[3]) + 'T' + p(+(m[5] || 12)) + ':' + p(+(m[6] || 0)) + ':00';
  }
  var TYPES = ['scrape', 'rub', 'bed', 'trail', 'sighting', 'shed', 'food', 'plot', 'water', 'crossing', 'camera', 'feeder', 'blind', 'gate', 'parking', 'other'];
  function guessType(name, sym, note, type, icon) {
    var t = String(type || '').toLowerCase();
    if (t.indexOf('standcast:') === 0) { t = t.slice(10); return t === 'stand' || TYPES.indexOf(t) >= 0 ? t : 'other'; }
    var ic = ICONS[String(icon || '').trim().toLowerCase()];
    if (ic) return ic;
    var hay = (name + ' ' + sym + ' ' + t).toLowerCase();
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < WORDS.length; i++) if (WORDS[i][1].test(hay)) return WORDS[i][0];
      hay = String(note || '').toLowerCase();       // nothing in the name: try the note
    }
    return 'other';
  }

  function fromGpx(xml) {
    var pts = [];
    blocks(xml, 'wpt').forEach(function (b) {
      var lat = parseFloat(attr(b.open, 'lat')), lng = parseFloat(attr(b.open, 'lon'));
      if (!okLatLng(lat, lng)) return;
      var name = decode(tag(b.body, 'name')), note = decode(tag(b.body, 'desc') || tag(b.body, 'cmt')), sym = decode(tag(b.body, 'sym')), type = decode(tag(b.body, 'type'));
      pts.push({ name: name, note: note, lat: lat, lng: lng, kind: guessType(name, sym, note, type, decode(tag(b.body, 'icon'))), time: decode(tag(b.body, 'time')) || null });
    });
    return { points: tidy(pts), lines: blocks(xml, 'trk').length + blocks(xml, 'rte').length };
  }
  // onX stamps every pin with the moment of the export, which is no use: drop a time all the pins share,
  // and take the real date from names like "Waypoint 10/22/25 05:35".
  function tidy(pts) {
    var shared = pts.length > 1 && pts.every(function (p) { return p.time && p.time === pts[0].time; });
    pts.forEach(function (p) {
      if (shared) p.time = null;
      var d = dateName(p.name);
      if (d) { p.time = d; p.name = ''; }
    });
    return pts;
  }
  function fromKml(xml) {
    var pts = [], lines = 0;
    blocks(xml, 'Placemark').forEach(function (b) {
      if (/<(\w+:)?(LineString|LinearRing|Polygon)\b/i.test(b.body)) { lines++; return; }
      var c = tag(tag(b.body, 'Point') || '', 'coordinates');
      if (!c) return;
      var p = c.trim().split(/\s+/)[0].split(','), lng = parseFloat(p[0]), lat = parseFloat(p[1]);
      if (!okLatLng(lat, lng)) return;
      var name = decode(tag(b.body, 'name')), note = decode(tag(b.body, 'description')), sym = decode(tag(b.body, 'styleUrl'));
      pts.push({ name: name, note: note, lat: lat, lng: lng, kind: guessType(name, sym, note, ''), time: decode(tag(b.body, 'when')) || null });
    });
    return { points: tidy(pts), lines: lines };
  }
  // text of a .gpx or .kml file -> { format, points: [{ name, note, lat, lng, kind, time }], lines }
  function parse(text) {
    var s = String(text || '');
    if (/<(\w+:)?gpx[\s>]/i.test(s)) return Object.assign({ format: 'GPX' }, fromGpx(s));
    if (/<(\w+:)?kml[\s>]/i.test(s) || /<(\w+:)?Placemark[\s>]/i.test(s)) return Object.assign({ format: 'KML' }, fromKml(s));
    throw new Error('This file is not GPX or KML.');
  }

  // KMZ: a zip holding doc.kml. Unzipped with the browser's own DecompressionStream (iPhone iOS 16.4 and newer).
  function unzipKml(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var end = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) return Promise.reject(new Error('This KMZ file looks damaged.'));
    var count = dv.getUint16(end + 10, true), at = dv.getUint32(end + 16, true), pick = null;
    for (var k = 0; k < count && dv.getUint32(at, true) === 0x02014b50; k++) {
      var method = dv.getUint16(at + 10, true), size = dv.getUint32(at + 20, true), nl = dv.getUint16(at + 28, true);
      var name = String.fromCharCode.apply(null, u8.subarray(at + 46, at + 46 + nl)), local = dv.getUint32(at + 42, true);
      if (/\.kml$/i.test(name) && (!pick || /(^|\/)doc\.kml$/i.test(name))) pick = { method: method, size: size, local: local };
      at += 46 + nl + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
    }
    if (!pick) return Promise.reject(new Error('No KML found inside this KMZ file.'));
    var start = pick.local + 30 + dv.getUint16(pick.local + 26, true) + dv.getUint16(pick.local + 28, true);
    var data = u8.subarray(start, start + pick.size);
    if (pick.method === 0) return Promise.resolve(new TextDecoder().decode(data));
    if (pick.method !== 8 || typeof DecompressionStream !== 'function') return Promise.reject(new Error('This phone cannot open KMZ files. Export as KML or GPX instead.'));
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }

  /* ---------- writing ---------- */

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ll(lat, lng) { return 'lat="' + (+lat).toFixed(6) + '" lon="' + (+lng).toFixed(6) + '"'; }
  // label(type) gives the plain name for a mark type, used when a mark has no name of its own
  function toGpx(stands, marks, label) {
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="StandCast" xmlns="http://www.topografix.com/GPX/1/1">',
      '<metadata><name>StandCast pins</name><time>' + new Date().toISOString() + '</time></metadata>'];
    function wpt(lat, lng, name, note, type, sym, at) {
      out.push('<wpt ' + ll(lat, lng) + '>' + (at ? '<time>' + new Date(at).toISOString() + '</time>' : '') + '<name>' + esc(name) + '</name>' +
        (note ? '<desc>' + esc(note) + '</desc>' : '') + '<sym>' + esc(sym) + '</sym><type>standcast:' + type + '</type></wpt>');
    }
    (stands || []).forEach(function (s) { wpt(s.lat, s.lng, s.name, s.notes, 'stand', 'Tree Stand', s.createdAt); });
    (marks || []).forEach(function (m) { var l = label ? label(m.type) : m.type; wpt(m.lat, m.lng, m.name || l, m.note, m.type, l, m.createdAt); });
    (stands || []).forEach(function (s) {
      var r = s.routes || {};
      [['in', 'walk in'], ['out', 'way out']].forEach(function (w) {
        var line = r[w[0]]; if (!line || line.length < 2) return;
        out.push('<trk><name>' + esc(s.name + ' ' + w[1]) + '</name><trkseg>' + line.map(function (p) { return '<trkpt ' + ll(p[0], p[1]) + '/>'; }).join('') + '</trkseg></trk>');
      });
    });
    out.push('</gpx>');
    return out.join('\n');
  }

  return { parse: parse, guessType: guessType, unzipKml: unzipKml, toGpx: toGpx, decode: decode };
});
