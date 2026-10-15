# StandCast

A bowhunting app that answers "which stand tonight?" It models wind, thermals, swirl zones and scent cones over the hunter's own map of stands and sign. The owner is not a programmer, so explain changes in plain words and give exact steps for anything the owner has to do. Private notes for this project are in `CLAUDE.local.md`, which is not published.

## How it ships

- This is a static PWA (plain HTML, CSS and JavaScript). There is no build step, no framework and no bundler.
- It's hosted on GitHub Pages at **https://burker32.github.io/standcast/**, served from the `main` branch (root folder) of the public repo `Burker32/standcast`.
- To deploy a change:
  1. Edit the files.
  2. Bump `VERSION` in `sw.js`.
  3. Run `npm test`, and `node --check` on each edited JS file.
  4. Commit and push to `main`. GitHub Pages rebuilds the site by itself, usually within a minute or two.
- **Every deploy must bump `VERSION` in `sw.js`** (currently `'v46'`). The service worker serves cache-first, so phones keep the old app until the version changes. After a deploy, the owner closes and reopens the app once.
- The app is served from the `/standcast/` subfolder, so every path in `index.html`, `manifest.webmanifest` and `sw.js` must stay relative (no leading `/`).
- The repo is public. `CLAUDE.local.md` and zip files are kept out by `.gitignore`. Check `git status` before committing so nothing private goes up.
- The empty `.nojekyll` file tells GitHub Pages to serve the files as they are.

## Files

Scripts load in this order in `index.html`: engine, exif, marktypes, store, pins, weather, map, flow, publand, roads, parcels, labels, search, app. Each file attaches to `window.SC`.

