// IndexedDB wrapper for pacepost.
// Two stores:
//   - activities: keyed by id (string)
//   - meta: small key/value bag (profile name, settings, ratings)
//
// Photos live INSIDE the activity record as data URLs to avoid blob refs that
// can break across reload. v1 ships single-user / single-device.

(function (global) {
  "use strict";

  const DB_NAME = "pacepost";
  const DB_VERSION = 1;
  const STORE_ACTIVITIES = "activities";
  const STORE_META = "meta";

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_ACTIVITIES)) {
          const s = db.createObjectStore(STORE_ACTIVITIES, { keyPath: "id" });
          s.createIndex("byKind", "kind", { unique: false });
          s.createIndex("byStartTs", "startTs", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode = "readonly") {
    return open().then((db) => {
      const t = db.transaction(store, mode);
      return t.objectStore(store);
    });
  }

  function asPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ── Activities ─────────────────────────────────────────────
  async function putActivity(act) {
    const s = await tx(STORE_ACTIVITIES, "readwrite");
    return asPromise(s.put(act));
  }

  async function getActivity(id) {
    const s = await tx(STORE_ACTIVITIES);
    return asPromise(s.get(id));
  }

  async function deleteActivity(id) {
    const s = await tx(STORE_ACTIVITIES, "readwrite");
    return asPromise(s.delete(id));
  }

  async function allActivities() {
    const s = await tx(STORE_ACTIVITIES);
    const list = await asPromise(s.getAll());
    list.sort((a, b) => b.startTs - a.startTs);
    return list;
  }

  // ── Meta key/value ─────────────────────────────────────────
  async function putMeta(key, value) {
    const s = await tx(STORE_META, "readwrite");
    return asPromise(s.put({ key, value }));
  }

  async function getMeta(key, fallback = null) {
    const s = await tx(STORE_META);
    const r = await asPromise(s.get(key));
    return r ? r.value : fallback;
  }

  // ── Bulk reset ─────────────────────────────────────────────
  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([STORE_ACTIVITIES, STORE_META], "readwrite");
      t.objectStore(STORE_ACTIVITIES).clear();
      t.objectStore(STORE_META).clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }

  // ── Export / import ────────────────────────────────────────
  async function exportAll() {
    const acts = await allActivities();
    const db = await open();
    return new Promise((resolve, reject) => {
      const meta = [];
      const t = db.transaction(STORE_META);
      const s = t.objectStore(STORE_META);
      const req = s.openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          meta.push({ key: c.key, value: c.value });
          c.continue();
        } else {
          resolve({
            version: 1,
            exportedAt: new Date().toISOString(),
            activities: acts,
            meta,
          });
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function importAll(payload, { merge = true } = {}) {
    if (!payload || !Array.isArray(payload.activities)) throw new Error("invalid backup");
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([STORE_ACTIVITIES, STORE_META], "readwrite");
      if (!merge) {
        t.objectStore(STORE_ACTIVITIES).clear();
        t.objectStore(STORE_META).clear();
      }
      const sa = t.objectStore(STORE_ACTIVITIES);
      for (const act of payload.activities) {
        if (act && act.id) sa.put(act);
      }
      const sm = t.objectStore(STORE_META);
      for (const m of payload.meta || []) {
        if (m && m.key) sm.put(m);
      }
      t.oncomplete = () => resolve({ activities: payload.activities.length });
      t.onerror = () => reject(t.error);
    });
  }

  global.PaceDB = {
    putActivity,
    getActivity,
    deleteActivity,
    allActivities,
    putMeta,
    getMeta,
    clearAll,
    exportAll,
    importAll,
  };
})(typeof window !== "undefined" ? window : globalThis);
