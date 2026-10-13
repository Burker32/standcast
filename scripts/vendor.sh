#!/bin/sh
# Downloads Leaflet into vendor/leaflet so the app no longer depends on a CDN for its map library.
# Run once from the project folder: sh scripts/vendor.sh
set -e
mkdir -p vendor/leaflet/images
BASE=https://unpkg.com/leaflet@1.9.4/dist
curl -fsSL "$BASE/leaflet.js"  -o vendor/leaflet/leaflet.js
curl -fsSL "$BASE/leaflet.css" -o vendor/leaflet/leaflet.css
for f in layers.png layers-2x.png marker-icon.png marker-icon-2x.png marker-shadow.png; do
  curl -fsSL "$BASE/images/$f" -o "vendor/leaflet/images/$f"
done
echo "Leaflet saved to vendor/leaflet. Add vendor/leaflet/leaflet.js and leaflet.css to FILES in sw.js to cache them offline."
