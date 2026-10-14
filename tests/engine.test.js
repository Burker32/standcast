const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

const LAT = 37.66, LNG = -93.76;          // Stockton Lake, MO
const OFFSET = -5 * 3600;                 // CDT in October 2026
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' +/- ' + tol + ', got ' + a);

// Local wall-clock -> naive minutes
const L = (iso) => E.parseLocalMin(iso);

// Build a synthetic Open-Meteo style forecast: 72 hours from 2026-10-09 00:00 local.
function makeForecast(opts) {
  opts = opts || {};
  const speed = opts.speed == null ? 8 : opts.speed;
  const dir = opts.dir == null ? 315 : opts.dir;
  const cloud = opts.cloud == null ? 15 : opts.cloud;
  const precip = opts.precip == null ? 5 : opts.precip;
  const time = [], t_ = [], d_ = [], s_ = [], g_ = [], c_ = [], p_ = [], sw_ = [];
  for (let h = 0; h < 72; h++) {
    const day = 9 + Math.floor(h / 24), hr = h % 24;
    const iso = '2026-10-' + String(day).padStart(2, '0') + 'T' + String(hr).padStart(2, '0') + ':00';
    time.push(iso);
    const tMin = L(iso);
    const sun = E.solarPosition(tMin * 60000 - OFFSET * 1000, LAT, LNG);
    const clearSw = sun.elev > 0 ? 950 * Math.sin(sun.elev * E.DEG) : 0;
    t_.push(55); c_.push(cloud); p_.push(precip); g_.push(speed * 1.4);
    s_.push(typeof speed === 'function' ? speed(h) : speed);
    d_.push(typeof dir === 'function' ? dir(h) : dir);
    sw_.push(clearSw * (1 - cloud / 100 * 0.75));
  }
  return E.normalizeForecast({
    utc_offset_seconds: OFFSET,
    hourly: { time, temperature_2m: t_, precipitation_probability: p_, cloud_cover: c_, wind_speed_10m: s_, wind_direction_10m: d_, wind_gusts_10m: g_, shortwave_radiation: sw_ },
    daily: {
      time: ['2026-10-09', '2026-10-10', '2026-10-11'],
      sunrise: ['2026-10-09T07:15', '2026-10-10T07:16', '2026-10-11T07:17'],
      sunset: ['2026-10-09T18:49', '2026-10-10T18:47', '2026-10-11T18:46']
    }
  });
}

test('wind vectors round trip and use the "from" convention', () => {
  const v = E.toVec(0, 10);                    // north wind blows toward the south
  near(v.u, 0, 1e-9); near(v.v, -10, 1e-9);
  const w = E.fromVec(v.u, v.v);
  near(w.speed, 10, 1e-9); near(w.from, 0, 1e-6);
  const e = E.fromVec(-5, 0);                  // air moving west = wind from the east
  near(e.from, 90, 1e-6);
  [0, 45, 133, 270, 359].forEach(d => near(E.angDiff(E.fromVec(E.toVec(d, 7).u, E.toVec(d, 7).v).from, d), 0, 1e-6));
});

test('solar position matches known values for the Ozarks in early October', () => {
  // Solar noon is about 18:03 UTC here (lon -93.76, equation of time ~ +12 min). Declination ~ -6.4 deg.
  const noon = Date.UTC(2026, 9, 9, 18, 3);
  const p = E.solarPosition(noon, LAT, LNG);
  near(p.elev, 90 - LAT - 6.4, 1.2, 'noon elevation');
  near(p.az, 180, 4, 'noon azimuth');
  const midnight = E.solarPosition(Date.UTC(2026, 9, 10, 6, 0), LAT, LNG);
  assert.ok(midnight.elev < -30);
  const morning = E.solarPosition(Date.UTC(2026, 9, 9, 14, 0), LAT, LNG); // 9 AM CDT
  assert.ok(morning.az > 90 && morning.az < 140, 'morning sun is in the east-southeast: ' + morning.az);
  const evening = E.solarPosition(Date.UTC(2026, 9, 9, 22, 0), LAT, LNG); // 5 PM CDT
  assert.ok(evening.az > 225 && evening.az < 270 && evening.elev > 0, 'evening sun is in the west-southwest');
  // Sunrise and sunset from the forecast should be near zero elevation.
  const sr = E.solarPosition(L('2026-10-09T07:15') * 60000 - OFFSET * 1000, LAT, LNG);
  const ss = E.solarPosition(L('2026-10-09T18:49') * 60000 - OFFSET * 1000, LAT, LNG);
  near(sr.elev, 0, 3, 'sunrise'); near(ss.elev, 0, 3, 'sunset');
});

test('terrain: slope and downhill direction from four elevation samples', () => {
  // Ground rises toward the east, so the slope faces (drains) west.
  const a = E.terrainFromSamples(100, 110, 100, 90, 150);
  near(a.aspectDeg, 270, 0.01);
  near(a.slopeDeg, Math.atan(20 / 300) / E.DEG, 0.01);
  // Ground rises toward the north: slope faces south.
  near(E.terrainFromSamples(120, 100, 100, 100, 150).aspectDeg, 180, 0.01);
  // Flat ground has no aspect.
  assert.equal(E.terrainFromSamples(100, 100.2, 100, 100, 150).aspectDeg, null);
  const pts = E.terrainProbePoints(LAT, LNG, 150);
  near(pts[1][0] - LAT, 150 / 111320, 1e-7); near(pts[2][1] - LNG, 150 / (111320 * Math.cos(LAT * E.DEG)), 1e-7);
});

