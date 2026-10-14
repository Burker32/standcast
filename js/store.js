/* Local-first storage: stands, marks and settings in localStorage, photos in IndexedDB.
 * Phase 2 swaps this module for an account-backed store without touching the UI. */
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  var KEY = 'standcast.v1';
  var DEFAULT_VIEW = { lat: 37.66, lng: -93.76, zoom: 14 }; // Stockton Lake, MO
  var state = null;

  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function fresh() {
    return {
      v: 1, stands: [], marks: [],
      settings: { basemap: 'imagery', layers: { wind: true, thermal: true, field: true, swirl: true, animate: true, publand: true, cone: true, marks: true, rings: true }, view: DEFAULT_VIEW,
        backup: { at: 0, sig: null, snooze: 0 } }   // when the last backup was saved, what it held, and "remind me later" until
    };
  }
  function migrate(s) {
    var f = fresh();
    s = s && typeof s === 'object' ? s : f;
    s.stands = Array.isArray(s.stands) ? s.stands : [];
    s.marks = Array.isArray(s.marks) ? s.marks : [];
    s.settings = Object.assign({}, f.settings, s.settings || {});
    s.settings.layers = Object.assign({}, f.settings.layers, s.settings.layers || {});
    s.settings.view = Object.assign({}, f.settings.view, s.settings.view || {});
    s.settings.backup = Object.assign({}, f.settings.backup, s.settings.backup || {});
    return s;
  }
  function load() {
    try { var raw = localStorage.getItem(KEY); state = migrate(raw ? JSON.parse(raw) : null); }
    catch (e) { state = fresh(); }
    return state;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); api.saveFailed = false; }
    catch (e) { api.saveFailed = true; }
  }

  /* ---------- photos (IndexedDB, with an in-memory fallback) ---------- */
  var dbp = null, mem = {}, urls = {};
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      var r = indexedDB.open('standcast', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('photos'); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
    return dbp;
  }
  function withStore(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('photos', mode), req = fn(t.objectStore('photos'));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    });
  }
  function putPhoto(blob) {
    var id = uid('p_');
    return withStore('readwrite', function (st) { return st.put(blob, id); })
      .then(function () { return id; })
      .catch(function () { mem[id] = blob; return id; });
  }
  function getPhoto(id) {
    if (mem[id]) return Promise.resolve(mem[id]);
    return withStore('readonly', function (st) { return st.get(id); }).catch(function () { return null; });
  }
  function photoUrl(id) {
    if (!id) return Promise.resolve(null);
    if (urls[id]) return Promise.resolve(urls[id]);
    return getPhoto(id).then(function (blob) {
      if (!blob) return null;
      urls[id] = URL.createObjectURL(blob);
      return urls[id];
    });
  }
  function deletePhoto(id) {
    if (!id) return Promise.resolve();
    if (urls[id]) { URL.revokeObjectURL(urls[id]); delete urls[id]; }
    delete mem[id];
    return withStore('readwrite', function (st) { return st.delete(id); }).catch(function () {});
  }

  /* ---------- stands ---------- */
  function addStand(p) {
    var n = state.stands.length + 1;
    var s = Object.assign({
      id: uid('s_'), name: 'Stand ' + n, type: 'tree', lat: 0, lng: 0, winds: {}, notes: '',
      override: {}, sits: [], terrain: null, example: false, createdAt: Date.now()
    }, p);
    state.stands.push(s); save();
    return s;
  }
  function getStand(id) { return state.stands.filter(function (s) { return s.id === id; })[0] || null; }
  function updateStand(id, patch) {
    var s = getStand(id); if (!s) return null;
    Object.assign(s, patch); save();
    return s;
  }
  function removeStand(id) {
    state.stands = state.stands.filter(function (s) { return s.id !== id; }); save();
  }

  /* ---------- marks ---------- */
  function addMark(p) {
    var m = Object.assign({ id: uid('m_'), type: 'other', lat: 0, lng: 0, note: '', photoId: null, createdAt: Date.now() }, p);
    state.marks.push(m); save();
    return m;
  }
  function getMark(id) { return state.marks.filter(function (m) { return m.id === id; })[0] || null; }
  function updateMark(id, patch) {
    var m = getMark(id); if (!m) return null;
    Object.assign(m, patch); save();
    return m;
  }
  function removeMark(id) {
    var m = getMark(id);
    if (m && m.photoId) deletePhoto(m.photoId);
    if (m && m.shots) m.shots.forEach(function (x) { deletePhoto(x.id); });
    state.marks = state.marks.filter(function (x) { return x.id !== id; }); save();
  }

  /* ---------- backup ---------- */
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function exportAll() {
    var copy = JSON.parse(JSON.stringify(state));
    var asData = function (id) { return getPhoto(id).then(function (b) { return b ? blobToDataUrl(b) : null; }).catch(function () { return null; }); };
    return Promise.all(copy.marks.map(function (m) {
      // camera photos ride along as data inside each entry (x.data)
      var shots = Promise.all((m.shots || []).map(function (x) { return asData(x.id).then(function (d) { x.data = d; }); }));
      if (!m.photoId) return shots;
      return Promise.all([shots, asData(m.photoId).then(function (d) { m.photoData = d; })]);
    })).then(function () {
      return new Blob([JSON.stringify({ app: 'standcast', exportedAt: new Date().toISOString(), data: copy }, null, 1)], { type: 'application/json' });
    });
  }
  /* ---------- backup reminder ----------
   * The data lives only on this device, so nudge for a backup when there is something new to lose. */
  var DAY = 86400000;
  function realItems() {
    return { stands: state.stands.filter(function (s) { return !s.example; }), marks: state.marks };
  }
  // A short fingerprint of what the user has entered (not forecast or terrain data, which refresh by themselves).
  function dataSig() {
    var r = realItems();
    var text = JSON.stringify([
      r.stands.map(function (s) { return [s.id, s.name, s.type, s.lat, s.lng, s.winds, s.notes, s.override, s.sits, s.windFix, s.routes]; }),
      r.marks.map(function (m) { return [m.id, m.type, m.lat, m.lng, m.name || '', m.note, m.photoId, (m.shots || []).length]; })
    ]);
    var hash = 5381;
    for (var i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return text.length + ':' + hash;
  }
  function markBackedUp(now) {
    state.settings.backup = { at: now || Date.now(), sig: dataSig(), snooze: 0 }; save();
  }
  function snoozeBackup(days, now) {
    state.settings.backup.snooze = (now || Date.now()) + days * DAY; save();
  }
  // null when no reminder is due, otherwise { stands, marks, at } for the reminder text.
  function backupDue(now) {
    now = now || Date.now();
    var r = realItems(), b = state.settings.backup;
    if (!r.stands.length && !r.marks.length) return null;
    if (now < b.snooze || dataSig() === b.sig) return null;
    if (b.at) { if (now - b.at < 7 * DAY) return null; }
    else {
      // never backed up: give a new user a day before the first nudge
      var oldest = now;
      r.stands.concat(r.marks).forEach(function (x) { oldest = Math.min(oldest, x.createdAt || 0); });
      if (now - oldest < DAY) return null;
    }
    return { stands: r.stands.length, marks: r.marks.length, at: b.at };
  }

  function importAll(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return Promise.reject(new Error('That file is not a StandCast backup.')); }
    if (!parsed || parsed.app !== 'standcast' || !parsed.data) return Promise.reject(new Error('That file is not a StandCast backup.'));
    var incoming = migrate(parsed.data), added = { stands: 0, marks: 0 };
    var wasEmpty = !state.stands.length && !state.marks.length;
    var haveS = {}, haveM = {};
    state.stands.forEach(function (s) { haveS[s.id] = 1; });
    state.marks.forEach(function (m) { haveM[m.id] = 1; });
    incoming.stands.forEach(function (s) { if (!haveS[s.id]) { state.stands.push(s); added.stands++; } });
    return Promise.all(incoming.marks.map(function (m) {
      if (haveM[m.id]) return null;
      var data = m.photoData; delete m.photoData;
      var p = Promise.resolve();
      if (data) {
        p = fetch(data).then(function (r) { return r.blob(); }).then(putPhoto).then(function (id) { m.photoId = id; });
      } else { m.photoId = null; }
      p = p.catch(function () { m.photoId = null; });
      var shots = Promise.all((m.shots || []).map(function (x) {
        var d = x.data; delete x.data;
        return d ? fetch(d).then(function (r) { return r.blob(); }).then(putPhoto).then(function (id) { x.id = id; }, function () { x.id = null; }) : (x.id = null);
      })).then(function () { if (m.shots) m.shots = m.shots.filter(function (x) { return x.id; }); });
      return Promise.all([p, shots]).then(function () { state.marks.push(m); added.marks++; });
    })).then(function () {
      save();
      if (wasEmpty) markBackedUp();   // everything here just came from a backup file
      return added;
    });
  }
  function clearAll() {
    state.marks.forEach(function (m) { if (m.photoId) deletePhoto(m.photoId); (m.shots || []).forEach(function (x) { deletePhoto(x.id); }); });
    var view = state.settings;
    state = fresh(); state.settings = view; save();
  }

  var api = {
    saveFailed: false, uid: uid, DEFAULT_VIEW: DEFAULT_VIEW,
    load: load, save: save, get state() { return state; },
    addStand: addStand, getStand: getStand, updateStand: updateStand, removeStand: removeStand,
    addMark: addMark, getMark: getMark, updateMark: updateMark, removeMark: removeMark,
    putPhoto: putPhoto, photoUrl: photoUrl, deletePhoto: deletePhoto,
    exportAll: exportAll, importAll: importAll, clearAll: clearAll,
    backupDue: backupDue, markBackedUp: markBackedUp, snoozeBackup: snoozeBackup
  };
  SC.store = api;
})();
