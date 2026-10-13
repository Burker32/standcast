# StandCast

Pick the right stand for tonight's wind. A phone-friendly web app (installable, works offline) for bowhunters.

## What it does
- Map of your stands (USGS satellite or topo) with a time slider for the next 48 hours.
- For each stand: forecast wind, estimated slope thermals, and a scent cone showing where your scent goes.
- Ranks your stands for the next sits (this morning, tonight, tomorrow AM...) against the winds you mark good and bad for each one.
- Marks for scrapes, rubs, bedding, food, trails and cameras, each with a note and a photo. A photo with GPS places its own pin.
- Sit log (rests a stand you just hunted), backup and restore, offline map tiles.

## Run it
Double-click `index.html` to try it on a computer, or serve the folder:

    npm run serve        # then open http://localhost:8080

The live app is at https://burker32.github.io/standcast/ (GitHub Pages, served from the `main` branch).
Pushing to `main` updates the site. Bump `VERSION` in `sw.js` with every change so phones pick it up.
Service worker, install-to-home-screen and location need https (or localhost).

Leaflet and leaflet-rotate ship in `vendor/`, so the map library loads with no signal.

## Tests
    npm test

Covers the wind/thermal/scoring engine (sun position, terrain, thermals, ranking, sit windows, scent cone geometry) and the EXIF GPS reader.

## How the model works (js/engine.js)
- Wind: Open-Meteo hourly forecast (10 m wind, gusts, cloud, solar radiation, rain chance), interpolated as vectors.
- Terrain: elevation at the stand plus four points 150 m away (Copernicus 90 m model) gives slope and the direction it faces.
- Thermals: the slope's sun exposure (from solar position and radiation) decides rising versus sinking air. Strength scales with steepness and fades as the wind picks up. Added to the wind as a small drift vector.
- Score: wind fit 60%, steadiness 15%, wind speed 15%, rain 10%, minus a penalty for recently hunted stands.
- All numbers are estimates. Labels in the UI say so.

## Structure
    index.html       page shell
    css/app.css      all styles (light and dark follow the system)
    js/engine.js     pure model, no DOM (tested)
    js/exif.js       JPEG GPS reader (tested)
    js/store.js      local-first storage (localStorage + IndexedDB for photos)
    js/weather.js    Open-Meteo forecast and elevation, with cache
    js/map.js        Leaflet map, markers, cones, offline tiles
    js/app.js        state and panel UI
    sw.js            offline support