test('thermals: sink at night, rise on a sun-warmed slope, vanish when it blows or is flat', () => {
  const night = { elev: -30, az: 0 };
  const t1 = E.thermal({ slopeDeg: 15, aspectDeg: 90, sun: night, sw: 0, cloud: 5, windMph: 2 });
  assert.ok(t1.index < -0.8 && t1.phase === 'falling');
  near(E.angDiff(t1.toward, 90), 0, 1e-9); // air flows downhill, toward the way the slope faces
  const sunny = E.thermal({ slopeDeg: 15, aspectDeg: 90, sun: { elev: 35, az: 95 }, sw: 700, cloud: 5, windMph: 2 });
  assert.ok(sunny.index > 0.5 && sunny.phase === 'rising');
  near(E.angDiff(sunny.toward, 270), 0, 1e-9); // uphill is the opposite way
  const breezy = E.thermal({ slopeDeg: 15, aspectDeg: 90, sun: night, sw: 0, cloud: 5, windMph: 10 });
  assert.ok(breezy.strength > 0.2 && breezy.strength < t1.strength, 'still matters under the canopy in a 10 mph wind');
  assert.equal(E.thermal({ slopeDeg: 15, aspectDeg: 90, sun: night, sw: 0, cloud: 5, windMph: 22 }).strength, 0);
  const gentle = E.thermal({ slopeDeg: 4, aspectDeg: 90, sun: night, sw: 0, cloud: 5, windMph: 6 });
  assert.ok(gentle.strength >= 0.3 && gentle.phase === 'falling', 'a gentle Ozark slope still drains: ' + gentle.strength);
  const flat = E.thermal({ slopeDeg: 0.5, aspectDeg: null, sun: night, sw: 0, cloud: 0, windMph: 0 });
  assert.ok(flat.flat && flat.mph === 0 && flat.toward == null, 'flat ground settles in place, no drift');
  const clouded = E.thermal({ slopeDeg: 15, aspectDeg: 90, sun: night, sw: 0, cloud: 100, windMph: 2 });
  assert.ok(clouded.strength < t1.strength, 'overcast nights drain less');
  // A slope facing away from the low sun stays in shade and keeps sinking.
  const shade = E.thermal({ slopeDeg: 15, aspectDeg: 270, sun: { elev: 8, az: 100 }, sw: 150, cloud: 5, windMph: 2 });
  const lit = E.thermal({ slopeDeg: 15, aspectDeg: 90, sun: { elev: 8, az: 100 }, sw: 150, cloud: 5, windMph: 2 });
  assert.ok(shade.index < lit.index);
});

test('wind rating interpolates between compass sectors', () => {
  const winds = { NW: 'good', N: 'bad', W: 'good' };
  near(E.windRating(winds, 315), 1, 1e-9);
  near(E.windRating(winds, 0), 0, 1e-9);
  near(E.windRating(winds, 337.5), 0.5, 1e-9);        // halfway between NW (good) and N (bad)
  near(E.windRating(winds, 135), 0.5, 1e-9);          // unset sector = neutral
  assert.equal(E.isConfigured({}), false);
  assert.equal(E.isConfigured({ N: 'good' }), true);
});

test('forecast normalization fills gaps and parses local times', () => {
  const fc = E.normalizeForecast({
    utc_offset_seconds: OFFSET,
    hourly: { time: ['2026-10-09T00:00', '2026-10-09T01:00'], temperature_2m: [50, null], cloud_cover: [10, 20], wind_speed_10m: [5, null], wind_direction_10m: [270, null], wind_gusts_10m: [8, 9], shortwave_radiation: [0, 0] },
    daily: { time: ['2026-10-09'], sunrise: ['2026-10-09T07:15'], sunset: ['2026-10-09T18:49'] }
  });
  assert.equal(fc.temp[1], 50); assert.equal(fc.speed[1], 5); assert.equal(fc.precip[0], 0);
  assert.equal(fc.t[1] - fc.t[0], 60);
  assert.equal(E.fmtClock(fc.daily[0].sunset), '6:49 PM');
  assert.equal(E.fmtClock(L('2026-10-09T00:05')), '12:05 AM');
  assert.equal(E.fmtClock(L('2026-10-09T12:00')), '12:00 PM');
});

test('forecast sampling interpolates wind as vectors', () => {
  const fc = makeForecast({ speed: (h) => (h === 10 ? 10 : 20), dir: (h) => (h === 10 ? 270 : 270) });
  const mid = E.sampleForecast(fc, L('2026-10-09T10:30'));
  near(mid.speed, 15, 1e-6); near(mid.from, 270, 1e-6);
  const swing = makeForecast({ speed: 10, dir: (h) => (h < 12 ? 0 : 90) });
  const s = E.sampleForecast(swing, L('2026-10-09T11:30'));
  near(s.from, 45, 1e-6);
  const past = E.sampleForecast(fc, L('2026-10-08T00:00'));
  assert.ok(Number.isFinite(past.speed));
});

test('sit windows: labels, ordering and in-progress handling', () => {
  const fc = makeForecast();
  const afternoon = L('2026-10-09T13:00');
  const sits = E.listSits(fc, afternoon, 6);
  assert.deepEqual(sits.map(s => s.label), ['Tonight', 'Tomorrow AM', 'Tomorrow PM', 'Sun AM', 'Sun PM']);
  assert.equal(sits[0].inProgress, false);
  assert.equal(E.fmtClock(sits[0].start), '3:49 PM');
  const evening = E.listSits(fc, L('2026-10-09T17:00'), 6);
  assert.equal(evening[0].inProgress, true);
  assert.equal(evening[0].start, L('2026-10-09T17:00'));
  const early = E.listSits(fc, L('2026-10-09T06:00'), 3);
  assert.equal(early[0].label, 'This morning');
});

test('ranking: a stand whose good winds match beats one that does not', () => {
  const fc = makeForecast({ speed: 8, dir: 315 });
  const now = L('2026-10-09T13:00');
  const sit = E.listSits(fc, now, 1)[0];
  const win = E.windowForStand(fc, sit, now);
  const flat = { lat: LAT, lng: LNG, terrain: { slopeDeg: 0, aspectDeg: null } };
  const fits = Object.assign({}, flat, { winds: { NW: 'good', W: 'good', N: 'good', S: 'bad', SE: 'bad', E: 'bad' } });
  const clashes = Object.assign({}, flat, { winds: { NW: 'bad', W: 'bad', N: 'bad', S: 'good', SE: 'good', E: 'good' } });
  const unset = Object.assign({}, flat, { winds: {} });
  const a = E.evaluateSit(fits, fc, win, now), b = E.evaluateSit(clashes, fc, win, now), c = E.evaluateSit(unset, fc, win, now);
  assert.ok(a.score >= 80, 'matching stand should be prime, got ' + a.score);
  assert.ok(b.score <= 45, 'clashing stand should be skipped, got ' + b.score);
  assert.ok(a.score - b.score >= 35);
  assert.ok(c.score > b.score && c.score < a.score);
  assert.equal(c.configured, false);
  assert.ok(c.reasons.some(r => /Mark this stand/.test(r.text)));
  assert.equal(a.label.text === 'Prime' || a.label.text === 'Good', true);
});

