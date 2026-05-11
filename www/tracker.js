// GPS tracker for live activities.
// Wraps navigator.geolocation.watchPosition, builds an array of fix points,
// accumulates distance via haversine, computes pace, and emits a tick event
// every second so the UI can refresh.

(function (global) {
  "use strict";

  function haversineKm(a, b) {
    const R = 6371;
    const toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(b.lat - a.lat);
    const dLon = toR(b.lon - a.lon);
    const lat1 = toR(a.lat), lat2 = toR(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  class Tracker {
    constructor() {
      this.kind = "run";
      this.points = []; // { lat, lon, ts, alt, speed }
      this.startTs = null;
      this.endTs = null;
      this.elapsedMs = 0; // accumulated active time in ms
      this.distanceKm = 0;
      this.paused = false;
      this.watchId = null;
      this.tickHandle = null;
      this.lastResumeTs = null;
      this.listeners = { tick: [], fix: [] };
      this.elevationGainM = 0;
      this.lastAlt = null;
      // Splits — each entry is { km: 1, ts: Date.now(), distKm: 1.0 }
      this.splits = [];
      this.nextSplitKm = 1;
      // Optional snapping bounds — if the user picked a curated route to follow
      // we keep that route's id so the activity record can reference it.
      this.followingRouteId = null;
    }

    on(event, fn) { this.listeners[event]?.push(fn); }
    emit(event, payload) { this.listeners[event]?.forEach((f) => f(payload)); }

    start(kind = "run", options = {}) {
      this.kind = kind;
      this.startTs = Date.now();
      this.lastResumeTs = this.startTs;
      this.paused = false;
      this.followingRouteId = options.routeId || null;
      this.needsGps = options.needsGps !== false; // default true; caller can set false for indoor
      if (this.needsGps) this._beginWatching();
      this.tickHandle = setInterval(() => this._tick(), 1000);
    }

    pause() {
      if (this.paused) return;
      this.paused = true;
      if (this.lastResumeTs) this.elapsedMs += Date.now() - this.lastResumeTs;
      this.lastResumeTs = null;
      // Stop watching position while paused (saves battery)
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.lastResumeTs = Date.now();
      this._beginWatching();
    }

    finish() {
      this.paused = true;
      this.endTs = Date.now();
      if (this.lastResumeTs) {
        this.elapsedMs += Date.now() - this.lastResumeTs;
        this.lastResumeTs = null;
      }
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      if (this.tickHandle !== null) {
        clearInterval(this.tickHandle);
        this.tickHandle = null;
      }
      return this.serialize();
    }

    _beginWatching() {
      if (!navigator.geolocation) {
        console.warn("Geolocation not available");
        return;
      }
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this._onFix(pos),
        (err) => console.warn("watchPosition error", err),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 8000 }
      );
    }

    _onFix(pos) {
      if (this.paused) return;
      const fix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        ts: Date.now(),
        alt: pos.coords.altitude,
        speed: pos.coords.speed,
        accuracy: pos.coords.accuracy,
      };
      // Drop low-accuracy fixes (>50m circle) — keeps GPS noise out of the trail
      if (fix.accuracy && fix.accuracy > 50 && this.points.length > 0) return;

      const last = this.points[this.points.length - 1];
      if (last) {
        const d = haversineKm(last, fix);
        // Reject jitter teleports
        const dt = (fix.ts - last.ts) / 1000;
        const speedMs = (d * 1000) / Math.max(dt, 0.5);
        // Sanity cap by activity kind: drives can be fast, runs can't
        const maxMs = this.kind === "drive" ? 80 : (this.kind === "bike" ? 25 : 12);
        if (speedMs > maxMs) return;
        // Reject sub-meter dribble
        if (d < 0.001) return;
        this.distanceKm += d;
      }
      // Track elevation gain (ignore noisy small bumps)
      if (fix.alt != null) {
        if (this.lastAlt != null) {
          const delta = fix.alt - this.lastAlt;
          if (delta > 1.5) this.elevationGainM += delta;
        }
        this.lastAlt = fix.alt;
      }
      this.points.push(fix);
      this._maybeSplit();
      this.emit("fix", fix);
    }

    _maybeSplit() {
      while (this.distanceKm >= this.nextSplitKm) {
        const km = this.nextSplitKm;
        this.splits.push({ km, ts: Date.now(), elapsedMs: this._activeElapsedMs() });
        this.nextSplitKm += 1;
      }
    }

    _activeElapsedMs() {
      if (this.paused) return this.elapsedMs;
      return this.elapsedMs + (this.lastResumeTs ? Date.now() - this.lastResumeTs : 0);
    }

    _tick() {
      this.emit("tick", {
        elapsedMs: this._activeElapsedMs(),
        distanceKm: this.distanceKm,
        paused: this.paused,
        points: this.points,
        kind: this.kind,
        elevationGainM: this.elevationGainM,
      });
    }

    serialize() {
      const id = `act_${this.startTs}_${Math.random().toString(36).slice(2, 7)}`;
      return {
        id,
        kind: this.kind,
        startTs: this.startTs,
        endTs: this.endTs,
        elapsedMs: this._activeElapsedMs(),
        distanceKm: this.distanceKm,
        elevationGainM: this.elevationGainM,
        points: this.points.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts, alt: p.alt })),
        splits: this.splits,
        photos: [],
        notes: "",
        followingRouteId: this.followingRouteId,
        coachWorkoutId: null,
        rating: null,
        createdAt: Date.now(),
      };
    }

    /** Current pace for the most recent ~minute of running, in seconds-per-km. */
    recentPaceSecPerKm(windowMs = 60000) {
      if (this.points.length < 2) return null;
      const now = Date.now();
      // Find the earliest point still within the window
      let i = this.points.length - 1;
      while (i > 0 && now - this.points[i].ts < windowMs) i--;
      const a = this.points[i];
      const b = this.points[this.points.length - 1];
      const dt = (b.ts - a.ts) / 1000;
      if (dt <= 0) return null;
      let d = 0;
      for (let j = i + 1; j < this.points.length; j++) {
        d += haversineKm(this.points[j - 1], this.points[j]);
      }
      if (d <= 0) return null;
      return dt / d;
    }
  }

  global.PaceTracker = Tracker;
  global.haversineKm = haversineKm;
})(typeof window !== "undefined" ? window : globalThis);
