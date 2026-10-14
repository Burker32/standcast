const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const P = require('../js/pins.js');

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="onX Hunt" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="37.80960" lon="-93.62499"><name>North Ladder Stand</name><desc>Good on &amp; NW wind</desc><sym>Tree Stand</sym></wpt>
  <wpt lat="37.8101" lon="-93.6261"><name>big scrape</name></wpt>
  <wpt lat="37.8105" lon="-93.6270"><name>Pin 14</name><desc><![CDATA[<b>Bedding</b> on the point]]></desc></wpt>
  <wpt lat="0" lon="0"><name>broken</name></wpt>
  <wpt lat="37.81" lon="-93.62"><name>Truck</name></wpt>
  <trk><name>walk</name><trkseg><trkpt lat="37.8" lon="-93.6"/></trkseg></trk>
</gpx>`;

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Cam 3</name><description>Facing the creek</description><Point><coordinates>-91.24206,37.79247,0</coordinates></Point></Placemark>
  <Placemark><name>Food plot</name><Point><coordinates> -91.2430,37.7930 </coordinates></Point></Placemark>
  <Placemark><name>Boundary</name><LineString><coordinates>-91.1,37.1 -91.2,37.2</coordinates></LineString></Placemark>
</Document></kml>`;

test('pins: GPX waypoints come in with a guessed kind; tracks are counted, bad points dropped', () => {
  const r = P.parse(GPX);
  assert.equal(r.format, 'GPX');
  assert.equal(r.lines, 1);
  assert.deepEqual(r.points.map((p) => [p.name, p.kind]), [
    ['North Ladder Stand', 'stand'], ['big scrape', 'scrape'], ['Pin 14', 'bed'], ['Truck', 'parking']]);
  assert.equal(r.points[0].note, 'Good on & NW wind');
  assert.equal(r.points[2].note, 'Bedding on the point');
  assert.equal(r.points[0].lat, 37.8096); assert.equal(r.points[0].lng, -93.62499);
});

test('pins: KML placemarks (lng,lat order) and KMZ zips', async () => {
  const r = P.parse(KML);
  assert.equal(r.format, 'KML');
  assert.deepEqual(r.points.map((p) => [p.name, p.kind, p.lat, p.lng]), [['Cam 3', 'camera', 37.79247, -91.24206], ['Food plot', 'plot', 37.793, -91.243]]);
  assert.equal(r.lines, 1);
  // a one-file zip, deflated, the way Google Earth and HuntStand write KMZ
  const name = Buffer.from('doc.kml'), raw = Buffer.from(KML), data = zlib.deflateRawSync(raw);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const cdAt = 30 + name.length + data.length, cdLen = 46 + name.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdLen, 12); eocd.writeUInt32LE(cdAt, 16);
  const zip = Buffer.concat([local, name, data, cen, name, eocd]);
  const text = await P.unzipKml(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length));
  assert.equal(P.parse(text).points.length, 2);
});

test('pins: StandCast GPX goes out and comes back the same', () => {
  const stands = [{ name: 'Oak <Flat>', lat: 37.8, lng: -93.6, notes: 'NW & W', createdAt: 0, routes: { in: [[37.79, -93.61], [37.8, -93.6]], out: null } }];
  const marks = [{ type: 'rub', lat: 37.801, lng: -93.601, name: '', note: 'big', createdAt: 0 }, { type: 'other', lat: 37.802, lng: -93.602, name: 'Stand of oaks', note: '' }];
  const gpx = P.toGpx(stands, marks, (t) => t === 'rub' ? 'Rub' : 'Other');
  const back = P.parse(gpx);
  assert.equal(back.lines, 1);
  assert.deepEqual(back.points.map((p) => [p.name, p.kind, p.note]), [['Oak <Flat>', 'stand', 'NW & W'], ['Rub', 'rub', 'big'], ['Stand of oaks', 'other', '']]);
  assert.throws(() => P.parse('hello'), /not GPX or KML/);
});