test('ranking: shifting wind, light air, rain and recent hunting all cost points', () => {
  const now = L('2026-10-09T13:00');
  const winds = { NW: 'good', W: 'good', N: 'good', NE: 'bad', E: 'bad' };
  const stand = { lat: LAT, lng: LNG, winds, terrain: { slopeDeg: 0, aspectDeg: null } };
  function score(fcOpts, st) {
    const fc = makeForecast(fcOpts);
    const sit = E.listSits(fc, now, 1)[0];
    return E.evaluateSit(st || stand, fc, E.windowForStand(fc, sit, now), now);
  }
  const base = score({ speed: 8, dir: 315 });
  const swing = score({ speed: 8, dir: (h) => (h < 17 ? 315 : 45) });
  assert.ok(swing.score < base.score - 10, 'swing ' + swing.score + ' vs base ' + base.score);
  assert.ok(swing.reasons.some(r => /turns to the/i.test(r.text)));
  const calm = score({ speed: 0.5, dir: 315 });
  assert.ok(calm.score < base.score - 10);
  const gale = score({ speed: 24, dir: 315 });
  assert.ok(gale.score < base.score - 10);
  const wet = score({ speed: 8, dir: 315, precip: 90 });
  assert.ok(wet.score < base.score);
  const pressured = score({ speed: 8, dir: 315 }, Object.assign({}, stand, { sits: [{ date: '2026-10-08' }] }));
  assert.equal(pressured.summary.daysSince, 1);
  assert.ok(pressured.score < base.score);
  assert.ok(pressured.reasons.some(r => /yesterday/.test(r.text)));
});

test('thermals shift the effective wind on a real slope during an evening sit', () => {
  const now = L('2026-10-09T13:00');
  const fc = makeForecast({ speed: 2, dir: 270, cloud: 0 });
  const sit = E.listSits(fc, now, 1)[0];
  const win = E.windowForStand(fc, sit, now);
  const hill = { lat: LAT, lng: LNG, winds: { W: 'good' }, terrain: { slopeDeg: 16, aspectDeg: 135 } }; // faces southeast
  const r = E.evaluateSit(hill, fc, win, now);
  assert.ok(r.summary.thermalStrength > 0.1, 'thermal strength ' + r.summary.thermalStrength);
  assert.ok(['rising', 'falling'].includes(r.summary.thermalPhase));
  const flat = Object.assign({}, hill, { terrain: { slopeDeg: 0, aspectDeg: null } });
  const rf = E.evaluateSit(flat, fc, win, now);
  assert.ok(rf.summary.thermalStrength < r.summary.thermalStrength);
  assert.ok(rf.samples.every((x) => x.thermal.mph === 0), 'flat ground adds no sideways drift');
  // Manual overrides win over auto-detected terrain.
  const t = E.resolveTerrain({ terrain: { slopeDeg: 16, aspectDeg: 135 }, override: { aspect: 'N', steep: 'steep' } });
  assert.equal(t.aspectDeg, 0); assert.equal(t.slopeDeg, 22); assert.equal(t.source, 'manual');
  assert.equal(E.resolveTerrain({ terrain: { slopeDeg: 16, aspectDeg: 135 }, override: { aspect: 'flat' } }).aspectDeg, null);
});

test('evening thermals reverse: rising in the afternoon sun, falling after dark', () => {
  const fc = makeForecast({ speed: 2, dir: 270, cloud: 0 });
  const st = { lat: LAT, lng: LNG, winds: {}, terrain: { slopeDeg: 18, aspectDeg: 225 } }; // faces southwest
  const mid = E.stateAt(st, fc, L('2026-10-09T15:00'));
  const night = E.stateAt(st, fc, L('2026-10-09T23:00'));
  assert.ok(mid.thermal.index > 0, 'afternoon sun-warmed slope should rise, index ' + mid.thermal.index);
  assert.ok(night.thermal.index < -0.5, 'night should sink, index ' + night.thermal.index);
});

test('scent cone and arrow geometry', () => {
  const ring = E.coneRing(LAT, LNG, 90, 8);            // wind blowing toward the east
  assert.deepEqual(ring[0], [LAT, LNG]);
  const arc = ring.slice(1);
  assert.equal(arc.length % 2, 1, 'arc has a centre point');
  const far = arc[(arc.length - 1) / 2];
  assert.ok(far[1] > LNG && Math.abs(far[0] - LAT) < 1e-7, 'centre of the cone points due east');
  const dEast = (far[1] - LNG) * 111320 * Math.cos(LAT * E.DEG);
  near(dEast, 55 + 8 * 30, 0.5);
  near(arc[0][0] - LAT, -(arc[arc.length - 1][0] - LAT), 1e-9); // symmetric about the wind line
  const puddle = E.coneRing(LAT, LNG, 90, 0.5);
  assert.ok(puddle.length >= 12 && puddle[0] !== undefined);
  assert.ok(E.coneRing(LAT, LNG, 0, 3).length < E.coneRing(LAT, LNG, 0, 15).length + 20);
  const arrow = E.arrowShape(LAT, LNG, 0, 100);
  near((arrow.shaft[1][0] - LAT) * 111320, 100, 0.5);
  assert.equal(arrow.head.length, 3);
});

