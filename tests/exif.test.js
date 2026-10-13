const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { readGps, inspect } = require('../js/exif.js');
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
test('says why a photo has no location', () => {
  const fx = (n) => ab(require('node:path').join(__dirname, 'fixtures', n));
  assert.equal(inspect(fx('gps_little.jpg')).why, null);
  near(inspect(fx('gps_little.jpg')).gps.lat, 37.6612, 0.0005);
  assert.ok(['no-exif', 'no-gps'].includes(inspect(fx('nogps.jpg')).why));
  assert.equal(inspect(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer).why, 'not-jpeg');
  assert.equal(inspect(new ArrayBuffer(0)).why, 'not-jpeg');
  // a JPEG whose location numbers were zeroed out (how Android hides it) reads as blanked, not as 0,0
  const b = new Uint8Array(fx('gps_little.jpg')), v = new DataView(b.buffer);
  let hit = 0;
  for (let i = 0; i + 8 <= b.length; i++) { if (v.getUint32(i, true) === 37 && v.getUint32(i + 4, true) === 1) { hit = i; break; } }
  assert.ok(hit > 0, 'found the latitude degrees in the fixture');
  for (let i = hit; i < b.length; i++) b[i] = i < hit + 48 ? 0 : b[i];
  const z = inspect(b.buffer);
  assert.equal(z.gps, null);
  assert.ok(['blanked', 'no-gps'].includes(z.why));
});
