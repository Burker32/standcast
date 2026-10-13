/* Minimal EXIF GPS reader for JPEG photos, so a trail photo can place its own pin.
 * Browser: SC.exif.readGps(arrayBuffer). Node: require('./exif.js').
 * Returns { lat, lng } or null. Never throws on bad input. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SC = root.SC || {}; root.SC.exif = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function readGps(buf) {
    try {
      var v = new DataView(buf);
      if (v.byteLength < 12 || v.getUint16(0) !== 0xFFD8) return null;
      var off = 2;
      while (off + 4 < v.byteLength) {
        var marker = v.getUint16(off);
        off += 2;
        if (marker === 0xFFDA || (marker & 0xFF00) !== 0xFF00) return null;
        var len = v.getUint16(off);
        if (marker === 0xFFE1 && v.getUint32(off + 2) === 0x45786966 && v.getUint16(off + 6) === 0) {
          return parseTiff(v, off + 8);
        }
        off += len;
      }
    } catch (e) { /* truncated or malformed file */ }
    return null;
  }

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
    if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
    if (latRef === 'S') lat = -lat;
    if (lngRef === 'W') lng = -lng;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng };
  }

  return { readGps: readGps };
});