test('finds the evening thermal flip time', () => {
  const now = L('2026-10-09T13:00');
  const fc = makeForecast({ speed: 3, dir: 270, cloud: 0 });
  const st = { lat: LAT, lng: LNG, winds: { W: 'good' }, terrain: { slopeDeg: 10, aspectDeg: 90 } }; // faces east, shaded early
  const flips = E.thermalSwitches(st, fc, L('2026-10-09T12:00'), L('2026-10-09T21:00'));
  assert.ok(flips.length >= 1, 'should flip in the afternoon or evening');
  const down = flips.filter((f) => f.to === 'falling').pop();
  assert.ok(down && down.t > L('2026-10-09T13:00') && down.t < L('2026-10-09T20:00'), 'flip at ' + (down && E.fmtClock(down.t)));
  const west = Object.assign({}, st, { terrain: { slopeDeg: 10, aspectDeg: 270 } });
  const dw = E.thermalSwitches(west, fc, L('2026-10-09T12:00'), L('2026-10-09T21:00')).filter((f) => f.to === 'falling').pop();
  assert.ok(dw.t > down.t, 'a west-facing slope keeps the sun longer and flips later');
});

test('swirl: thermals fighting the wind, and the lee side of a slope', () => {
  const night = { elev: -10, az: 280 };
  // East-facing slope at dusk: cool air drains east (downhill). An east wind blows up the slope against it.
  const th = E.thermal({ slopeDeg: 10, aspectDeg: 90, sun: night, sw: 0, cloud: 5, windMph: 4 });
  const fight = E.swirl({ slopeDeg: 10, aspectDeg: 90, th, windFrom: 90, windMph: 5 });
  assert.equal(fight.kind, 'fight'); assert.ok(fight.score > 0.5, 'even match should swirl: ' + fight.score);
  // Same slope, wind blowing the same way the air drains: no fight.
  const along = E.swirl({ slopeDeg: 10, aspectDeg: 90, th, windFrom: 270, windMph: 5 });
  assert.ok(along.kind !== 'fight');
  // A strong wind up the slope simply wins: much less swirl than the even match.
  const strong = E.swirl({ slopeDeg: 10, aspectDeg: 90, th, windFrom: 90, windMph: 25 });
  assert.ok(strong.score < fight.score);
  // Lee eddy: steep slope facing downwind in a real breeze.
  const lee = E.swirl({ slopeDeg: 14, aspectDeg: 180, th: E.thermal({ slopeDeg: 14, aspectDeg: 180, sun: { elev: 30, az: 180 }, sw: 600, cloud: 0, windMph: 12 }), windFrom: 0, windMph: 12 });
  assert.equal(lee.kind, 'lee'); assert.ok(lee.score > 0.4, 'lee ' + lee.score);
  assert.equal(E.swirl({ slopeDeg: 0.5, aspectDeg: null, th, windFrom: 90, windMph: 5 }).score, 0);
});

test('swirl shows up in a sit evaluation and costs a few points', () => {
  const now = L('2026-10-09T13:00');
  const fc = makeForecast({ speed: 5, dir: 90, cloud: 0 }); // east wind
  const sit = E.listSits(fc, now, 1)[0], win = E.windowForStand(fc, sit, now);
  const base = { lat: LAT, lng: LNG, winds: { E: 'good' } };
  const eastFace = E.evaluateSit(Object.assign({ terrain: { slopeDeg: 10, aspectDeg: 90 } }, base), fc, win, now);
  assert.ok(eastFace.summary.swirlFrac > 0, 'expected swirl on an east slope with an east wind at dusk');
  assert.ok(eastFace.reasons.some((r) => /Swirl likely/.test(r.text)));
});

test('distance and yardage', () => {
  // 0.001 degrees of latitude is about 111.2 m, about 121.6 yd
  const m = E.distanceM(37.66, -93.76, 37.661, -93.76);
  assert.ok(Math.abs(m - 111.2) < 0.5, 'meters ' + m);
  assert.equal(E.fmtYards(m), '122 yd');
  // east-west shrinks with latitude: cos(37.66) ≈ 0.792
  const e = E.distanceM(37.66, -93.76, 37.66, -93.759);
  assert.ok(Math.abs(e - 88.1) < 0.5, 'meters east ' + e);
  assert.equal(E.fmtYards(1609.344), '1.00 mi');
  assert.equal(E.distanceM(37.66, -93.76, 37.66, -93.76), 0);
});

test('swirl spots: pinpointed on the fine grid, not smeared everywhere', () => {
  // A ridge running north-south with its crest at column 10; ground falls away east and west.
  const spacing = 60, rows = 21, cols = 21, dLat = spacing / 111320, dLng = spacing / (111320 * Math.cos(37.66 * Math.PI / 180));
  const elev = (i, j) => 300 - Math.abs(j - 10) * 16;          // 16 m per 60 m: about 15 degree sides, a real Ozark ridge
  const grid = { spacing, rows, cols, dLat, dLng, pts: [] };
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) grid.pts.push([37.6 + i * dLat, -93.8 + j * dLng]);
  const z = grid.pts.map((p, k) => elev(Math.floor(k / cols), k % cols));
  const cells = E.flowCells(grid, z);
  const night = { elev: -8, az: 280 };
  // West wind 12 mph at dusk: lee side is the east slope, just below the crest.
  const spots = E.swirlSpots(cells, grid, { sun: night, smp: { from: 270, speed: 12, sw: 0, cloud: 5 } });
  assert.ok(spots.length >= 1, 'expected at least one swirl spot');
  const crestLng = -93.8 + 10 * dLng;
  const lee = spots.filter((p) => p.kind === 'lee');
  assert.ok(lee.length >= 1, 'expected a lee eddy: ' + JSON.stringify(spots.map((p) => p.kind)));
  lee.forEach((p) => {
    const colsFromCrest = (p.lng - crestLng) / dLng;
    assert.ok(colsFromCrest > 0 && colsFromCrest <= 2.5, 'lee spot should sit just east (downwind) of the crest, got ' + colsFromCrest.toFixed(2));
  });
  // rings are tight: well under one grid spacing across
  spots.forEach((p) => assert.ok(p.rM < spacing * 0.4, 'ring radius ' + p.rM));
  // the 5x5 peak rule keeps them sparse along a uniform ridge
  assert.ok(spots.length < rows, 'too many spots: ' + spots.length);
});