- **`js/engine.js`:** pure math with no DOM or network, so it's unit-testable.
  - Wind vectors and scent cones.
  - `thermal()`: potential, heat index and when thermals switch direction.
  - `swirl()`: fight between thermals and wind, and lee eddies. `CANOPY = 0.3` is the wind under the trees as a share of forecast wind.
  - `flowGrid`/`flowCells`: grid spacing 45 m at zoom 17 or more, up to 300 m when zoomed out.
  - `findBenches()`: flat strips part-way up a hillside, from a grid of lidar ground heights. A cell counts when it is flat (`BENCH.flatMax`) and there is clearly steeper ground, with real climb and drop, both up and down the fall line. Thresholds are in `BENCH`, set for the gentle hills around Stockton Lake. `demTiles()` picks fixed elevation squares for the view (tile zoom 16, about 2 m cells, or 17 when zoomed right in; zoom 15 was too coarse to see a 20 ft wide bench or road bed); `weather.js` `demMosaic()` fetches them (raw 32-bit floats, `format=bsq`), `map.js` `renderBenches()` paints them, and `sw.js` keeps them in the `sc-dem-v1` cache.
  - `swirlSpots()`:
    - Pass 1 computes the air vector on each grid cell.
    - Pass 2 computes how much the air turns (vorticity) and how much flows collide (convergence).
    - Pass 3 picks peaks, giving ring radius `rM = spacing*(0.22+0.12*score)`.
  - `findSpots()`: saddles (walk a circle round a spot and the ground goes up, down, up, down) and funnels (walkable ground 18 to 55 m wide pinched between steep slopes or dead-level lidar water). Returns only the strongest few, spaced apart; thresholds in `SPOTS`. Uses zoom-15 elevation squares. `map.js` `renderSpots()` draws them as small badges and `app.js` `showSpot()` explains a tapped one.
  - `distanceM`/`fmtYards`: distances for the measure tool.
  - Walk in and out: `resampleLine()` spaces a route every 20 m (at most 150 points), and `routeScent()` walks it at `ROUTE.walkMps` (0.9 m/s), arriving at `t0` for `dir: 'in'` or leaving at `t0` for `'out'`. At each point it calls `stateAt()` with that point's own lidar slope, then `inScent()` (the same cone as `coneRing`) checks the marks of the `ROUTE.sign` types. The last 25 m are left to the stand's own ranking.
  - `standSites()`: scores saddles, funnels, benches and marked crossings, using bedding/food between, sign within 90 m, a penalty for sitting on bedding, and good winds (ones that blow scent at least 90° off both bedding and food); thresholds are in `SITES`. `siteDay()` runs each site through `evaluateSit` on its own slope for a hunt window (good winds from `goodWinds`, bad from `badWinds`), adds temperature effects (`DAY`: north slopes and water when hot, south slopes when cold) and averages that with the site score.
  - Sit log scoring: `checkSit()` judges one logged sit (the hunter's wind check `obs`, a compass point or `calm`/`swirl`, against the saved call `pred`; a match is within 45°). `sitRecord()` is a stand's track record. `windFixFrom()` learns a stand's steady turn from the last 12 compass checks (at least 3 that agree, shrunk while few, at most 45°, `FIX`). It is saved as `stand.windFix = {deg, n, off}` and `stateAt()` adds it to the effective wind.
- **`js/weather.js`:**
  - Forecast from the U.S. National Weather Service (`api.weather.gov`): `/points/lat,lng` gives the grid square (remembered in `standcast.nwspoint.v1`), then the gridpoint data, turned into the engine's hourly object by `engine.forecastFromNws()`. NWS has no sunshine or sun times, so `estimateShortwave()` and `sunTimes()` work them out. U.S. only. Retry and `forecastBusy` gating as before. Open-Meteo was dropped in v40 because its free service is non-commercial only.
  - Ground elevation comes from USGS 3DEP 1 m lidar through an ImageServer `getSamples` POST. There is no fallback source. Cache key is `standcast.elev.v2`.
- **Tile speed notes (measured Oct 2026):** the Missouri leaf-off ImageServer answers a 256 or 320 px export in about 0.1 s but takes about 1 s for 512 px, so `exportUrl()` asks for 320 on high-density screens. USGS summer tiles take 0.3 to 0.7 s each and cannot be sped up from our side. Base layers use `updateWhenIdle: false` and `keepBuffer: 3`. In `sw.js`, `trimTiles()` only lists the tile cache once every 60 saves.
- **`js/map.js`:** Leaflet 1.9.4 plus leaflet-rotate 0.2.8, shipped in `vendor/` so the map works with no signal (CDN copies are only a fallback). Any new file in `vendor/` must be added to `FILES` in `sw.js`.
  - Basemaps:
    - USGS Imagery (Summer, NAIP leaf-on).
    - Leaf-off, picked per tile by state (`LEAF` in `map.js`): MSDIS Missouri 6-inch 2023–24 (ImageServer `exportImage`), and Wisconsin DNR / WROC latest leaf-off 2018–24 (the cached `..._Raster_Tile` MapServer `export`, which answers in about 0.2 s; the plain ImageServer takes 10 s or more). Tiles outside both states fall back to the USGS summer photo. Add a state by adding a row to `LEAF` and its host to the tile cache list in `sw.js`.
    - USGS Imagery Topo (Hybrid) and USGS Topo.
  - Overlays (`OVER`): 3DEP hillshade, 3DEP 10 ft contours (CSS class `ov-contours` adds a white halo so they show on any imagery), and CropScape 2025 (WMS, EPSG:4326).
  - Also in this file:
    - Map rotation and the compass: heading H is `setBearing(-H)`.
    - Follow mode, which keeps the user centered so rotation pivots on them.
    - The upright GPS dot with a heading cone.
    - The measure layer.
  - On `zoomstart`, it adds `is-zooming` to the map container. Nothing is hidden on that class any more (see "Zoom animation" below).
- **`js/flow.js`:** the animated canvas, in its own pane.
  - Draws wind streaks, thermal beads (rising or sinking) with a glow, swirl rings and scent puffs.
  - Positions come from `latLngToContainerPoint`, so it works when the map is rotated.
  - It hides and resets on move, zoom and rotate.
- **`js/publand.js`:** public land boundaries from the PAD-US 4.1 FeatureServer (Esri), fetched in 0.1° cells at zoom 11 or more.
  - Drawn as outlines only (a dark halo under a colored line), with an invisible fill so the area can be tapped.
  - Colors by manager type. Names like "Conservation Area" count as state land.
- **`js/parcels.js`:** private property lines with owner names, Wisconsin only: the Wisconsin Statewide Parcel Map V12 FeatureServer on services3.arcgis.com (fields `OWNERNME1`, `GISACRES`, `PARCELID`...). Zoom 14 and up, 0.02 degree cells, one merged `noClip` polygon outline, `pick()` is a point-in-polygon test called after roads in the map tap handler. `SOURCES` holds one row per state; Missouri has no statewide public parcel layer (counties use vendor viewers such as Integrity GIS), so adding it needs a county's permission or a licensed provider. Showing owner names commercially is legal question 7 in the launch brief.
- **`js/labels.js`:** town and public land names written on every basemap, on by default (`overlays.names !== false`). Level of detail by zoom: state names far out, then towns by 2020 census population from TIGERweb (`minPop()`: 250k at zoom 6 down to everything at zoom 12), then GNIS small communities at zoom 12 or more; public land from zoom 9, biggest first. Town and state names are skipped on the topo and hybrid maps, which print their own. Public land names from PAD-US, placed on the visible part of the unit. Overlapping names are dropped; at most 26 show. The bigger town wins a collision. The raster `labels` overlay in `map.js` is now road names and route shields only.
- **`js/roads.js`:** roads and trails as vector lines over any basemap, from the USGS transportation MapServer. Three levels by zoom: below 11, main highways from the small-scale layers (8 below zoom 8.5, then 9 filtered to numbered routes); 11 to 13, layers 29, 30, 31 in 0.2 degree cells (`MID`); 13 and up, layers 29 to 33 plus 35, 36 (4WD and closed, dashed) and 37 (trails, dotted) in 0.05 degree cells (`FULL`). All lines of one kind are merged into a single `noClip` polyline; thousands of separate lines made panning jerky. The previous level stays on screen until the new one has loaded. `pages()` follows `exceededTransferLimit`. `shields()` writes route numbers about every 5 miles and at least 92 px apart. `pick()` matches a tap to a road, called from the map tap handler in `app.js`. Not cached offline.
- **Creeks and rivers:** the `hydro` overlay in `map.js` is the USGS `USGSHydroCached` tile set (NHD drawn as blue lines, dashed for intermittent). The NHD and 3DHP vector services on hydro.nationalmap.gov timed out at 30 s or more when tried in Oct 2026, so they are not used.
- **Zoom animation:** vector overlays are not hidden while zooming. leaflet-rotate re-runs `Renderer._update` on every `rotate` event, and a real pinch twists while it zooms, which left SVG and canvas overlays 30 to 65 px off until the gesture ended. `steadyLinesWhileZooming()` in `map.js` patches `L.Renderer.getEvents` to skip that update while the map zoom differs from the renderer's. Measured after: about 1 px for animated zoom, pinch, rotated zoom and pinch with twist. When testing this, simulate the twist (`setBearing` between `_move` calls); a zoom-only test passes even without the patch.
- **`js/search.js`:** also finds roads by name within about 25 miles (slow, so results arrive after the places and are merged in through the `more` callback) and street addresses through the Census geocoder, which has no CORS and is loaded by JSONP. Place search, nationwide. Towns, landforms, streams and lakes come from the USGS Geographic Names (GNIS) map service; public land comes from PAD-US by name. Looks within a few hours' drive of the map first, then everywhere; a trailing state ("Stockton WI") limits it; typed coordinates go straight there. The `labels` overlay in `map.js` draws USGS road and place-name tiles over the photo basemaps.
- **`js/marktypes.js`:** marker types (scrape, rub, bed, trail, sighting, shed, food, plot, water, crossing, camera, feeder, blind, gate, parking, other), each with a color and an SVG path. `ORDER` controls the picker.
- **`js/store.js`:** localStorage for stands, marks, hunts and layer toggles. Data stays on the device: sharing the link does not share data. There's backup/restore for manual sharing.
- **`js/exif.js`:** reads GPS from photo EXIF for placing marks.
- **`js/app.js`:** the UI.
  - Bottom sheet with drag and flick. A plain tap on the map with a stand or mark open closes it (`closeOpen()`, after `tapCancels()` in the tap handlers).
  - Stand ranking.
  - Routes: `stand.routes = { in, out }` (arrays of [lat, lng] from the truck to the stand; `out` null means the same way out). They are drawn with the measure tool (`ui.measure.route`, Save route), the slope along each is cached in `routeTerrain`, and `routeCheck()` uses the hunt window picked on the Stands tab. `map.js` `routeLayers()` draws the line with scent ticks every ~60 m (red where they reach sign). Bow range rings (`layers.rings`) are drawn in the same layer group and hidden by `.zoom-low`.
  - Best stand spots (top of the + menu and the Stands tab): `findSites()` loads zoom-15 lidar for the view (zoom 15 and up) and its own NWS forecast for the map center (`W.loadFor` with id `view`, so it works with no stands), runs `findSpots` and `findBenches`, then `standSites` (max 15), gives each spot its slope with `demTerrainAt`, and `scoreSites()` ranks the top 5 with `siteDay` for the hunt picked in the view's own chips; `siteView()` lists them, `M.renderSites()` numbers them on the map, and "Put a stand here" reuses `placePending('stand')`.
  - Pins: `js/pins.js` (loads after store) reads GPX, KML and KMZ (KMZ is unzipped with `DecompressionStream`) and takes the kind from the onX icon (`<onx:icon>`, `ICONS`), else guesses it from words in the name or note (`WORDS`). onX stamps every pin with the export time, so a time shared by all pins is dropped, and names like "Waypoint 10/22/25 05:35" become a blank name with that date (`dateName`). `toGpx()` writes stands, marks and routes, with `<type>standcast:kind</type>` so a round trip keeps kinds. `importView()` lets the user fix kinds before adding, and pins already present (same name within 5 yd) are skipped.
  - Camera photos: `mark.shots = [{ id, at, added }]`, dated by `exif.readDate()` (DateTimeOriginal, else DateTime, else the file date). `cameraBlock()` shows the gallery and the dawn/day/dusk/night counts. The viewer takes any item list (`openViewer(i, list)`). Backups carry shots as `x.data`.
  - Sit log and wind checks: `snapPreds()` saves each stand's call for today's sits in `standcast.preds.v1` (it stops updating 30 minutes into the sit, and entries are kept 10 days). Logging a sit copies that call into the sit as `pred` (or works it out from the forecast if that still covers the day), with `kind` (AM/PM), `obs` and `outcome` (range, seen, busted, none). `saveSits()` updates `windFix`. The track record shows on the stand and on its ranking card.
  - `drawField` renders arrows, cones and swirls.
  - Compass, locate and follow button, measure mode (yards).
  - Overlay switches (`OV_DEFAULT`), and the base button that cycles Summer, Leaf-off and Topo.
- **`css/app.css`:** all styles. Colors are CSS variables such as `--map-swirl`.
- **`sw.js`:** the service worker.
  - App shell is cache-first.
  - Map and elevation tiles are cached for offline use.
  - PAD-US is network-first with a cache fallback.

## Testing

- `node --test tests/*.test.js` (or `npm test`) runs the engine, EXIF and pins unit tests. They must pass before packaging.
- Run `node --check js/<file>.js` on any edited JS file.
- For a local preview, run `npm run serve` (`scripts/serve.js`, plain Node with nothing to install) and open http://localhost:8080. It only listens on this computer. The service worker does not register in the preview pane, so offline behaviour has to be checked on the live site. Some things only behave right on a phone outdoors: GPS, compass heading, and DeviceOrientation (which needs a permission prompt on iOS).
- Watch out for tests that depend on the time of day. Thermals depend on sun angle, so fix the forecast and date in tests.

## Data sources

All are free and need no API key: USGS National Map basemaps, MSDIS (Missouri), USGS 3DEP elevation, the National Weather Service, the Census Bureau (town populations, address search), Wisconsin DNR imagery, PAD-US via Esri, and USDA NASS CropScape. Keep credits for these in the app's credits and guide text.

## Conventions

- Keep it vanilla JS that works on older phones. Use no build tools unless the owner agrees.
- Distances are shown in yards (miles past 1760 yd). Wind is in mph.
- Be honest in the UI that wind, thermals and swirls are modeled estimates, and that PAD-US lines are not legal surveys.
- Feedback comes from field use on a phone, so check changes at phone width and with the map rotated.
- Never put API keys or other secrets in this repo: it is public.

## Licences

- **leaflet-rotate 0.2.8 is GPL-3.0** (confirmed from the npm registry and the repo's LICENSE, Oct 2026). Shipping it inside a closed-source paid app is a problem. **Decided 13 Oct 2026:** leave it in place for now and move the map to MapLibre GL JS (BSD, rotation built in) as part of the store build, not before. Build that in a separate branch with its own test address; the live app and its address stay as they are until the owner approves the switch, so saved data carries over. Do not start the rebuild early, and do not add other GPL code.
- Leaflet is BSD-2-Clause. Government data sources are public domain. Open-Meteo is no longer used.
