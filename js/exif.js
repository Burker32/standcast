/* Minimal EXIF GPS reader for JPEG photos, so a trail photo can place its own pin.
 * Browser: SC.exif.readGps(arrayBuffer). Node: require('./exif.js').
 * Returns { lat, lng } or null. Never throws on bad input. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SC = root.SC || {}; root.SC.exif = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function readGps(buf) { return inspect(buf).gps; }

  // Like readGps, but also says why there is no location, so the app can tell the user:
  //   'not-jpeg'  another kind of file (HEIC, PNG, a screenshot...)
  //   'no-exif'   a JPEG with its camera details removed (a copy from a message app, or an edited photo)
  //   'no-gps'    camera details are there, but no location was saved with them
  //   'blanked'   the location fields are there but emptied, which is how Android hides it from web apps
  function inspect(buf) {
    var none = function (why) { return { gps: null, why: why }; };
    try {
      var v = new DataView(buf);
      if (v.byteLength < 12 || v.getUint16(0) !== 0xFFD8) return none('not-jpeg');
      var off = 2;
      while (off + 4 < v.byteLength) {
        var marker = v.getUint16(off);
        off += 2;
        if (marker === 0xFFDA || (marker & 0xFF00) !== 0xFF00) return none('no-exif');
        var len = v.getUint16(off);
        if (marker === 0xFFE1 && v.getUint32(off + 2) === 0x45786966 && v.getUint16(off + 6) === 0) {
          var r = parseTiff(v, off + 8);
          return r && r.lat != null ? { gps: r, why: null } : none(r && r.blanked ? 'blanked' : 'no-gps');
        }
        off += len;
      }
    } catch (e) { /* truncated or malformed file */ }
    return none('no-exif');
  }

  // { lat, lng } when there is a location, { blanked: true } when the fields are there but empty, else null.
  function parseTiff(v, tiff) {
    var little = v.getUint16(tiff) === 0x4949;
    var u16 = function (o) { return v.getUint16(o, little); };
    var u32 = function (o) { return v.getUint32(o, little); };
    if (u16(tiff + 2) !== 0x2A) return null;
    var ifd0 = tiff + u32(tiff + 4), n = u16(ifd0), gps = null, i;
    for (i = 0; i < n; i++) {
      var e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x8825) gps = tiff + u32(e + 8);
    }
    if (gps == null) return null;
    var latRef = null, lngRef = null, lat = null, lng = null;
    var count = u16(gps);
    function rationals(e) {
      var o = tiff + u32(e + 8), out = [];
      for (var k = 0; k < 3; k++) {
        var den = u32(o + k * 8 + 4);
        out.push(den ? u32(o + k * 8) / den : 0);
      }
      return out[0] + out[1] / 60 + out[2] / 3600;
    }
    for (i = 0; i < count; i++) {
      var en = gps + 2 + i * 12, tag = u16(en);
      if (tag === 1) latRef = String.fromCharCode(v.getUint8(en + 8));
      else if (tag === 3) lngRef = String.fromCharCode(v.getUint8(en + 8));
      else if (tag === 2) lat = rationals(en);
      else if (tag === 4) lng = rationals(en);
    }
    if (lat == null || lng == null) return count ? { blanked: true } : null;
    if (lat === 0 && lng === 0) return { blanked: true };
    if (latRef === 'S') lat = -lat;
    if (lngRef === 'W') lng = -lng;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng };
  }

  // When the photo was taken, as the camera's own clock wrote it: 'YYYY-MM-DDTHH:MM:SS' (local time, no zone),
  // or null. Trail cameras stamp this on every shot, so a card pull sorts itself by date.
  function readDate(buf) {
    try {
      var v = new DataView(buf), off = 2;
      if (v.byteLength < 12 || v.getUint16(0) !== 0xFFD8) return null;
      while (off + 4 < v.byteLength) {
        var marker = v.getUint16(off); off += 2;
        if (marker === 0xFFDA || (marker & 0xFF00) !== 0xFF00) return null;
        var len = v.getUint16(off);
        if (marker === 0xFFE1 && v.getUint32(off + 2) === 0x45786966 && v.getUint16(off + 6) === 0) return tiffDate(v, off + 8);
        off += len;
      }
    } catch (e) { /* truncated or malformed file */ }
    return null;
  }
  function tiffDate(v, tiff) {
    var little = v.getUint16(tiff) === 0x4949;
    var u16 = function (o) { return v.getUint16(o, little); }, u32 = function (o) { return v.getUint32(o, little); };
    if (u16(tiff + 2) !== 0x2A) return null;
    function scan(ifd, want) {
      var n = u16(ifd), found = {};
      for (var i = 0; i < n; i++) { var e = ifd + 2 + i * 12, t = u16(e); if (want.indexOf(t) >= 0) found[t] = e; }
      return found;
    }
    function text(e) {
      var count = u32(e + 4), o = count > 4 ? tiff + u32(e + 8) : e + 8, s = '';
      for (var k = 0; k < Math.min(count, 32); k++) { var c = v.getUint8(o + k); if (!c) break; s += String.fromCharCode(c); }
      var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
      return m && m[1] !== '0000' ? m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] : null;
    }
    var ifd0 = tiff + u32(tiff + 4), top = scan(ifd0, [0x8769, 0x0132]);
    if (top[0x8769]) { var ex = scan(tiff + u32(top[0x8769] + 8), [0x9003, 0x9004]), d = ex[0x9003] || ex[0x9004]; if (d) { var r = text(d); if (r) return r; } }
    return top[0x0132] ? text(top[0x0132]) : null;
  }

  return { readGps: readGps, inspect: inspect, readDate: readDate };
});