test('swirl spots: a hollow where draining air meets wind pushing up it', () => {
  // A hollow (draw) running north-south along column 10, sides rising east and west.
  const spacing = 60, rows = 21, cols = 21, dLat = spacing / 111320, dLng = spacing / (111320 * Math.cos(37.66 * Math.PI / 180));
  const grid = { spacing, rows, cols, dLat, dLng, pts: [] };
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) grid.pts.push([37.6 + i * dLat, -93.8 + j * dLng]);
  const z = grid.pts.map((p, k) => 250 + Math.abs((k % cols) - 10) * 12 + Math.floor(k / cols) * 1.5);   // also climbs gently north
  const cells = E.flowCells(grid, z);
  // dusk, light south wind blowing up the hollow while cool air drains down both sides into it
  const spots = E.swirlSpots(cells, grid, { sun: { elev: -6, az: 275 }, smp: { from: 180, speed: 5, sw: 0, cloud: 0 } });
  assert.ok(spots.length >= 1, 'expected swirl in the hollow');
  const axisLng = -93.8 + 10 * dLng;
  const near = spots.filter((p) => Math.abs(p.lng - axisLng) / dLng <= 2);
  assert.ok(near.length >= 1, 'a swirl spot should sit in or right beside the hollow: ' + JSON.stringify(spots.map((p) => ((p.lng - axisLng) / dLng).toFixed(1) + p.kind)));
});

