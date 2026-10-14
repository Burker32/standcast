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

test('reads when a photo was taken (trail camera date stamp), else null', () => {
  const { readDate } = require('../js/exif.js');
  function jpeg(dt0, dtOrig, big) {
    const T = Buffer.alloc(96), w16 = (o, x) => big ? T.writeUInt16BE(x, o) : T.writeUInt16LE(x, o), w32 = (o, x) => big ? T.writeUInt32BE(x, o) : T.writeUInt32LE(x, o);
    T.write(big ? 'MM' : 'II', 0, 'latin1'); w16(2, 0x2A); w32(4, 8);
    w16(8, 2);
    w16(10, 0x0132); w16(12, 2); w32(14, 20); w32(18, 38);
    w16(22, 0x8769); w16(24, 4); w32(26, 1); w32(30, 58);
    w32(34, 0);
    T.write(dt0, 38, 'latin1');
    w16(58, 1); w16(60, 0x9003); w16(62, 2); w32(64, 20); w32(68, 76); w32(72, 0);
    T.write(dtOrig, 76, 'latin1');
    const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), T]);
    app1.writeUInt16BE(app1.length - 2, 2);
    const b = Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xD9])]);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  }
  assert.equal(readDate(jpeg('2026:10:01 08:00:00', '2026:10:12 06:41:09')), '2026-10-12T06:41:09');
  assert.equal(readDate(jpeg('2026:10:01 08:00:00', '2026:10:12 06:41:09', true)), '2026-10-12T06:41:09');
  assert.equal(readDate(jpeg('2026:10:01 08:00:00', '0000:00:00 00:00:00')), '2026-10-01T08:00:00');   // falls back to the file date
  assert.equal(readDate(new ArrayBuffer(0)), null);
  assert.equal(readDate(ab(require('node:path').join(__dirname, 'fixtures', 'gps_little.jpg')).slice(0, 40)), null);
});