/* StandCast service worker: opens the app with no signal.
 *  - App files: cached on install, served cache-first, refreshed in the background.
 *  - Map tiles: cache-first, filled as you browse or by "Save this map area for offline".
 *  - Map library (Leaflet, leaflet-rotate): shipped with the app in vendor/, cached on install.
 *  - Fonts from CDNs: cached the first time they load.
 *  - Forecast and elevation calls are never cached here (the app keeps its own copy). */
const VERSION = 'v43';
const SHELL = 'sc-shell-' + VERSION;
const TILES = 'sc-tiles-v1';
const LIBS = 'sc-libs-' + VERSION;
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/engine.js', 'js/exif.js', 'js/marktypes.js', 'js/store.js', 'js/pins.js', 'js/weather.js', 'js/map.js', 'js/flow.js', 'js/publand.js', 'js/roads.js', 'js/parcels.js', 'js/labels.js', 'js/search.js', 'js/app.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet-rotate/leaflet-rotate-src.js',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png'
];
const MAX_TILES = 4000;
const DEM = 'sc-dem-v1', MAX_DEM = 150;   // about 260 KB each

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => (k.startsWith('sc-shell-') && k !== SHELL) || (k.startsWith('sc-libs-') && k !== LIBS)).map((k) => caches.delete(k))
  )).then(() => self.clients.claim()));
});

// Listing every saved tile is slow, so the store is only checked for size once every 60 new tiles.
let sinceTrim = 0;
async function trimTiles() {
  if (++sinceTrim < 60) return;
  sinceTrim = 0;
  const c = await caches.open(TILES), keys = await c.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => c.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Ground heights for the bench layer: fixed squares, so keep them (a small separate store, oldest dropped first).
  if (url.hostname === 'elevation.nationalmap.gov' && url.search.indexOf('format=bsq') > 0) {
    e.respondWith(caches.open(DEM).then(async (c) => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) c.put(req.url, res.clone()).then(async () => { const keys = await c.keys(); if (keys.length > MAX_DEM) await Promise.all(keys.slice(0, keys.length - MAX_DEM).map((k) => c.delete(k))); });
        return res;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  if (url.hostname === 'basemap.nationalmap.gov' || url.hostname === 'stateimagery.msdis.missouri.edu' || url.hostname === 'dnrmaps.wi.gov' ||
      (url.hostname === 'elevation.nationalmap.gov' && url.pathname.indexOf('exportImage') > 0) ||
      (url.hostname === 'carto.nationalmap.gov' && url.pathname.indexOf('/export') > 0)) {   // road and place-name tiles; searches are not kept
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type !== 'opaque') { c.put(req.url, res.clone()).then(trimTiles); }
        return res;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  if (url.hostname === 'api.weather.gov') return; // forecast: handled by the app, which keeps its own copy
  if (url.hostname === 'nassgeodata.gmu.edu') {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req.url, res.clone()); return res; }
      catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  // Public land boundaries: use the network, fall back to the last copy when there is no signal.
  if (url.hostname === 'services.arcgis.com') {
    e.respondWith(caches.open(LIBS).then(function (c) {
      return fetch(req).then(function (res) { if (res && res.ok) c.put(req, res.clone()); return res; })
        .catch(function () { return c.match(req).then(function (hit) { return hit || new Response('', { status: 504 }); }); });
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) { net.catch(() => {}); return hit; }
      const res = await net;
      return res || (req.mode === 'navigate' ? c.match('index.html') : new Response('', { status: 504 }));
    }));
    return;
  }

  if (['unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
    e.respondWith(caches.open(LIBS).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('', { status: 504 });
    }));
  }
});