// ---- benches ----
// A hillside that falls away to the south; `slopeAt(row)` gives the slope in degrees at each row.
function hillside(rows, cols, cellM, slopeAt) {
  const z = new Float32Array(rows * cols);
  let h = 400;
  for (let i = 0; i < rows; i++) {
    if (i) h -= cellM * Math.tan(slopeAt(i) * Math.PI / 180);
    for (let j = 0; j < cols; j++) z[i * cols + j] = h;
  }
  return z;
}
test('benches: finds a flat strip part-way up a hillside and nothing else', () => {
  const R = 100, C = 100, d = 4;
  const z = hillside(R, C, d, (i) => (i >= 45 && i <= 51 ? 2 : 20));
  const out = E.findBenches(z, R, C, d);
  assert.equal(out.benches.length, 1);
  let inBand = 0, outside = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) if (out.mask[i * C + j]) { if (i >= 44 && i <= 52) inBand++; else outside++; }
  assert.ok(inBand > 150, 'bench cells found: ' + inBand);
  assert.equal(outside, 0);
  assert.ok(out.benches[0].lenM > 200, 'runs along the hill: ' + out.benches[0].lenM);
  assert.ok(Math.abs(out.benches[0].row - 48) <= 2);
});
test('benches: an even slope, flat ground, a ridge top and a creek bottom are not benches', () => {
  const R = 100, C = 100, d = 4, none = (z) => E.findBenches(z, R, C, d).benches.length;
  assert.equal(none(hillside(R, C, d, () => 20)), 0);                    // even slope
  assert.equal(none(hillside(R, C, d, () => 0.5)), 0);                   // flat field
  assert.equal(none(hillside(R, C, d, (i) => (i < 40 ? 1 : 20))), 0);    // flat top, then it drops away
  assert.equal(none(hillside(R, C, d, (i) => (i < 60 ? 20 : 1))), 0);    // hill, then a flat bottom
});
test('benches: a small scrap is dropped, and missing data does not crash it', () => {
  const R = 100, C = 100, d = 4;
  const z = hillside(R, C, d, (i) => (i >= 45 && i <= 51 ? 2 : 20));
  // keep the bench only in a 3-cell-wide sliver: too small to count
  const steep = hillside(R, C, d, () => 20);
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) if (j < 48 || j > 50) z[i * C + j] = steep[i * C + j];
  assert.equal(E.findBenches(z, R, C, d).benches.length, 0);
  const holes = hillside(R, C, d, (i) => (i >= 45 && i <= 51 ? 2 : 20));
  for (let k = 0; k < 400; k++) holes[(k * 37) % (R * C)] = NaN;
  assert.ok(E.findBenches(holes, R, C, d).mask.length === R * C);
  assert.equal(E.findBenches(new Float32Array(R * C).fill(NaN), R, C, d).benches.length, 0);
});
test('bench elevation tiles: fixed squares that cover the view', () => {
  const b = { s: 37.625, n: 37.639, w: -93.816, e: -93.808 };          // about a phone screen at zoom 16
  const t = E.demTiles(b, 60, 12);
  assert.ok(t && t.nx * t.ny <= 6, 'a handful of tiles');
  assert.ok(t.bounds.n >= b.n && t.bounds.s <= b.s && t.bounds.w <= b.w && t.bounds.e >= b.e);
  assert.equal(t.cols, t.nx * 256); assert.equal(t.rows, t.ny * 256);
  assert.ok(Math.abs(t.cellM - 3.78) < 0.05, 'cell size ' + t.cellM);
  assert.deepEqual(E.demTiles(b, 60, 12), t);                           // same view, same squares
  assert.equal(E.demTiles({ s: 37.4, n: 37.9, w: -94.2, e: -93.5 }, 60, 12), null);   // zoomed too far out
});test('benches: a strip that tilts a little in the middle still shows as one bench', () => {
  const R = 100, C = 100, d = 4, z = new Float32Array(R * C);
  for (let j = 0; j < C; j++) {
    let h = 400;
    for (let i = 0; i < R; i++) {
      const onBench = i >= 45 && i <= 51, tilted = j >= 42 && j <= 58;
      if (i) h -= d * Math.tan((onBench ? (tilted ? 9 : 2) : 20) * Math.PI / 180);
      z[i * C + j] = h;
    }
  }
  assert.equal(E.findBenches(z, R, C, d).benches.length, 1);
  assert.equal(E.findBenches(z, R, C, d, { grow: 1 }).benches.length, 2);   // without growing it breaks in two
});
// ---- saddles and funnels ----
function ground(rows, cols, f) {
  const z = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) z[i * cols + j] = f(i, j);
  return z;
}
test('saddles: finds the low gap in a ridge, and none on a plain slope or flat', () => {
  const R = 120, C = 120, d = 4;
  // higher to the east and west (the ridge), lower to the north and south (the valleys either side)
  const z = ground(R, C, (i, j) => 300 + 0.004 * Math.pow((j - 60) * d, 2) - 0.004 * Math.pow((i - 60) * d, 2));
  const s = E.findSpots(z, R, C, d).saddles;
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].row - 60) <= 3 && Math.abs(s[0].col - 60) <= 3, 'at the gap: ' + s[0].row + ',' + s[0].col);
  assert.ok(Math.abs(s[0].axisDeg - 90) <= 15, 'ridge runs east-west: ' + s[0].axisDeg);
  assert.ok(s[0].depthM >= 2.5);
  assert.equal(E.findSpots(ground(R, C, (i) => 300 - i * d * 0.2), R, C, d).saddles.length, 0);
  assert.equal(E.findSpots(ground(R, C, (i, j) => 300 + 0.01 * i + 0.01 * j), R, C, d).saddles.length, 0);
});
test('funnels: a gentle strip pinched between steep ground, or between a bluff and water', () => {
  const R = 120, C = 120, d = 4, steep = Math.tan(25 * Math.PI / 180);
  // a 40 m wide bottom running north-south with steep sides, the whole thing tilted so it is not dead level
  const hollow = ground(R, C, (i, j) => 300 + 0.03 * i * d + steep * d * Math.min(30, Math.max(0, Math.abs(j - 59.5) - 5)));
  const f = E.findSpots(hollow, R, C, d).funnels;
  assert.ok(f.length >= 1 && f.length <= 5, 'a few along the bottom, spaced out: ' + f.length);
  assert.ok(f.every((x) => Math.abs(x.col - 59.5) <= 3), 'in the middle of the gap');
  assert.ok(f.every((x) => x.widthM >= 28 && x.widthM <= 52), 'about 40 m wide: ' + f.map((x) => x.widthM).join(','));
  assert.deepEqual(f[0].sides, ['up', 'up']);
  for (let a = 0; a < f.length; a++) for (let b = a + 1; b < f.length; b++) assert.ok(Math.hypot(f[a].row - f[b].row, f[a].col - f[b].col) * d >= 120);
  // dead-level water on the west, a gentle 40 m strip, then a bluff
  const shore = ground(R, C, (i, j) => (j < 40 ? 250 : 250.5 + 0.03 * (j - 40) * d + 0.002 * i + steep * d * Math.min(30, Math.max(0, j - 50))));
  const g = E.findSpots(shore, R, C, d).funnels;
  assert.ok(g.length >= 1, 'found the strip along the water');
  assert.ok(g[0].sides.includes('water') && g[0].sides.includes('up'), g[0].sides.join('/'));
  // open ground and an even steep hillside have nothing to squeeze between
  assert.equal(E.findSpots(ground(R, C, (i, j) => 300 + 0.03 * i + 0.02 * j), R, C, d).funnels.length, 0);
  assert.equal(E.findSpots(ground(R, C, (i) => 300 - i * d * steep), R, C, d).funnels.length, 0);
});
// ---- National Weather Service forecast ----
test('sun times: sunrise and sunset near Stockton match the almanac', () => {
  const s = E.sunTimes('2026-10-13', 37.70, -93.80, -18000);                     // Central Daylight Time
  const clock = (m) => m - E.parseLocalMin('2026-10-13T00:00');
  assert.ok(Math.abs(clock(s.sunrise) - (7 * 60 + 21)) <= 4, 'sunrise about 7:21 AM, got ' + E.fmtClock(s.sunrise));
  assert.ok(Math.abs(clock(s.sunset) - (18 * 60 + 40)) <= 4, 'sunset about 6:40 PM, got ' + E.fmtClock(s.sunset));
  const w = E.sunTimes('2026-12-21', 44.6, -89.9, -21600);                       // midwinter Wisconsin: a short day
  assert.ok(w.sunset - w.sunrise > 8 * 60 && w.sunset - w.sunrise < 9.5 * 60, 'about 9 hours of daylight');
});
test('sunshine estimate: none at night, strong at a clear noon, cut by heavy cloud', () => {
  assert.equal(E.estimateShortwave(-5, 0), 0);
  const clear = E.estimateShortwave(45, 0), overcast = E.estimateShortwave(45, 100);
  assert.ok(clear > 650 && clear < 800, 'clear sky at 45 degrees: ' + clear);
  assert.ok(overcast > 0.2 * clear && overcast < 0.3 * clear, 'overcast keeps about a quarter');
  assert.ok(E.estimateShortwave(10, 0) < E.estimateShortwave(40, 0));
});
test('NWS forecast: time spans become hourly values in mph, degrees F and local time', () => {
  const now = Date.UTC(2026, 9, 13, 19, 30);                                     // 2:30 PM CDT on Oct 13
  const span = (iso, dur, value) => ({ validTime: iso + '/' + dur, value });
  const props = {
    temperature: { uom: 'wmoUnit:degC', values: [span('2026-10-13T15:00:00+00:00', 'PT2H', 20), span('2026-10-13T17:00:00+00:00', 'P1DT6H', 10)] },
    windSpeed: { uom: 'wmoUnit:km_h-1', values: [span('2026-10-13T15:00:00+00:00', 'PT4H', 16.0934), span('2026-10-13T19:00:00+00:00', 'P2D', 8.0467)] },
    windDirection: { uom: 'wmoUnit:degree_(angle)', values: [span('2026-10-13T15:00:00+00:00', 'P3D', 200)] },
    windGust: { uom: 'wmoUnit:km_h-1', values: [span('2026-10-13T15:00:00+00:00', 'P3D', 32.1868)] },
    skyCover: { uom: 'wmoUnit:percent', values: [span('2026-10-13T15:00:00+00:00', 'P3D', 10)] },
    probabilityOfPrecipitation: { uom: 'wmoUnit:percent', values: [span('2026-10-13T15:00:00+00:00', 'PT6H', 5), span('2026-10-13T21:00:00+00:00', 'P3D', 60)] }
  };
  const fc = E.forecastFromNws(props, -18000, 37.70, -93.80, now);
  assert.equal(fc.utcOffsetSec, -18000);
  assert.equal(fc.t.length, 96);
  assert.equal(fc.t[0], E.parseLocalMin('2026-10-13T00:00'));                    // starts at local midnight
  const at = (hh) => fc.t.indexOf(E.parseLocalMin('2026-10-13T' + hh + ':00'));
  assert.ok(Math.abs(fc.speed[at('11')] - 10) < 0.01, '16.09 km/h is 10 mph');   // 16:00 UTC = 11 AM local
  assert.ok(Math.abs(fc.speed[at('15')] - 5) < 0.01, 'the later span takes over');
  assert.ok(Math.abs(fc.speed[at('03')] - 10) < 0.01, 'hours before the forecast starts take its first value');
  assert.ok(Math.abs(fc.temp[at('10')] - 68) < 0.01, '20 C is 68 F');
  assert.ok(Math.abs(fc.temp[at('13')] - 50) < 0.01);
  assert.equal(fc.dir[at('12')], 200);
  assert.ok(Math.abs(fc.gust[at('12')] - 20) < 0.01);
  assert.equal(fc.precip[at('12')], 5); assert.equal(fc.precip[at('17')], 60);
  assert.ok(fc.sw[at('13')] > 400, 'sun at midday: ' + fc.sw[at('13')]);
  assert.equal(fc.sw[at('02')], 0);
  assert.equal(fc.daily.length, 4);
  assert.equal(fc.daily[0].date, '2026-10-13');
  assert.ok(fc.daily[0].sunrise < fc.daily[0].sunset && fc.daily[1].sunrise > fc.daily[0].sunset);
  // the rest of the engine runs on it unchanged
  const stand = { lat: 37.70, lng: -93.80, winds: { S: 'good', SW: 'good' }, terrain: { slopeDeg: 8, aspectDeg: 90 } };
  const sits = E.listSits(fc, E.nowMinFor(fc, now), 6);
  assert.ok(sits.length >= 4 && sits[0].label === 'Tonight', 'first sit is tonight: ' + sits.map((s) => s.label).join(', '));
  const ev = E.evaluateSit(stand, fc, E.windowForStand(fc, sits[0], E.nowMinFor(fc, now)), E.nowMinFor(fc, now));
  assert.ok(ev.score > 0 && ev.score <= 100 && ev.reasons.length > 0);
  assert.throws(() => E.forecastFromNws({ windSpeed: { values: [] } }, -18000, 37.7, -93.8, now), /no wind/);
});
test('sit log: matches, misses and the track record', () => {
  const pred = (from, extra) => Object.assign({ from, raw: from, speed: 7, swirl: 0 }, extra);
  assert.equal(E.checkSit({ obs: 'NW', pred: pred(300) }).hit, true);
  assert.equal(E.checkSit({ obs: 'W', pred: pred(300) }).hit, true);     // 30° off: within a compass point
  assert.equal(E.checkSit({ obs: 'N', pred: pred(300) }).hit, false);    // 60° off
  assert.equal(E.checkSit({ obs: 'S', pred: pred(10) }).hit, false);
  near(E.checkSit({ obs: 'N', pred: pred(340) }).off, 20, 0.001);        // real air sat 20° clockwise of the call
  near(E.checkSit({ obs: 'NW', pred: pred(10) }).off, -55, 0.001);
  assert.equal(E.checkSit({ obs: 'calm', pred: pred(0, { speed: 2 }) }).hit, true);
  assert.equal(E.checkSit({ obs: 'calm', pred: pred(0, { speed: 9 }) }).hit, false);
  assert.equal(E.checkSit({ obs: 'swirl', pred: pred(0, { swirl: 0.5 }) }).hit, true);
  assert.equal(E.checkSit({ obs: 'swirl', pred: pred(0) }).hit, false);
  assert.equal(E.checkSit({ obs: 'NW' }), null);                         // no prediction saved: cannot judge
  assert.equal(E.checkSit({ pred: pred(0) }), null);                     // wind not checked
  assert.equal(E.checkSit({ date: '2026-10-01', deer: 2 }), null);       // old style sit

  const r = E.sitRecord([
    { kind: 'PM', obs: 'NW', pred: pred(310), outcome: 'range' },
    { kind: 'PM', obs: 'S', pred: pred(310), outcome: 'busted' },
    { kind: 'AM', obs: 'calm', pred: pred(0, { speed: 1 }), outcome: 'none' },
    { kind: 'AM', outcome: 'seen' },
    { date: '2026-09-30', deer: 1 }
  ]);
  assert.equal(r.sits, 5); assert.equal(r.checks, 3); assert.equal(r.hits, 2);
  assert.deepEqual(r.PM, { checks: 2, hits: 1 }); assert.deepEqual(r.AM, { checks: 1, hits: 1 });
  assert.equal(r.busted, 1); assert.equal(r.inRange, 1);
});

