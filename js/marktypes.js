/* Kinds of sign a hunter can drop on the map, shared by the map and the panel. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var NS = 'http://www.w3.org/2000/svg';

  // Glyphs are drawn on a 24x24 grid, stroke only.
  var TYPES = {
    scrape: { label: 'Scrape', color: '#b9792a', path: 'M8 5 L6 19 M12 4 V20 M16 5 L18 19' },
    rub:    { label: 'Rub', color: '#8f6444', path: 'M9 3 V21 M15 3 V21 M6 9 H18 M6 14 H18' },
    bed:    { label: 'Bedding', color: '#7f6fb0', path: 'M4 13 a8 5 0 1 0 16 0 a8 5 0 1 0 -16 0' },
    food:   { label: 'Food', color: '#4f8f45', path: 'M5 19 C5 9 11 5 19 5 C19 13 15 19 5 19 Z M5 19 L13 11' },
    trail:  { label: 'Trail', color: '#5f8796', path: 'M4 19 L9 13 L13 16 L20 6 M16 6 H20 V10' },
    camera: { label: 'Camera', color: '#37898a', path: 'M4 8 H8 L10 6 H14 L16 8 H20 V19 H4 Z M12 10.5 a3 3 0 1 0 0.01 0' },
    plot:   { label: 'Food plot', color: '#6b9a2e', path: 'M4 18 H20 M7 18 V10 M12 18 V7 M17 18 V11 M7 12 l-2 -2 M12 9 l2 -2 M17 13 l2 -2' },
    feeder: { label: 'Feeder', color: '#a0682c', path: 'M8 4 H16 L18 10 H6 Z M9 10 V20 M15 10 V20 M7 20 H17' },
    water:  { label: 'Water hole', color: '#2f78b7', path: 'M12 3 C12 3 6 10 6 14 a6 6 0 0 0 12 0 C18 10 12 3 12 3 Z' },
    crossing: { label: 'Crossing', color: '#4b7f9c', path: 'M3 9 C7 7 9 11 12 9 S17 7 21 9 M3 15 C7 13 9 17 12 15 S17 13 21 15 M9 5 V19' },
    blind:  { label: 'Ground blind', color: '#6d6a3b', path: 'M4 19 L12 5 L20 19 Z M9 14 H15' },
    gate:   { label: 'Gate', color: '#8b8b8b', path: 'M4 6 V20 M20 6 V20 M4 9 H20 M4 15 H20 M4 9 L20 15' },
    parking: { label: 'Parking', color: '#3e5fa8', path: 'M6 4 H20 V20 H6 Z M10 16 V8 H13.5 a2.5 2.5 0 0 1 0 5 H10' },
    sighting: { label: 'Deer seen', color: '#c0572e', path: 'M2 12 C5 6 19 6 22 12 C19 18 5 18 2 12 Z M12 9.5 a2.5 2.5 0 1 0 0.01 0' },
    shed:   { label: 'Shed', color: '#b39a6b', path: 'M6 20 C6 13 9 8 14 5 M9 13 L5 9 M11 9 L9 4 M12 15 L18 12' },
    other:  { label: 'Other', color: '#80857a', path: 'M12 4 L20 12 L12 20 L4 12 Z' }
  };
  // sign first, then food and water, then access and gear
  var ORDER = ['scrape', 'rub', 'bed', 'trail', 'sighting', 'shed', 'food', 'plot', 'water', 'crossing', 'camera', 'feeder', 'blind', 'gate', 'parking', 'other'];

  function icon(type, size) {
    var t = TYPES[type] || TYPES.other;
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 16);
    s.setAttribute('height', size || 16);
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', t.path);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
  }

  SC.markTypes = { TYPES: TYPES, ORDER: ORDER, icon: icon };
})();
