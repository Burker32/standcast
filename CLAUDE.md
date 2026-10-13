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
- **Every deploy must bump `VERSION` in `sw.js`** (currently `'v28'`). The service worker serves cache-first, so phones keep the old app until the version changes. After a deploy, the owner closes and reopens the app once.
- The app is served from the `/standcast/` subfolder, so every path in `index.html`, `manifest.webmanifest` and `sw.js` must stay relative (no leading `/`).
- The repo is public. `CLAUDE.local.md` and zip files are kept out by `.gitignore`. Check `git status` before committing so nothing private goes up.
- The empty `.nojekyll` file tells GitHub Pages to serve the files as they are.

## Files

Scripts load in this order in `index.html`: engine, exif, marktypes, store, weather, map, flow, publand, app. Each file attaches to `window.SC`.

- **`js/engine.js`:** pure math with no DOM or network, so it's unit-testable.
  - Wind vectors and scent cones.
  - `thermal()`: potential, heat index and when thermals switch direction.
  - `swirl()`: fight between thermals and wind, and lee eddies. `CANOPY = 0.3` is the wind under the trees as a share of forecast wind.
  - `flowGrid`/`flowCells`: grid spacing 45 m at zoom 17 or more, up to 300 m when zoomed out.
  - `findBenches()`: flat strips part-way up a hillside, from a grid of lidar ground heights. A cell counts when it is flat (`BENCH.flatMax`) and there is clearly steeper ground, with real climb and drop, both up and down the fall line. Thresholds are in `BENCH`, set for the gentle hills around Stockton Lake. `demTiles()` picks the fixed zoom-15 elevation squares for the view; `weather.js` `demMosaic()` fetches them (raw 32-bit floats, `format=bsq`), `map.js` `renderBenches()` paints them, and `sw.js` keeps them in the `sc-dem-v1` cache.
  - `swirlSpots()`:
    - Pass 1 computes the air vector on each grid cell.
    - Pass 2 computes how much the air turns (vorticity) and how much flows collide (convergence).
    - Pass 3 picks peaks, giving ring radius `rM = spacing*(0.22+0.12*score)`.
  - `distanceM`/`fmtYards`: distances for the measure tool.
- **`js/weather.js`:**
  - Open-Meteo forecast, with retry and `forecastBusy` gating.
  - Ground elevation comes from USGS 3DEP 1 m lidar through an ImageServer `getSamples` POST. It falls back to Open-Meteo elevation. Cache key is `standcast.elev.v2`.
- **`js/map.js`:** Leaflet 1.9.4 plus leaflet-rotate 0.2.8, shipped in `vendor/` so the map works with no signal (CDN copies are only a fallback). Any new file in `vendor/` must be added to `FILES` in `sw.js`.
  - Basemaps:
    - USGS Imagery (Summer, NAIP leaf-on).
    - MSDIS Missouri 6-inch leaf-off 2023–24, from an ImageServer `exportImage` call with Web Mercator bbox math per tile.
    - USGS Imagery Topo (Hybrid) and USGS Topo.
  - Overlays (`OVER`): 3DEP hillshade, 3DEP 10 ft contours (CSS class `ov-contours` adds a white halo so they show on any imagery), and CropScape 2025 (WMS, EPSG:4326).
  - Also in this file:
    - Map rotation and the compass: heading H is `setBearing(-H)`.
    - Follow mode, which keeps the user centered so rotation pivots on them.
    - The upright GPS dot with a heading cone.
    - The measure layer.
  - On `zoomstart`, it adds `is-zooming` to the map container and CSS hides `.leaflet-overlay-pane`. This stops vector overlays from sliding during zoom animation.
- **`js/flow.js`:** the animated canvas, in its own pane.
  - Draws wind streaks, thermal beads (rising or sinking) with a glow, swirl rings and scent puffs.
  - Positions come from `latLngToContainerPoint`, so it works when the map is rotated.
  - It hides and resets on move, zoom and rotate.
- **`js/publand.js`:** public land boundaries from the PAD-US 4.1 FeatureServer (Esri), fetched in 0.1° cells at zoom 11 or more.
  - Drawn as outlines only (a dark halo under a colored line), with an invisible fill so the area can be tapped.
  - Colors by manager type. Names like "Conservation Area" count as state land.
- **`js/marktypes.js`:** marker types (scrape, rub, bed, trail, sighting, shed, food, plot, water, crossing, camera, feeder, blind, gate, parking, other), each with a color and an SVG path. `ORDER` controls the picker.
- **`js/store.js`:** localStorage for stands, marks, hunts and layer toggles. Data stays on the device: sharing the link does not share data. There's backup/restore for manual sharing.
- **`js/exif.js`:** reads GPS from photo EXIF for placing marks.
- **`js/app.js`:** the UI.
  - Bottom sheet with drag and flick.
  - Stand ranking.
  - `drawField` renders arrows, cones and swirls.
  - Compass, locate and follow button, measure mode (yards).
  - Overlay switches (`OV_DEFAULT`), and the base button that cycles Summer, Leaf-off and Topo.
- **`css/app.css`:** all styles. Colors are CSS variables such as `--map-swirl`.
- **`sw.js`:** the service worker.
  - App shell is cache-first.
  - Map and elevation tiles are cached for offline use.
  - PAD-US is network-first with a cache fallback.

## Testing

- `node --test tests/*.test.js` (or `npm test`) runs the engine and EXIF unit tests. They must pass before packaging.
- Run `node --check js/<file>.js` on any edited JS file.
- For a local preview, run `python3 -m http.server 8080` (or `npx serve`) and open http://localhost:8080. Some things only behave right on a phone outdoors: GPS, compass heading, and DeviceOrientation (which needs a permission prompt on iOS).
- Watch out for tests that depend on the time of day. Thermals depend on sun angle, so fix the forecast and date in tests.

## Data sources

All are free and need no API key: USGS National Map basemaps, MSDIS (Missouri), USGS 3DEP elevation, Open-Meteo, PAD-US via Esri, and USDA NASS CropScape. Keep credits for these in the app's credits and guide text.

## Conventions

- Keep it vanilla JS that works on older phones. Use no build tools unless the owner agrees.
- Distances are shown in yards (miles past 1760 yd). Wind is in mph.
- Be honest in the UI that wind, thermals and swirls are modeled estimates, and that PAD-US lines are not legal surveys.
- Feedback comes from field use on a phone, so check changes at phone width and with the map rotated.
- Never put API keys or other secrets in this repo: it is public.