test('sit log: a steady turn at one stand is learned and applied to its wind', () => {
  const sit = (obs, raw) => ({ kind: 'PM', obs, pred: { from: raw, raw, speed: 7, swirl: 0 } });
  // two checks are not enough
  assert.equal(E.windFixFrom([sit('W', 225), sit('W', 225)]), null);
  // forecast says SW, the stand keeps reading W: about +45°, shrunk while there are few checks
  const four = E.windFixFrom([sit('W', 225), sit('W', 230), sit('W', 220), sit('W', 225)]);
  assert.equal(four.n, 4);
  near(four.deg, 30, 1);
  // checks that disagree with each other teach nothing
  assert.equal(E.windFixFrom([sit('N', 0), sit('E', 0), sit('S', 0), sit('W', 0)]), null);
  // checks that already match teach nothing
  assert.equal(E.windFixFrom([sit('S', 180), sit('S', 182), sit('S', 178)]), null);
  // calm and swirl reads have no direction
  assert.equal(E.windFixFrom([sit('calm', 0), sit('swirl', 0), sit('W', 225), sit('W', 225)]), null);

  const fc = makeForecast({ speed: 10, dir: 225 });
  const t = L('2026-10-09T12:00');
  const flat = { lat: LAT, lng: LNG, terrain: { slopeDeg: 0, aspectDeg: null }, winds: { W: 'good', SW: 'bad' } };
  const base = E.stateAt(flat, fc, t);
  const fixed = E.stateAt(Object.assign({}, flat, { windFix: { deg: 30, n: 4 } }), fc, t);
  const off = E.stateAt(Object.assign({}, flat, { windFix: { deg: 30, n: 4, off: true } }), fc, t);
  near(E.angDiff(fixed.eff.from, base.eff.from), 30, 0.5);
  near(off.eff.from, base.eff.from, 0.001);
  assert.ok(fixed.rating > base.rating);
});
test('route check: scent off the walk in finds sign downwind, not upwind, with walking times', () => {
  const fc = makeForecast({ speed: 8, dir: 0 });               // wind from the north: scent goes south
  const stand = [LAT, LNG], truck = E.offsetLatLng(LAT, LNG, 270, 400);
  const line = [truck, stand];
  const r = E.resampleLine(line, 20);
  near(r.lengthM, 400, 1);
  assert.equal(r.pts[0].d, 0); near(r.pts[r.pts.length - 1].d, 400, 1);
  assert.ok(r.pts.length >= 20 && r.pts.length <= 22);
  const mid = E.offsetLatLng(LAT, LNG, 270, 200);
  const south = E.offsetLatLng(mid[0], mid[1], 180, 80), north = E.offsetLatLng(mid[0], mid[1], 0, 80);
  const marks = [
    { id: 'a', type: 'bed', lat: south[0], lng: south[1] },
    { id: 'b', type: 'bed', lat: north[0], lng: north[1] },
    { id: 'c', type: 'parking', lat: south[0], lng: south[1] }      // not deer sign: ignored
  ];
  const t0 = L('2026-10-09T16:00');
  const res = E.routeScent(r.pts, fc, { dir: 'in', t0, marks });
  assert.deepEqual(res.hits.map((h) => h.mark.id), ['a']);
  near(res.hits[0].dM, 80, 12);
  near(res.minutes, 400 / 0.9 / 60, 0.01);
  near(res.end, t0, 0.001); near(res.start, t0 - res.minutes, 0.001);
  assert.ok(res.hits[0].t > res.start && res.hits[0].t < t0);
  // walking out, the same line runs backwards in time from the stand
  const back = E.routeScent(r.pts, fc, { dir: 'out', t0, marks });
  near(back.start, t0, 0.001); near(back.end, t0 + back.minutes, 0.001);
  assert.equal(back.samples[0].t > back.samples[back.samples.length - 1].t, true);
  // turn the wind round and the other bed gets it
  const fc2 = makeForecast({ speed: 8, dir: 180 });
  assert.deepEqual(E.routeScent(r.pts, fc2, { dir: 'in', t0, marks }).hits.map((h) => h.mark.id), ['b']);
});

