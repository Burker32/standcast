const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { readGps } = require('../js/exif.js');
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const near = (a, b, t) => assert.ok(Math.abs(a - b) < t, a + ' vs ' + b);

test('reads GPS from little- and big-endian EXIF, with hemisphere signs', () => {
  const a = readGps(ab(require('node:path').join(__dirname, 'fixtures', 'gps_little.jpg')));
  near(a.lat, 37.6612, 0.0005); near(a.lng, -93.7634, 0.0005);
  const b = readGps(ab(require('node:path').join(__dirname, 'fixtures', 'gps_big.jpg')));
  near(b.lat, -33.8688, 0.0005); near(b.lng, 151.2093, 0.0005);
});
test('returns null for photos without GPS and for junk', () => {
  assert.equal(readGps(ab(require('node:path').join(__dirname, 'fixtures', 'nogps.jpg'))), null);
  assert.equal(readGps(new ArrayBuffer(0)), null);
  assert.equal(readGps(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer), null);
  const trunc = ab(require('node:path').join(__dirname, 'fixtures', 'gps_little.jpg')).slice(0, 60);
  assert.equal(readGps(trunc), null);
});