test('route check: the cone narrows in wind and pools in calm air', () => {
  const to = 180, here = [LAT, LNG];
  const p = (b, m) => E.offsetLatLng(LAT, LNG, b, m);
  assert.ok(E.inScent(here[0], here[1], to, 8, ...p(180, 100)) > 0);
  assert.equal(E.inScent(here[0], here[1], to, 8, ...p(240, 100)), -1);   // 60 deg off the cone line
  assert.equal(E.inScent(here[0], here[1], to, 8, ...p(180, 400)), -1);   // past the reach at 8 mph
  assert.ok(E.inScent(here[0], here[1], to, 1, ...p(0, 40)) > 0);          // calm: upwind too, close in
  assert.equal(E.inScent(here[0], here[1], to, 1, ...p(180, 90)), -1);
});
test('stand sites: between bedding and food beats a lone feature, and the good winds keep scent off both', () => {
  const at = (b, m) => { const p = E.offsetLatLng(LAT, LNG, b, m); return { lat: p[0], lng: p[1] }; };
  const marks = [
    Object.assign({ id: 'b', type: 'bed' }, at(0, 250)),         // bedding north
    Object.assign({ id: 'f', type: 'plot' }, at(180, 300)),      // food plot south
    Object.assign({ id: 's1', type: 'scrape' }, at(90, 40)),
    Object.assign({ id: 's2', type: 'rub' }, at(270, 50)),
    Object.assign({ id: 'x', type: 'crossing', name: 'creek' }, at(90, 1500))
  ];
  const cands = [
    Object.assign({ kind: 'saddle' }, at(0, 0)),                 // between bed and food, with sign
    Object.assign({ kind: 'bench' }, at(270, 900)),              // off on its own
    Object.assign({ kind: 'funnel', widthM: 25 }, at(0, 230))    // right on the bedding
  ];
  const r = E.standSites(cands, marks, { windFrom: 90 });
  assert.equal(r[0].kind, 'saddle');
  assert.ok(r[0].why.some((w) => /Between your bedding/.test(w)));
  assert.ok(r[0].why.some((w) => /2 sign marks/.test(w)));
  // bedding N and food S: only east or west winds blow scent away from both
  assert.deepEqual(r[0].goodWinds, ['E', 'W']);
  assert.equal(r[0].windOk, true);
  const fun = r.find((s) => s.kind === 'funnel');
  assert.ok(fun.why.some((w) => /easy to bump/.test(w)));
  assert.ok(fun.score < r[0].score);
  assert.ok(r.some((s) => s.kind === 'crossing'));
  // a stand already on the spot removes it; a bad wind costs points
  assert.equal(E.standSites(cands, marks, { stands: [at(0, 10)] }).some((s) => s.kind === 'saddle'), false);
  const south = E.standSites(cands, marks, { windFrom: 180 })[0];
  assert.equal(south.windOk, false);
  assert.ok(south.score < r[0].score);
});