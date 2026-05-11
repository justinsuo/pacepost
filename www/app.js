// pacepost — main app logic.
// Single-IIFE so the global namespace stays clean. Loads achievement defs
// and curated routes/workouts from data/*.json on boot, sets up the bottom
// nav, renders each view on demand, runs the live tracker overlay, and
// drives the coached-workout engine + audio cues.

(function () {
  "use strict";

  // ─── State ──────────────────────────────────────────────────
  let routes = [];
  let workouts = [];
  let achievementDefs = [];
  let activities = [];
  let unlockedBadges = new Set();
  let routeRatings = {};      // routeId → 1-5
  let profile = {
    name: "", joinedAt: null, muteCoach: false,
    weightLbs: null, heightIn: null, age: null,
    bio: "", region: "", avatarBg: "#38bdf8",
    units: "imperial",
    autopause: false, publicDefault: true, wakeLock: true,
  };
  let personalRoutes = []; // user-created routes via the route builder
  let prs = {};               // distance-key → { activityId, time_sec, achievedAt }
  let tracker = null;
  let liveMap = null;
  let liveTrack = null;
  let liveStartMarker = null;
  let liveEndMarker = null;
  let coachState = null;      // { workout, stepIndex, stepStartMs }
  let activityForCoach = null;// route or workout context for the live session

  // ─── Boot ───────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", boot);

  async function boot() {
    try {
      const [r, w, a] = await Promise.all([
        fetch("data/routes.json").then((x) => x.json()),
        fetch("data/workouts.json").then((x) => x.json()),
        fetch("data/achievements.json").then((x) => x.json()),
      ]);
      routes = r.routes || [];
      workouts = w.workouts || [];
      achievementDefs = a.achievements || [];
    } catch (e) {
      console.warn("Failed to load static data:", e);
    }

    // Load persisted state
    activities = await PaceDB.allActivities();
    unlockedBadges = new Set(await PaceDB.getMeta("unlockedBadges", []));
    routeRatings = (await PaceDB.getMeta("routeRatings", {})) || {};
    const savedProfile = await PaceDB.getMeta("profile", null);
    if (savedProfile) profile = { ...profile, ...savedProfile };
    if (!profile.joinedAt) {
      profile.joinedAt = Date.now();
      await PaceDB.putMeta("profile", profile);
    }
    prs = (await PaceDB.getMeta("prs", {})) || {};
    personalRoutes = (await PaceDB.getMeta("personalRoutes", [])) || [];
    await loadGolfCourses();
    await loadSheetsCfg();
    await loadSocialState();

    wireNav();
    wireTopbar();
    wireTrack();
    wireRoutesView();
    wireHistory();
    wireProfile();
    wireLiveControls();
    wireDetailModal();
    wireInstallApp();
    wireRouteBuilder();
    wireSheets();
    wireFeedFilters();
    wireSettings();
    wireProfileCustomization();

    renderAll();

    // Register service worker for offline support
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  // ─── Nav ────────────────────────────────────────────────────
  function wireNav() {
    document.querySelectorAll("#bottom-nav .nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });
    // "See all →" links from home
    document.querySelectorAll("[data-go]").forEach((b) => {
      b.addEventListener("click", () => switchView(b.dataset.go));
    });
  }

  function switchView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
    document.querySelectorAll("#bottom-nav .nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    if (name === "home") renderHome();
    if (name === "track") renderTrack();
    if (name === "routes") renderRoutes();
    if (name === "history") renderHistory();
    if (name === "feed") renderFeed();
    if (name === "profile") renderProfile();
    window.scrollTo(0, 0);
  }

  // ─── Top bar ────────────────────────────────────────────────
  function wireTopbar() {
    document.getElementById("profile-btn").addEventListener("click", () => switchView("profile"));
    document.getElementById("topbar-signin")?.addEventListener("click", () => openAuthModal("signin"));
    document.getElementById("topbar-dms")?.addEventListener("click", openMessages);
  }

  // ─── Top-level render ───────────────────────────────────────
  function renderAll() {
    updateStreakChip();
    renderHome();
  }

  function updateStreakChip() {
    document.getElementById("streak-value").textContent = currentStreak();
  }

  // ─── Home ───────────────────────────────────────────────────
  function renderHome() {
    const hero = document.getElementById("home-hero");
    const totalKm = activities.reduce((s, a) => s + (a.distanceKm || 0), 0);
    const totalMi = totalKm * 0.621371;
    const totalActs = activities.length;
    const last = activities[0];
    const lastTxt = last
      ? `Last activity: ${kindLabel(last.kind)} · ${formatDistance(last.distanceKm)} · ${relativeTime(last.startTs)}`
      : "Tap Track to log your first activity.";
    hero.innerHTML = `
      <div class="hero-greeting">${greeting()}, ${escapeHtml(profile.name || "athlete")}</div>
      <div class="hero-stat">${totalActs ? totalMi.toFixed(1) + " mi" : "Welcome"}</div>
      <div class="hero-meta">
        <span><strong>${totalActs}</strong> activities</span>
        <span><strong>${currentStreak()}</strong> day streak</span>
        <span><strong>${unlockedBadges.size}</strong> badges</span>
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--text-dim);">${escapeHtml(lastTxt)}</div>
    `;

    // Today's suggestion: a recommended route or coached workout
    const suggestion = pickTodaySuggestion();
    document.getElementById("home-suggestion").innerHTML = suggestion
      ? `
        <span class="suggestion-tag">${suggestion.tag}</span>
        <div class="suggestion-title">${escapeHtml(suggestion.title)}</div>
        <div class="suggestion-meta">${escapeHtml(suggestion.meta)}</div>
      `
      : `<div class="suggestion-title">Pick something on the Routes tab</div>`;
    document.getElementById("home-suggestion").onclick = () => suggestion?.go();

    // Recent (last 3)
    const recentEl = document.getElementById("home-recent");
    recentEl.innerHTML = "";
    if (!activities.length) {
      recentEl.innerHTML = `<div class="empty-state" style="padding:24px;"><div>No activities yet.</div></div>`;
    } else {
      activities.slice(0, 3).forEach((a) => recentEl.appendChild(activityCardEl(a)));
    }

    // Recent unlocks
    const home = document.getElementById("home-badges");
    home.innerHTML = "";
    const recent = achievementDefs.filter((d) => unlockedBadges.has(d.id)).slice(-6).reverse();
    if (!recent.length) {
      // Show a few targets the user could chase
      achievementDefs.slice(0, 5).forEach((d) => home.appendChild(badgeEl(d, false)));
    } else {
      recent.forEach((d) => home.appendChild(badgeEl(d, true)));
    }
  }

  function pickTodaySuggestion() {
    const hour = new Date().getHours();
    const isMorning = hour < 11;
    const isEvening = hour >= 17;
    // If morning: pick a HIIT workout or short run route
    if (isMorning) {
      const w = workouts.find((x) => x.id === "morning-jolt");
      if (w) return {
        tag: "Morning",
        title: w.name,
        meta: `${w.duration_min} min · ${w.description}`,
        go: () => startCoachedWorkout(w.id),
      };
    }
    if (isEvening) {
      const r = routes.find((x) => x.id === "berkeley-marina-walk") || routes.find((r) => r.kind === "walk");
      if (r) return {
        tag: "Evening",
        title: r.name,
        meta: `${r.distance_km} km · ${r.summary.slice(0, 80)}…`,
        go: () => openRouteDetail(r.id),
      };
    }
    // Default: random run route
    const candidates = routes.filter((r) => r.kind === "run");
    if (candidates.length) {
      const r = candidates[Math.floor(Math.random() * candidates.length)];
      return {
        tag: "Try this",
        title: r.name,
        meta: `${r.distance_km} km · ${r.region}`,
        go: () => openRouteDetail(r.id),
      };
    }
    return null;
  }

  // ─── Track view ─────────────────────────────────────────────
  function wireTrack() {
    const grid = document.getElementById("kind-grid");
    if (grid && !grid.children.length) {
      const kinds = [
        ["run", "Run"], ["drive", "Drive"], ["offroad", "Offroad"], ["bike", "Bike"],
        ["walk", "Walk"], ["hike", "Hike"], ["swim", "Swim"], ["yoga", "Yoga"],
        ["golf", "Golf"], ["workout", "Workout"], ["climb", "Climb"], ["ski", "Ski"],
        ["snowboard", "Snowboard"], ["surf", "Surf"], ["kayak", "Kayak"], ["row", "Row"],
      ];
      grid.innerHTML = kinds.map(([k, label]) =>
        `<button class="kind-card kind-${k}" data-start="${k}"><div class="kind-icon">${kindIcon(k)}</div><div class="kind-name">${label}</div></button>`
      ).join("");
    }
    document.querySelectorAll("[data-start]").forEach((btn) => {
      btn.addEventListener("click", () => startLive(btn.dataset.start));
    });
  }
  function renderTrack() {
    const list = document.getElementById("workout-list");
    list.innerHTML = "";
    workouts.forEach((w) => {
      const card = document.createElement("div");
      card.className = "workout-card";
      card.innerHTML = `
        <div class="workout-row">
          <div class="workout-icon" style="background:${w.color}22;color:${w.color};">${kindIcon(w.activityKind)}</div>
          <div class="workout-info">
            <div class="workout-name">${escapeHtml(w.name)}</div>
            <div class="workout-desc">${escapeHtml(w.description)}</div>
            <div class="workout-meta">${w.duration_min} min · ${w.steps.length} steps · ${escapeHtml(w.kind)}</div>
          </div>
          <button class="workout-go">Start</button>
        </div>
      `;
      card.querySelector(".workout-go").addEventListener("click", (e) => {
        e.stopPropagation();
        startCoachedWorkout(w.id);
      });
      list.appendChild(card);
    });
  }

  // ─── Routes view ────────────────────────────────────────────
  let routeFilter = "all";
  let routesTab = "list";
  function wireRoutesView() {
    document.querySelectorAll("#routes-filter .filter-chip").forEach((c) => {
      c.addEventListener("click", () => {
        document.querySelectorAll("#routes-filter .filter-chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        routeFilter = c.dataset.routeKind;
        renderRoutes();
      });
    });
    document.querySelectorAll("#routes-tabs .seg-tab").forEach((t) => {
      t.addEventListener("click", () => {
        document.querySelectorAll("#routes-tabs .seg-tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        routesTab = t.dataset.routesTab;
        document.querySelectorAll("[data-routes-panel]").forEach((p) => {
          p.style.display = p.dataset.routesPanel === routesTab ? "" : "none";
        });
        if (routesTab === "map") setTimeout(() => _routesMap && _routesMap.invalidateSize(), 60);
        renderRoutes();
      });
    });
    document.getElementById("create-route-btn")?.addEventListener("click", openRouteBuilder);
  }

  // ─── Custom route builder ──────────────────────────────────
  let builderMap = null;
  let builderTrack = null;
  let builderMarkers = [];
  let builderWaypoints = [];
  function openRouteBuilder() {
    const overlay = document.getElementById("builder-overlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    builderWaypoints = [];
    document.getElementById("builder-name").value = "";
    setTimeout(() => initBuilderMap(), 80);
  }
  function closeRouteBuilder() {
    const overlay = document.getElementById("builder-overlay");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    if (builderMap) { builderMap.remove(); builderMap = null; }
    builderTrack = null;
    builderMarkers = [];
    builderWaypoints = [];
  }
  function initBuilderMap() {
    if (builderMap) builderMap.remove();
    builderMap = L.map("builder-map", { attributionControl: false }).setView([37.8, -122.2], 11);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(builderMap);
    builderTrack = L.polyline([], { color: "#ea580c", weight: 4 }).addTo(builderMap);
    builderMap.on("click", (e) => addBuilderWaypoint(e.latlng.lat, e.latlng.lng));
    // Try to center on user's location for convenience
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        builderMap.setView([pos.coords.latitude, pos.coords.longitude], 14);
      }, () => {}, { timeout: 4000 });
    }
    refreshBuilderUi();
  }
  function addBuilderWaypoint(lat, lon) {
    builderWaypoints.push({ lat, lon });
    const div = L.divIcon({ className: "", html: `<div class="builder-marker"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
    const m = L.marker([lat, lon], { icon: div }).addTo(builderMap);
    builderMarkers.push(m);
    builderTrack.setLatLngs(builderWaypoints.map((w) => [w.lat, w.lon]));
    refreshBuilderUi();
  }
  function refreshBuilderUi() {
    const stats = document.getElementById("builder-stats");
    let km = 0;
    for (let i = 1; i < builderWaypoints.length; i++) {
      km += haversineKm(builderWaypoints[i - 1], builderWaypoints[i]);
    }
    const mi = km * 0.621371;
    stats.textContent = `${builderWaypoints.length} waypoints · ${mi.toFixed(2)} mi`;
  }
  function wireRouteBuilder() {
    document.getElementById("builder-close")?.addEventListener("click", closeRouteBuilder);
    document.getElementById("builder-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "builder-overlay") closeRouteBuilder();
    });
    document.getElementById("builder-undo")?.addEventListener("click", () => {
      builderWaypoints.pop();
      const m = builderMarkers.pop();
      if (m && builderMap) builderMap.removeLayer(m);
      builderTrack.setLatLngs(builderWaypoints.map((w) => [w.lat, w.lon]));
      refreshBuilderUi();
    });
    document.getElementById("builder-clear")?.addEventListener("click", () => {
      builderWaypoints = [];
      builderMarkers.forEach((m) => builderMap.removeLayer(m));
      builderMarkers = [];
      builderTrack.setLatLngs([]);
      refreshBuilderUi();
    });
    document.getElementById("builder-save")?.addEventListener("click", async () => {
      if (builderWaypoints.length < 2) {
        toast("Add at least 2 waypoints", "error");
        return;
      }
      const name = (document.getElementById("builder-name").value || "").trim() || "Untitled route";
      const kind = document.getElementById("builder-kind").value;
      let km = 0;
      for (let i = 1; i < builderWaypoints.length; i++) km += haversineKm(builderWaypoints[i - 1], builderWaypoints[i]);
      const route = {
        id: `mine_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        kind,
        tags: ["mine"],
        region: "Personal",
        distance_km: Math.round(km * 100) / 100,
        elevation_ft: 0,
        summary: `Custom ${kind} route, ${km.toFixed(2)} km.`,
        best_time: "Whenever",
        start: { lat: builderWaypoints[0].lat, lon: builderWaypoints[0].lon },
        waypoints: builderWaypoints,
        color: "#ea580c",
        personal: true,
        createdAt: Date.now(),
      };
      personalRoutes.unshift(route);
      await PaceDB.putMeta("personalRoutes", personalRoutes);
      closeRouteBuilder();
      renderRoutes();
      toast(`Saved "${name}"`, "success");
    });
  }
  function renderRoutes() {
    const container = document.getElementById("route-cards");
    container.innerHTML = "";
    let list;
    if (routeFilter === "all") {
      list = [...personalRoutes, ...routes];
    } else if (routeFilter === "mine") {
      list = personalRoutes;
    } else {
      list = [...personalRoutes, ...routes].filter((r) => r.kind === routeFilter);
    }
    renderRoutesMap(list);
    if (!list.length) {
      container.innerHTML = `<div class="empty-state" style="padding:30px;"><div>${routeFilter === "mine" ? "No saved routes yet. Tap Create my own to make one." : "No routes match this filter."}</div></div>`;
      return;
    }
    list.forEach((r) => container.appendChild(routeCardEl(r)));
  }

  let _routesMap = null;
  let _routesMapMarkers = [];
  let _routesMapPolyline = null;
  let _routesMapEndMarker = null;
  let _selectedRouteId = null;
  const _polylineCache = {};
  const KIND_PIN_COLORS = {
    run: "#16a34a", drive: "#0891b2", bike: "#9333ea",
    walk: "#0d9488", hike: "#65a30d", swim: "#0284c7",
    offroad: "#b45309",
  };
  const OSRM_PROFILE = { run: "foot", walk: "foot", hike: "foot", bike: "bike", drive: "driving", offroad: "driving" };

  function renderRoutesMap(list) {
    const el = document.getElementById("routes-map");
    if (!el || !window.L) return;
    const countEl = document.getElementById("routes-map-count");
    if (countEl) countEl.textContent = `${list.length} route${list.length === 1 ? "" : "s"}`;
    if (!_routesMap) {
      _routesMap = L.map(el, { zoomControl: true, attributionControl: true });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, attribution: "© OSM · CARTO",
      }).addTo(_routesMap);
      _routesMap.on("click", (e) => {
        // Click on empty map → clear selection
        if (!e.originalEvent.target.closest(".leaflet-marker-icon")) clearRouteSelection();
      });
      const fitBtn = document.getElementById("routes-map-fit");
      fitBtn?.addEventListener("click", () => {
        clearRouteSelection();
        fitMapToAll();
      });
    }
    _routesMapMarkers.forEach((m) => _routesMap.removeLayer(m));
    _routesMapMarkers = [];
    clearRouteSelection({ silent: true });

    const bounds = [];
    list.forEach((r) => {
      if (!r.start || typeof r.start.lat !== "number") return;
      const color = KIND_PIN_COLORS[r.kind] || "#38bdf8";
      const icon = L.divIcon({
        className: "route-pin",
        html: `<span class="route-pin-dot" style="background:${color};"></span>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      });
      const m = L.marker([r.start.lat, r.start.lon], { icon, title: r.name, riseOnHover: true });
      m.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectRouteOnMap(r);
      });
      m.addTo(_routesMap);
      _routesMapMarkers.push(m);
      bounds.push([r.start.lat, r.start.lon]);
    });
    _mapAllBounds = bounds;
    fitMapToAll();
    setTimeout(() => _routesMap && _routesMap.invalidateSize(), 60);
    renderRoutesLegend(list);
  }
  let _mapAllBounds = [];
  function fitMapToAll() {
    if (!_routesMap) return;
    if (_mapAllBounds.length === 1) _routesMap.setView(_mapAllBounds[0], 12);
    else if (_mapAllBounds.length > 1) _routesMap.fitBounds(_mapAllBounds, { padding: [40, 40], maxZoom: 12 });
    else _routesMap.setView([37.8, -122.3], 9);
  }

  async function selectRouteOnMap(r) {
    _selectedRouteId = r.id;
    const color = KIND_PIN_COLORS[r.kind] || "#38bdf8";
    showRouteSelectionCard(r, /*loading*/ true);
    const coords = await getRouteLineCoords(r);
    if (_selectedRouteId !== r.id) return; // user clicked something else mid-flight
    if (_routesMapPolyline) { _routesMap.removeLayer(_routesMapPolyline); _routesMapPolyline = null; }
    if (_routesMapEndMarker) { _routesMap.removeLayer(_routesMapEndMarker); _routesMapEndMarker = null; }
    _routesMapPolyline = L.polyline(coords, { color, weight: 5, opacity: 0.85, lineJoin: "round", lineCap: "round" }).addTo(_routesMap);
    if (r.end && (r.end.lat !== r.start.lat || r.end.lon !== r.start.lon)) {
      const endIcon = L.divIcon({
        className: "route-pin route-pin-end",
        html: `<span class="route-pin-dot end" style="background:#fff;border:3px solid ${color};"></span>`,
        iconSize: [20, 20], iconAnchor: [10, 10],
      });
      _routesMapEndMarker = L.marker([r.end.lat, r.end.lon], { icon: endIcon }).addTo(_routesMap);
    }
    _routesMap.fitBounds(L.latLngBounds(coords), { padding: [50, 50], maxZoom: 14 });
    showRouteSelectionCard(r, /*loading*/ false);
  }
  function clearRouteSelection({ silent = false } = {}) {
    _selectedRouteId = null;
    if (_routesMapPolyline) { _routesMap.removeLayer(_routesMapPolyline); _routesMapPolyline = null; }
    if (_routesMapEndMarker) { _routesMap.removeLayer(_routesMapEndMarker); _routesMapEndMarker = null; }
    const card = document.getElementById("routes-map-selection");
    if (card) card.style.display = "none";
    if (!silent) fitMapToAll();
  }
  function showRouteSelectionCard(r, loading) {
    const card = document.getElementById("routes-map-selection");
    if (!card) return;
    const color = KIND_PIN_COLORS[r.kind] || "#38bdf8";
    const stats = routeAttemptsFor(r.id);
    const distMi = (r.distance_km * 0.621371);
    card.innerHTML = `
      <div class="rsc-head">
        <div class="rsc-color-bar" style="background:${color};"></div>
        <div class="rsc-title">
          <div class="rsc-name">${escapeHtml(r.name)}</div>
          <div class="rsc-region">${kindLabel(r.kind)} · ${escapeHtml(r.region || "")}</div>
        </div>
        <button class="icon-btn rsc-close" aria-label="Clear" title="Clear">✕</button>
      </div>
      <div class="rsc-stats">
        <div><div class="rsc-lbl">Distance</div><div class="rsc-val">${distMi.toFixed(distMi < 10 ? 1 : 0)} mi</div></div>
        <div><div class="rsc-lbl">Elevation</div><div class="rsc-val">${r.elevation_ft} ft</div></div>
        <div><div class="rsc-lbl">Best</div><div class="rsc-val">${stats.count ? formatDuration(stats.bestSec) : "—"}</div></div>
        <div><div class="rsc-lbl">Tries</div><div class="rsc-val">${stats.count || "—"}</div></div>
      </div>
      ${loading ? `<div class="rsc-loading">Loading route line…</div>` : ""}
      <div class="rsc-actions">
        <button class="btn-ghost" data-rsc-detail>View details</button>
        <button class="btn-primary" data-rsc-start>${r.kind === "drive" ? "▶ Time this drive" : "▶ Start tracking"}</button>
      </div>
    `;
    card.style.display = "";
    card.querySelector(".rsc-close").addEventListener("click", () => clearRouteSelection());
    card.querySelector("[data-rsc-detail]").addEventListener("click", () => openRouteDetail(r.id));
    card.querySelector("[data-rsc-start]").addEventListener("click", () => startLive(r.kind, { routeId: r.id }));
  }
  async function getRouteLineCoords(r) {
    // 1) waypoints (user-built routes)
    if (Array.isArray(r.waypoints) && r.waypoints.length >= 2) {
      return r.waypoints.map((w) => [w.lat, w.lon]);
    }
    // 2) cached OSRM result
    if (_polylineCache[r.id]) return _polylineCache[r.id];
    // 3) try OSRM road-snap when we have both start + end
    if (r.start && r.end && (r.start.lat !== r.end.lat || r.start.lon !== r.end.lon)) {
      try {
        const profile = OSRM_PROFILE[r.kind] || "driving";
        const url = `https://router.project-osrm.org/route/v1/${profile}/${r.start.lon},${r.start.lat};${r.end.lon},${r.end.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url, { signal: AbortSignal.timeout?.(7000) });
        const data = await res.json();
        const line = data?.routes?.[0]?.geometry?.coordinates;
        if (line && line.length) {
          const latlngs = line.map(([lon, lat]) => [lat, lon]);
          _polylineCache[r.id] = latlngs;
          return latlngs;
        }
      } catch (e) { /* fall through */ }
      // fallback: straight line
      return [[r.start.lat, r.start.lon], [r.end.lat, r.end.lon]];
    }
    // 4) loop with no waypoints — just a dot at start
    return [[r.start.lat, r.start.lon]];
  }

  function renderRoutesLegend(list) {
    const el = document.getElementById("routes-map-legend");
    if (!el) return;
    const kinds = [...new Set(list.map((r) => r.kind))];
    el.innerHTML = kinds
      .map((k) => `<span class="legend-item"><span class="legend-dot" style="background:${KIND_PIN_COLORS[k] || "#38bdf8"};"></span>${kindLabel(k)}</span>`)
      .join("");
  }

  function routeCardEl(r) {
    const el = document.createElement("button");
    el.className = "route-card";
    el.type = "button";
    const stars = ratingStars(routeRatings[r.id] || 0);
    const thumb = (r.photoUrls && r.photoUrls[0])
      ? `<img class="route-thumb" src="${escapeHtml(r.photoUrls[0])}" alt="" loading="lazy" />` : "";
    const distMi = r.distance_km * 0.621371;
    el.innerHTML = `
      ${thumb}
      <div class="route-card-body">
        <div class="route-head">
          <div>
            <div class="route-name">${escapeHtml(r.name)}</div>
            <div class="route-region">${kindLabel(r.kind)} · ${escapeHtml(r.region)}</div>
          </div>
          <div class="act-icon ${r.kind}">${kindIcon(r.kind)}</div>
        </div>
        <div class="route-tags">${(r.tags || []).map((t) => `<span class="route-tag">${escapeHtml(t)}</span>`).join("")}</div>
        <div class="route-summary">${escapeHtml(r.summary || "")}</div>
        <div class="route-stats">
          <span><strong>${isMetric() ? r.distance_km.toFixed(1) + " km" : distMi.toFixed(distMi < 10 ? 1 : 0) + " mi"}</strong></span>
          <span><strong>${isMetric() ? Math.round(r.elevation_ft / 3.28084) + " m" : r.elevation_ft + " ft"}</strong> elev</span>
          ${r.rating ? `<span style="color:var(--gold);">★ ${r.rating}</span>` : ""}
        </div>
        <div class="route-rating-stars editable" data-route-id="${r.id}">${stars}</div>
      </div>
    `;
    // Clicking the card opens detail. Clicking a star handles rating.
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-star]")) {
        const star = e.target.closest("[data-star]");
        const v = parseInt(star.dataset.star, 10);
        routeRatings[r.id] = v;
        PaceDB.putMeta("routeRatings", routeRatings);
        renderRoutes();
        checkAchievements({ ratingsGiven: Object.keys(routeRatings).length });
        return;
      }
      openRouteDetail(r.id);
    });
    return el;
  }

  function routeAttemptsFor(routeId) {
    const attempts = activities
      .filter((a) => a.followingRouteId === routeId && (a.elapsedMs || 0) > 0)
      .sort((a, b) => (b.startedAt || b.endedAt || 0) - (a.startedAt || a.endedAt || 0));
    if (!attempts.length) return { count: 0 };
    let bestMs = Infinity, bestId = null, total = 0;
    attempts.forEach((a) => {
      total += a.elapsedMs;
      if (a.elapsedMs < bestMs) { bestMs = a.elapsedMs; bestId = a.id; }
    });
    return {
      count: attempts.length,
      bestSec: bestMs / 1000,
      avgSec: total / attempts.length / 1000,
      lastAt: attempts[0].startedAt || attempts[0].endedAt || Date.now(),
      bestId,
      recent: attempts.slice(0, 5),
    };
  }

  function ratingStars(value) {
    let html = "";
    for (let i = 1; i <= 5; i++) {
      const filled = i <= value;
      html += `<span data-star="${i}" style="cursor:pointer;color:${filled ? "var(--gold)" : "var(--text-dim)"};">${filled ? "★" : "☆"}</span>`;
    }
    return html;
  }

  // Open a route's full-page detail (curated or personal)
  async function openRouteDetail(routeId) {
    const r = [...routes, ...personalRoutes].find((x) => x.id === routeId);
    if (!r) return;
    const overlay = document.getElementById("detail-overlay");
    const title = document.getElementById("detail-title");
    const body = document.getElementById("detail-body");
    title.textContent = r.name;
    document.getElementById("detail-delete").style.display = "none";
    overlay.dataset.routeId = r.id;
    const stats = routeAttemptsFor(r.id);
    const kindColorCss = KIND_PIN_COLORS[r.kind] || "#38bdf8";
    const distMi = r.distance_km * 0.621371;
    const photoSlides = (r.photoUrls || []).map((p) =>
      `<div class="media-slide"><img class="media-img" src="${escapeHtml(p)}" alt="" loading="lazy" /></div>`
    ).join("");
    const slideCount = 1 + (r.photoUrls?.length || 0);
    const isPersonal = !!r.personal;
    body.innerHTML = `
      <div class="media-carousel" id="route-media-carousel">
        <div class="media-slide media-map-slide"><div class="detail-map" id="route-detail-map"></div></div>
        ${photoSlides}
      </div>
      ${slideCount > 1 ? `<div class="media-dots" id="route-media-dots">${Array.from({length: slideCount}).map((_, i) => `<span class="media-dot ${i === 0 ? "active" : ""}"></span>`).join("")}</div>` : `<div style="height:6px;"></div>`}
      <div class="route-detail-pad">
        <div class="route-detail-head">
          <div class="act-icon ${r.kind}">${kindIcon(r.kind)}</div>
          <div style="flex:1;min-width:0;">
            <div class="route-detail-name">${escapeHtml(r.name)}</div>
            <div class="route-detail-region">${kindLabel(r.kind)} · ${escapeHtml(r.region || "")}</div>
          </div>
          ${r.rating ? `<div class="route-detail-rating">${"★".repeat(Math.round(r.rating))}${"☆".repeat(5 - Math.round(r.rating))}</div>` : ""}
        </div>
        <div class="detail-stat-grid">
          <div class="detail-stat"><div class="detail-stat-label">Distance</div><div class="detail-stat-val">${isMetric() ? `${r.distance_km.toFixed(1)} km` : `${distMi.toFixed(distMi < 10 ? 1 : 0)} mi`}</div></div>
          <div class="detail-stat"><div class="detail-stat-label">Elevation</div><div class="detail-stat-val">${isMetric() ? `${Math.round(r.elevation_ft / 3.28084)} m` : `${r.elevation_ft} ft`}</div></div>
          <div class="detail-stat"><div class="detail-stat-label">Best</div><div class="detail-stat-val">${stats.count ? formatDuration(stats.bestSec) : "—"}</div></div>
          <div class="detail-stat"><div class="detail-stat-label">Tries</div><div class="detail-stat-val">${stats.count || "—"}</div></div>
        </div>
        ${r.summary ? `<div class="detail-section">
          <h4>About</h4>
          <p style="font-size:14px;line-height:1.55;color:var(--text);">${escapeHtml(r.summary)}</p>
          ${r.best_time ? `<p style="font-size:13px;color:var(--text-dim);margin-top:6px;">Best time of day: ${escapeHtml(r.best_time)}</p>` : ""}
        </div>` : ""}
        ${r.tags && r.tags.length ? `<div class="detail-section">
          <div class="route-tags">${r.tags.map((t) => `<span class="route-tag">${escapeHtml(t)}</span>`).join("")}</div>
        </div>` : ""}
        <div class="detail-section">
          <h4>Photos</h4>
          <div class="detail-photos" id="route-detail-photos">
            ${(r.photoUrls || []).map((p, i) => `<img class="detail-photo" src="${escapeHtml(p)}" data-rphoto-idx="${i}" alt="" />`).join("")}
            ${isPersonal ? `<label class="add-photo-btn" for="add-route-photo">+</label><input type="file" id="add-route-photo" accept="image/*" capture="environment" style="display:none;" />` : ""}
          </div>
          ${!isPersonal && !(r.photoUrls?.length) ? `<p style="font-size:12px;color:var(--text-dim);">No photos for this curated route yet.</p>` : ""}
        </div>
        <div class="detail-section">
          <h4>Your times</h4>
          ${stats.count ? `
            <div class="route-attempts-list">${stats.recent.map((a, i) => `
              <button class="route-attempt-row" data-act-id="${a.id}">
                <span class="ra-idx">#${stats.count - i}</span>
                <span class="ra-time ${a.id === stats.bestId ? "best" : ""}">${formatDuration(a.elapsedMs / 1000)}${a.id === stats.bestId ? " · PR" : ""}</span>
                <span class="ra-when">${timeAgo(a.startedAt || a.endedAt || Date.now())}</span>
              </button>`).join("")}</div>
          ` : `<div class="empty-state" style="padding:14px;font-size:13px;">No attempts yet. Hit start to begin timing.</div>`}
        </div>
        <div class="detail-section">
          <div class="route-rating-stars editable" data-route-id="${r.id}">${ratingStars(routeRatings[r.id] || 0)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">Your rating</div>
        </div>
        <div class="route-actions" style="margin-top:0;">
          <button class="btn-primary" id="route-detail-start" style="background:${kindColorCss};border-color:${kindColorCss};">▶ ${r.kind === "drive" || r.kind === "offroad" ? "Time this " + kindLabel(r.kind).toLowerCase() : "Start tracking"}</button>
        </div>
      </div>
    `;
    body.querySelectorAll("[data-act-id]").forEach((b) => {
      b.addEventListener("click", () => {
        closeDetail();
        setTimeout(() => openActivityDetail(b.dataset.actId), 200);
      });
    });
    body.querySelectorAll(".route-rating-stars [data-star]").forEach((s) => {
      s.addEventListener("click", () => {
        const v = parseInt(s.dataset.star, 10);
        routeRatings[r.id] = v;
        PaceDB.putMeta("routeRatings", routeRatings);
        openRouteDetail(r.id); // re-render
        checkAchievements({ ratingsGiven: Object.keys(routeRatings).length });
      });
    });
    if (isPersonal) {
      document.getElementById("add-route-photo")?.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const dataUrl = await resizeImageToDataUrl(file, 1200);
        r.photoUrls = r.photoUrls || [];
        r.photoUrls.push(dataUrl);
        const idx = personalRoutes.findIndex((x) => x.id === r.id);
        if (idx >= 0) personalRoutes[idx] = r;
        await PaceDB.putMeta("personalRoutes", personalRoutes);
        openRouteDetail(r.id); // re-render
      });
    }
    document.getElementById("route-detail-start").addEventListener("click", () => {
      closeDetail();
      startLive(r.kind, { routeId: r.id });
    });
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    // Init route map and draw polyline along the road
    setTimeout(async () => {
      const m = L.map("route-detail-map", { zoomControl: true, attributionControl: true });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19, attribution: "© OSM · CARTO" }).addTo(m);
      const coords = await getRouteLineCoords(r);
      if (coords.length > 1) {
        const line = L.polyline(coords, { color: kindColorCss, weight: 5, opacity: 0.92, lineJoin: "round", lineCap: "round" }).addTo(m);
        L.circleMarker(coords[0], { radius: 6, color: "#fff", fillColor: "#22c55e", fillOpacity: 1, weight: 2 }).addTo(m);
        L.circleMarker(coords[coords.length - 1], { radius: 6, color: "#fff", fillColor: "#ef4444", fillOpacity: 1, weight: 2 }).addTo(m);
        m.fitBounds(line.getBounds(), { padding: [30, 30] });
      } else {
        m.setView([r.start.lat, r.start.lon], 14);
        L.circleMarker([r.start.lat, r.start.lon], { radius: 8, color: "#fff", fillColor: kindColorCss, fillOpacity: 1, weight: 3 }).addTo(m);
      }
      // Wire carousel dots
      const car = document.getElementById("route-media-carousel");
      const dotsEl = document.getElementById("route-media-dots");
      if (car && dotsEl) {
        car.addEventListener("scroll", () => {
          const w = car.clientWidth;
          const idx = Math.round(car.scrollLeft / Math.max(1, w));
          dotsEl.querySelectorAll(".media-dot").forEach((d, i) => d.classList.toggle("active", i === idx));
          if (idx === 0) setTimeout(() => m.invalidateSize(), 80);
        });
        dotsEl.querySelectorAll(".media-dot").forEach((dot, i) => {
          dot.addEventListener("click", () => car.scrollTo({ left: i * car.clientWidth, behavior: "smooth" }));
        });
      }
    }, 80);
  }

  // ─── History view ───────────────────────────────────────────
  let historyFilter = "all";
  let historySearchQuery = "";
  function wireHistory() {
    document.querySelectorAll("#history-filter .filter-chip").forEach((c) => {
      c.addEventListener("click", () => {
        document.querySelectorAll("#history-filter .filter-chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        historyFilter = c.dataset.histKind;
        renderHistory();
      });
    });
    const search = document.getElementById("history-search");
    if (search) {
      search.addEventListener("input", debounce(() => {
        historySearchQuery = search.value.trim().toLowerCase();
        renderHistory();
      }, 200));
    }
  }
  function renderHistory() {
    const list = document.getElementById("history-list");
    const empty = document.getElementById("history-empty");
    list.innerHTML = "";
    let filtered = historyFilter === "all" ? activities : activities.filter((a) => a.kind === historyFilter);
    if (historySearchQuery) {
      filtered = filtered.filter((a) => {
        const hay = `${activityName(a)} ${a.notes || ""} ${(a.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(historySearchQuery);
      });
    }
    if (!filtered.length) {
      empty.style.display = "block";
      document.getElementById("history-stats").innerHTML = "";
      return;
    }
    empty.style.display = "none";

    // Stats strip
    const totalKm = filtered.reduce((s, a) => s + (a.distanceKm || 0), 0);
    const totalSec = filtered.reduce((s, a) => s + (a.elapsedMs || 0), 0) / 1000;
    document.getElementById("history-stats").innerHTML = `
      <div class="stat-block"><span class="stat-block-val">${filtered.length}</span><span class="stat-block-lbl">activities</span></div>
      <div class="stat-block"><span class="stat-block-val">${(totalKm * 0.621371).toFixed(1)}</span><span class="stat-block-lbl">total mi</span></div>
      <div class="stat-block"><span class="stat-block-val">${formatDuration(totalSec)}</span><span class="stat-block-lbl">total time</span></div>
    `;

    filtered.forEach((a) => list.appendChild(activityCardEl(a)));
  }

  function activityCardEl(a) {
    const el = document.createElement("div");
    el.className = "act-card";
    const photoThumb = a.photos && a.photos[0]
      ? `<img class="act-photo-thumb" src="${a.photos[0]}" alt="" />`
      : "";
    el.innerHTML = `
      <div class="act-icon ${a.kind}">${kindIcon(a.kind)}</div>
      <div class="act-info">
        <div class="act-title">${escapeHtml(activityName(a))}</div>
        <div class="act-stats">
          <span><strong>${formatDistance(a.distanceKm)}</strong></span>
          <span><strong>${formatDuration(a.elapsedMs / 1000)}</strong></span>
          <span>${formatPace(a)}</span>
          <span style="color:var(--text-dim);">${relativeTime(a.startTs)}</span>
        </div>
      </div>
      ${photoThumb}
    `;
    el.addEventListener("click", () => openActivityDetail(a.id));
    return el;
  }

  function activityName(a) {
    if (a.followingRouteId) {
      const r = routes.find((x) => x.id === a.followingRouteId);
      if (r) return r.name;
    }
    if (a.coachWorkoutId) {
      const w = workouts.find((x) => x.id === a.coachWorkoutId);
      if (w) return w.name;
    }
    const date = new Date(a.startTs);
    return `${kindLabel(a.kind)} · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }

  // ─── Profile view ───────────────────────────────────────────
  function wireProfile() {
    document.getElementById("profile-name").addEventListener("input", async (e) => {
      profile.name = e.target.value.trim();
      await PaceDB.putMeta("profile", profile);
    });
    const wireField = (id, key, parseFn = parseFloat) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", debounce(async () => {
        const v = parseFn(el.value);
        profile[key] = isFinite(v) && v > 0 ? v : null;
        await PaceDB.putMeta("profile", profile);
      }, 300));
    };
    // Weight & height: input value is in the user's current unit system, but
    // we always store internally in imperial (lbs, in).
    const wireWeight = () => {
      const el = document.getElementById("profile-weight-lbs");
      el?.addEventListener("input", debounce(async () => {
        const raw = parseFloat(el.value);
        if (!isFinite(raw) || raw <= 0) { profile.weightLbs = null; }
        else { profile.weightLbs = isMetric() ? raw * 2.2046 : raw; }
        await PaceDB.putMeta("profile", profile);
      }, 300));
    };
    const wireHeight = () => {
      const ft = document.getElementById("profile-height-ft");
      const inExtra = document.getElementById("profile-height-in-extra");
      const cm = document.getElementById("profile-height-cm");
      const saveImperial = debounce(async () => {
        const feet = parseFloat(ft?.value) || 0;
        const inches = parseFloat(inExtra?.value) || 0;
        const total = feet * 12 + inches;
        profile.heightIn = total > 0 ? total : null;
        await PaceDB.putMeta("profile", profile);
      }, 300);
      const saveMetric = debounce(async () => {
        const v = parseFloat(cm?.value);
        profile.heightIn = (isFinite(v) && v > 0) ? v / 2.54 : null;
        await PaceDB.putMeta("profile", profile);
      }, 300);
      ft?.addEventListener("input", saveImperial);
      inExtra?.addEventListener("input", saveImperial);
      cm?.addEventListener("input", saveMetric);
    };
    wireWeight();
    wireHeight();
    wireField("profile-age", "age", (v) => parseInt(v, 10));
    document.getElementById("export-btn").addEventListener("click", async () => {
      const data = await PaceDB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pacepost-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Exported", "success");
    });
    document.getElementById("import-btn").addEventListener("click", () => {
      document.getElementById("import-file").click();
    });
    document.getElementById("import-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await PaceDB.importAll(data, { merge: true });
        activities = await PaceDB.allActivities();
        unlockedBadges = new Set(await PaceDB.getMeta("unlockedBadges", []));
        routeRatings = (await PaceDB.getMeta("routeRatings", {})) || {};
        prs = (await PaceDB.getMeta("prs", {})) || {};
        renderAll();
        renderProfile();
        toast(`Imported ${data.activities?.length || 0} activities`, "success");
      } catch (err) {
        toast("Import failed: " + err.message, "error");
      }
      e.target.value = "";
    });
    document.getElementById("reset-btn").addEventListener("click", async () => {
      if (!confirm("Delete ALL local data — activities, badges, ratings? This can't be undone (export first if you want a backup).")) return;
      await PaceDB.clearAll();
      activities = [];
      unlockedBadges.clear();
      routeRatings = {};
      prs = {};
      profile = { name: "", joinedAt: Date.now(), muteCoach: false };
      renderAll();
      renderProfile();
      toast("Everything cleared", "success");
    });
  }
  function renderProfile() {
    syncSheetsUI();
    syncSettingsUI();
    syncProfileAvatar();
    const bio = document.getElementById("profile-bio"); if (bio) bio.value = profile.bio || "";
    const region = document.getElementById("profile-region"); if (region) region.value = profile.region || "";
    document.getElementById("profile-name").value = profile.name || "";
    syncProfileBodyInputs();
    document.getElementById("profile-age").value = profile.age || "";
    const totalKm = activities.reduce((s, a) => s + (a.distanceKm || 0), 0);
    const totalSec = activities.reduce((s, a) => s + (a.elapsedMs || 0), 0) / 1000;
    const totalElevFt = activities.reduce((s, a) => s + (a.elevationGainM || 0), 0) * 3.28084;
    const since = profile.joinedAt ? new Date(profile.joinedAt).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—";
    document.getElementById("profile-totals").innerHTML = `
      Member since ${since} · <strong>${activities.length}</strong> activities · <strong>${(totalKm * 0.621371).toFixed(0)}</strong> mi · <strong>${formatDuration(totalSec)}</strong> · <strong>${Math.round(totalElevFt)}</strong> ft climbed
    `;
    renderGoals();
    renderBadges();
    renderPRs();
    renderHeatmap();
  }

  function renderGoals() {
    const grid = document.getElementById("goals-grid");
    grid.innerHTML = "";
    const week = thisWeekActivities();
    const month = thisMonthActivities();
    const weekKm = week.reduce((s, a) => s + (a.distanceKm || 0), 0);
    const monthCount = month.length;
    const goals = [
      { label: "This week's miles", value: (weekKm * 0.621371).toFixed(1) + " mi", target: 20, current: weekKm * 0.621371 },
      { label: "This month's activities", value: monthCount, target: 12, current: monthCount },
      { label: "Current streak", value: currentStreak() + " days", target: 7, current: currentStreak() },
      { label: "Badges unlocked", value: unlockedBadges.size + " / " + achievementDefs.length, target: achievementDefs.length, current: unlockedBadges.size },
    ];
    goals.forEach((g) => {
      const card = document.createElement("div");
      card.className = "goal-card";
      const pct = Math.min(100, (g.current / g.target) * 100);
      card.innerHTML = `
        <div class="goal-label">${escapeHtml(g.label)}</div>
        <div class="goal-value">${escapeHtml(String(g.value))}</div>
        <div class="goal-bar"><div class="goal-bar-fill" style="width:${pct}%;"></div></div>
      `;
      grid.appendChild(card);
    });
  }

  function renderBadges() {
    const grid = document.getElementById("badges-grid");
    grid.innerHTML = "";
    achievementDefs.forEach((d) => grid.appendChild(badgeEl(d, unlockedBadges.has(d.id))));
    document.getElementById("badges-progress").textContent = `${unlockedBadges.size} / ${achievementDefs.length}`;
  }
  function badgeEl(def, unlocked) {
    const el = document.createElement("div");
    el.className = `badge tier-${def.tier} ${unlocked ? "" : "locked"}`;
    el.innerHTML = `
      <div class="badge-icon">${def.icon}</div>
      <div class="badge-name">${escapeHtml(def.name)}</div>
    `;
    el.title = def.description + (unlocked ? "" : " (locked)");
    return el;
  }

  function renderPRs() {
    const list = document.getElementById("prs-list");
    list.innerHTML = "";
    const distances = [
      { key: "1k", label: "1 km", km: 1 },
      { key: "1mi", label: "1 mile", km: 1.609 },
      { key: "5k", label: "5 km", km: 5 },
      { key: "10k", label: "10 km", km: 10 },
    ];
    distances.forEach((d) => {
      const pr = prs["run_" + d.key];
      const row = document.createElement("div");
      row.className = "pr-row";
      row.innerHTML = `
        <div>
          <div class="pr-name">Run · ${d.label}</div>
          <div class="pr-pace">${pr ? formatPaceFor(pr.time_sec, d.km) : "—"}</div>
        </div>
        <div class="pr-time">${pr ? formatDuration(pr.time_sec) : "—"}</div>
      `;
      list.appendChild(row);
    });
  }

  function renderHeatmap() {
    const el = document.getElementById("heatmap");
    el.innerHTML = "";
    const m = L.map(el, { zoomControl: false, attributionControl: false });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 17 }).addTo(m);
    const allPts = [];
    activities.forEach((a) => {
      (a.points || []).forEach((p) => allPts.push([p.lat, p.lon, 0.6]));
    });
    if (allPts.length) {
      L.heatLayer(allPts, { radius: 14, blur: 18, maxZoom: 13 }).addTo(m);
      m.fitBounds(allPts.map((p) => [p[0], p[1]]), { padding: [20, 20] });
    } else {
      m.setView([37.8, -122.2], 9);
    }
  }

  // ─── Live tracker overlay ──────────────────────────────────
  function wireLiveControls() {
    document.getElementById("live-pause").addEventListener("click", togglePause);
    document.getElementById("live-finish").addEventListener("click", finishLive);
    document.getElementById("live-cancel").addEventListener("click", cancelLive);
    document.getElementById("indoor-rep-plus")?.addEventListener("click", () => {
      indoorRepCount++;
      document.getElementById("indoor-rep-count").textContent = indoorRepCount;
    });
    document.getElementById("indoor-rep-minus")?.addEventListener("click", () => {
      indoorRepCount = Math.max(0, indoorRepCount - 1);
      document.getElementById("indoor-rep-count").textContent = indoorRepCount;
    });
    document.getElementById("live-scorecard-btn")?.addEventListener("click", openGolfFlow);
    document.getElementById("live-mute").addEventListener("click", () => {
      profile.muteCoach = !profile.muteCoach;
      PaceDB.putMeta("profile", profile);
      document.getElementById("live-mute").textContent = profile.muteCoach ? "—" : "♪";
      toast(profile.muteCoach ? "Audio muted" : "Audio on", "success");
    });
  }

  function startLive(kind, options = {}) {
    const needsGps = kindNeedsGps(kind);
    if (needsGps && !navigator.geolocation) {
      toast("Geolocation not supported in this browser", "error");
      return;
    }
    activityForCoach = options;
    tracker = new PaceTracker();
    tracker.on("tick", onTick);
    tracker.on("fix", onFix);
    tracker.start(kind, { ...options, needsGps });

    const overlay = document.getElementById("live-overlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    overlay.classList.toggle("indoor", !needsGps);
    document.getElementById("live-kind").textContent = kindLabel(kind);
    document.getElementById("live-mute").textContent = profile.muteCoach ? "—" : "♪";
    document.getElementById("live-pause").textContent = "Pause";
    document.getElementById("live-pause").classList.remove("paused");
    document.getElementById("coach-strip").style.display = "none";
    document.getElementById("indoor-rep-count")?.replaceChildren();
    indoorRepCount = 0;
    const repBadge = document.getElementById("indoor-rep-count");
    if (repBadge) repBadge.textContent = "0";

    // Init the live map only if we need GPS
    if (needsGps) setTimeout(initLiveMap, 80);
    else if (liveMap) { liveMap.remove(); liveMap = null; liveTrack = null; liveStartMarker = null; }

    // Golf: show scorecard button + reset draft
    const scBtn = document.getElementById("live-scorecard-btn");
    if (scBtn) {
      if (kind === "golf") {
        scBtn.style.display = "";
        golfRoundDraft = null;
        golfRoundStartedAt = Date.now();
      } else {
        scBtn.style.display = "none";
      }
    }

    // If a coached workout is bundled with this start, kick off the coach
    if (options.coachWorkoutId) {
      const w = workouts.find((x) => x.id === options.coachWorkoutId);
      if (w) startCoachEngine(w);
    }
  }
  let indoorRepCount = 0;

  function startCoachedWorkout(workoutId) {
    const w = workouts.find((x) => x.id === workoutId);
    if (!w) return;
    startLive(w.activityKind, { coachWorkoutId: w.id });
  }

  function initLiveMap() {
    if (liveMap) {
      liveMap.remove();
      liveMap = null;
    }
    liveMap = L.map("live-map", { zoomControl: false, attributionControl: false }).setView([37.8, -122.2], 13);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(liveMap);
    liveTrack = L.polyline([], { color: kindColor(tracker.kind), weight: 5, opacity: 0.95, lineJoin: "round", lineCap: "round" }).addTo(liveMap);
  }

  function onFix(fix) {
    if (!liveMap || !liveTrack) return;
    liveTrack.addLatLng([fix.lat, fix.lon]);
    if (!liveStartMarker) {
      liveStartMarker = L.circleMarker([fix.lat, fix.lon], { radius: 6, color: "#fff", fillColor: kindColor(tracker.kind), fillOpacity: 1, weight: 2 }).addTo(liveMap);
    }
    liveMap.setView([fix.lat, fix.lon], Math.max(liveMap.getZoom(), 15));
  }

  function onTick(state) {
    const tStr = formatDuration(state.elapsedMs / 1000);
    document.getElementById("live-time").textContent = tStr;
    const indoorT = document.getElementById("live-time-indoor"); if (indoorT) indoorT.textContent = tStr;
    if (!tracker.needsGps) {
      // Indoor mode — show running calorie estimate based on MET × kg × hours
      const kg = profile.weightLbs ? profile.weightLbs / 2.2046 : 70;
      const hours = state.elapsedMs / 3600000;
      const met = kindMET(tracker.kind);
      const cal = Math.round(met * kg * hours);
      const calEl = document.getElementById("live-cal-indoor");
      if (calEl) calEl.textContent = `${cal} cal`;
    } else {
      document.getElementById("live-distance").textContent = formatDistance(state.distanceKm);
      const pace = tracker.recentPaceSecPerKm(60000);
      if (pace && pace < 600) {
        document.getElementById("live-pace").textContent = isMetric()
          ? formatPaceSecPerUnit(pace, "/km")
          : formatPaceSecPerMi(pace * 1.609);
      } else {
        document.getElementById("live-pace").textContent = "—";
      }
      const hours = state.elapsedMs / 3600000;
      if (state.elapsedMs > 5000 && state.distanceKm > 0) {
        document.getElementById("live-speed").textContent = isMetric()
          ? (state.distanceKm / Math.max(0.001, hours)).toFixed(1) + " km/h"
          : ((state.distanceKm * 0.621371) / Math.max(0.001, hours)).toFixed(1) + " mph";
      }
    }
    if (coachState) advanceCoachIfNeeded(state);
  }

  function togglePause() {
    if (!tracker) return;
    if (tracker.paused) {
      tracker.resume();
      document.getElementById("live-pause").textContent = "Pause";
      document.getElementById("live-pause").classList.remove("paused");
    } else {
      tracker.pause();
      document.getElementById("live-pause").textContent = "Resume";
      document.getElementById("live-pause").classList.add("paused");
    }
  }

  async function finishLive() {
    if (!tracker) return;
    if (tracker.distanceKm < 0.05 && tracker._activeElapsedMs() < 30000) {
      if (!confirm("Discard this short activity?")) return;
      cancelLive();
      return;
    }
    const act = tracker.finish();
    // Attach context (route / coach / reps / golf scorecard)
    if (activityForCoach?.routeId) act.followingRouteId = activityForCoach.routeId;
    if (!tracker.needsGps && indoorRepCount > 0) act.reps = indoorRepCount;
    if (act.kind === "golf" && golfRoundDraft) {
      const totals = scorecardTotals(golfRoundDraft);
      if (totals.holesPlayed > 0) act.golf = golfDataFromDraft(golfRoundDraft, totals);
    }
    if (activityForCoach?.coachWorkoutId) act.coachWorkoutId = activityForCoach.coachWorkoutId;

    // Compute estimated calories from MET × weight × hours
    act.calories = estimateCalories(act);

    // Ask the user how hard it felt — RPE 1-10. They can skip.
    closeLive();
    const rpe = await promptEffort();
    if (rpe != null) act.rpe = rpe;

    // Fetch a weather snapshot in the background (doesn't block save)
    fetchWeatherFor(act).then(async (w) => {
      if (w) {
        act.weather = w;
        await PaceDB.putActivity(act);
      }
    });

    await PaceDB.putActivity(act);
    publishActivityToCloud(act).catch(() => {});
    pushToSheets(act).catch(() => {});
    activities = await PaceDB.allActivities();
    // Update PRs + check achievements
    const prUpdates = updatePRsFor(act);
    const newlyUnlocked = checkAchievements({ ratingsGiven: Object.keys(routeRatings).length, prsBroken: prUpdates });
    renderAll();
    speakAndToast(`${kindLabel(act.kind)} saved · ${formatDistance(act.distanceKm)} · ${formatDuration(act.elapsedMs / 1000)}`, "success");
    newlyUnlocked.forEach((d) => speakAndToast(`Unlocked: ${d.icon} ${d.name}`, "achievement"));
    setTimeout(() => openActivityDetail(act.id), 600);
  }

  // ─── Effort prompt (RPE 1-10) ────────────────────────────────
  function promptEffort() {
    return new Promise((resolve) => {
      const overlay = document.getElementById("effort-overlay");
      const grid = document.getElementById("effort-grid");
      const skip = document.getElementById("effort-skip");
      const save = document.getElementById("effort-save");
      const hint = document.getElementById("effort-hint");
      let chosen = null;
      const labels = { 1: "Very easy", 2: "Easy", 3: "Moderate", 4: "Somewhat hard", 5: "Hard", 6: "Hard+", 7: "Very hard", 8: "Very hard+", 9: "Extreme", 10: "Max effort" };
      grid.innerHTML = "";
      for (let i = 1; i <= 10; i++) {
        const cell = document.createElement("button");
        cell.className = "effort-cell";
        cell.dataset.rpe = i;
        cell.textContent = i;
        cell.addEventListener("click", () => {
          chosen = i;
          grid.querySelectorAll(".effort-cell").forEach((c) => c.classList.toggle("selected", c.dataset.rpe == i));
          hint.textContent = labels[i];
          save.style.display = "inline-block";
        });
        grid.appendChild(cell);
      }
      const cleanup = () => {
        overlay.classList.remove("open");
        overlay.setAttribute("aria-hidden", "true");
        skip.removeEventListener("click", onSkip);
        save.removeEventListener("click", onSave);
      };
      const onSkip = () => { cleanup(); resolve(null); };
      const onSave = () => { cleanup(); resolve(chosen); };
      skip.addEventListener("click", onSkip);
      save.addEventListener("click", onSave);
      save.style.display = "none";
      hint.textContent = "Tap a number — or skip.";
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
    });
  }

  // ─── Calorie estimate (Compendium-of-Physical-Activities MET formula) ──
  function estimateCalories(act) {
    if (!profile.weightLbs) return null;
    const kg = profile.weightLbs / 2.2046;
    const hours = (act.elapsedMs || 0) / 3600000;
    if (hours <= 0) return null;
    const speedMph = (act.distanceKm * 0.621371) / hours;
    const met = kindMET(act.kind, speedMph);
    return Math.round(met * kg * hours);
  }

  // ─── Weather snapshot via open-meteo (free, no API key) ────────
  async function fetchWeatherFor(act) {
    if (!act.points || !act.points.length) return null;
    const start = act.points[0];
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${start.lat.toFixed(3)}&longitude=${start.lon.toFixed(3)}&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      const c = j.current || {};
      return {
        tempF: c.temperature_2m,
        windMph: c.wind_speed_10m,
        weatherCode: c.weather_code,
        capturedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  function weatherEmoji(code) {
    if (code == null) return "";
    if (code === 0) return "Clear";
    if (code <= 3) return "Cloudy";
    if (code <= 48) return "Fog";
    if (code <= 57) return "Drizzle";
    if (code <= 67) return "Rain";
    if (code <= 77) return "Snow";
    if (code <= 82) return "Rain";
    if (code <= 86) return "Snow";
    return "Storm";
  }

  function cancelLive() {
    if (tracker) tracker.finish();
    closeLive();
  }

  function closeLive() {
    document.getElementById("live-overlay").classList.remove("open");
    document.getElementById("live-overlay").setAttribute("aria-hidden", "true");
    if (liveMap) {
      liveMap.remove();
      liveMap = null;
    }
    liveTrack = null;
    liveStartMarker = null;
    liveEndMarker = null;
    tracker = null;
    coachState = null;
    activityForCoach = null;
  }

  // ─── Coach engine (HIIT timer + audio cues) ─────────────────
  function startCoachEngine(workout) {
    coachState = { workout, stepIndex: 0, stepStartMs: Date.now(), pausedAtStepRemaining: null };
    document.getElementById("coach-strip").style.display = "block";
    speak(`Starting ${workout.name}. ${workout.steps[0].label}.`);
    updateCoachUI();
  }

  function advanceCoachIfNeeded(state) {
    if (!coachState) return;
    if (tracker && tracker.paused) return;
    const { workout, stepIndex, stepStartMs } = coachState;
    if (stepIndex >= workout.steps.length) return;
    const step = workout.steps[stepIndex];
    const elapsedMs = Date.now() - stepStartMs;
    const remaining = step.seconds * 1000 - elapsedMs;
    // 3-2-1 audio countdown
    const remSec = Math.ceil(remaining / 1000);
    if (remSec > 0 && remSec <= 3 && coachState.lastBeepAt !== remSec) {
      coachState.lastBeepAt = remSec;
      beep();
    }
    if (remaining <= 0) {
      // Move to next step
      coachState.stepIndex++;
      coachState.stepStartMs = Date.now();
      coachState.lastBeepAt = null;
      const next = workout.steps[coachState.stepIndex];
      if (next) {
        speak(next.label);
        beep(true);
      } else {
        speak("Workout complete. Great job.");
        beep(true);
        setTimeout(() => beep(true), 250);
        coachState = null;
        document.getElementById("coach-strip").style.display = "none";
        return;
      }
    }
    updateCoachUI();
  }

  function updateCoachUI() {
    if (!coachState) return;
    const { workout, stepIndex, stepStartMs } = coachState;
    const step = workout.steps[stepIndex];
    if (!step) return;
    document.getElementById("coach-step-label").textContent = step.label;
    const elapsedMs = Date.now() - stepStartMs;
    const remaining = Math.max(0, step.seconds * 1000 - elapsedMs);
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    document.getElementById("coach-step-time").textContent = `${m}:${String(s).padStart(2, "0")}`;
    const pct = Math.min(100, (elapsedMs / (step.seconds * 1000)) * 100);
    document.getElementById("coach-progress-fill").style.width = pct + "%";
    const next = workout.steps[stepIndex + 1];
    document.getElementById("coach-next").textContent = next ? `Next: ${next.label} (${next.seconds}s)` : "Last step!";
  }

  // ─── Audio cues ────────────────────────────────────────────
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
    return audioCtx;
  }
  function beep(end = false) {
    if (profile.muteCoach) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = "sine";
    o.frequency.value = end ? 880 : 660;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.start();
    o.stop(ctx.currentTime + 0.26);
  }
  function speak(text) {
    if (profile.muteCoach) return;
    if (!("speechSynthesis" in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.pitch = 1.0;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {}
  }

  // ─── Activity detail modal ────────────────────────────────
  let detailMap = null;
  function wireDetailModal() {
    document.getElementById("detail-close").addEventListener("click", closeDetail);
    document.getElementById("detail-overlay").addEventListener("click", (e) => {
      if (e.target.id === "detail-overlay") closeDetail();
    });
    document.getElementById("detail-delete").addEventListener("click", async () => {
      const id = document.getElementById("detail-overlay").dataset.activityId;
      if (!id) return;
      if (!confirm("Delete this activity?")) return;
      await PaceDB.deleteActivity(id);
      activities = await PaceDB.allActivities();
      closeDetail();
      renderAll();
    });
  }
  function closeDetail() {
    const overlay = document.getElementById("detail-overlay");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    overlay.dataset.activityId = "";
    if (detailMap) {
      detailMap.remove();
      detailMap = null;
    }
  }
  function openActivityDetail(id) {
    const a = activities.find((x) => x.id === id);
    if (!a) return;
    const overlay = document.getElementById("detail-overlay");
    overlay.dataset.activityId = id;
    document.getElementById("detail-title").textContent = activityName(a);
    document.getElementById("detail-delete").style.display = "";
    const elev = (a.elevationGainM || 0) * 3.28084;
    const speedMph = (a.distanceKm / Math.max(0.001, a.elapsedMs / 3600000)) * 0.621371;
    const caloriesTxt = a.calories ? `${a.calories}` : "—";
    const rpeTxt = a.rpe ? `${a.rpe}/10` : "—";
    const weatherTxt = a.weather && a.weather.tempF != null
      ? `${weatherEmoji(a.weather.weatherCode)} ${Math.round(a.weather.tempF)}°F · ${Math.round(a.weather.windMph)} mph wind`
      : "—";
    const photosHtml = (a.photos || []).map((p, i) =>
      `<img class="detail-photo" data-photo-idx="${i}" src="${p}" alt="" />`
    ).join("");
    const splitsHtml = (a.splits || []).length
      ? `<div class="detail-section"><h4>Splits</h4>${renderSplitsHtml(a.splits)}</div>`
      : "";
    const ratedHtml = a.followingRouteId
      ? `<div class="detail-section"><h4>Rate this route</h4><div class="route-rating-stars editable" data-route-id="${a.followingRouteId}">${ratingStars(routeRatings[a.followingRouteId] || 0)}</div></div>`
      : "";
    const photoSlides = (a.photos || []).map((p, i) =>
      `<div class="media-slide"><img class="media-img" src="${p}" data-photo-idx="${i}" alt="" /></div>`
    ).join("");
    const hasMap = kindNeedsGps(a.kind) && (a.gpsTrack?.length || a.startedAt);
    const slidesHtml = `${hasMap ? `<div class="media-slide media-map-slide"><div class="detail-map" id="detail-map"></div></div>` : ""}${photoSlides}`;
    const slideCount = (hasMap ? 1 : 0) + (a.photos?.length || 0);
    document.getElementById("detail-body").innerHTML = `
      ${slideCount > 0 ? `
      <div class="media-carousel" id="detail-media-carousel">
        ${slidesHtml}
      </div>
      ${slideCount > 1 ? `<div class="media-dots" id="detail-media-dots">${Array.from({length: slideCount}).map((_, i) => `<span class="media-dot ${i === 0 ? "active" : ""}"></span>`).join("")}</div>` : ""}
      ` : ""}
      <div class="detail-stat-grid">
        <div class="detail-stat"><div class="detail-stat-label">Distance</div><div class="detail-stat-val">${formatDistance(a.distanceKm)}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Time</div><div class="detail-stat-val">${formatDuration(a.elapsedMs / 1000)}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">${a.kind === "drive" ? "Avg speed" : "Pace"}</div><div class="detail-stat-val">${a.kind === "drive" ? speedMph.toFixed(1) + " mph" : formatPace(a)}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Elevation</div><div class="detail-stat-val">${Math.round(elev)} ft</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Calories</div><div class="detail-stat-val">${caloriesTxt}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Effort</div><div class="detail-stat-val">${rpeTxt}</div></div>
        <div class="detail-stat" style="grid-column:span 2;"><div class="detail-stat-label">Weather at start</div><div class="detail-stat-val" style="font-size:14px;">${weatherTxt}</div></div>
      </div>
      <div class="detail-section"><h4>Notes</h4>
        <textarea class="detail-notes" id="detail-notes" placeholder="How did it feel?">${escapeHtml(a.notes || "")}</textarea>
      </div>
      <div class="detail-section"><h4>Add a photo</h4>
        <div class="detail-photos" id="detail-photos">
          <label class="add-photo-btn" for="add-photo-input">+</label>
          <input type="file" id="add-photo-input" accept="image/*" capture="environment" style="display:none;" />
        </div>
      </div>
      ${splitsHtml}
      ${ratedHtml}
      ${golfDetailHtml(a)}
      ${a.cloudId ? `
      <div class="detail-section social-section">
        <div class="social-row">
          <button class="like-btn" id="like-btn" data-liked="false">♡ <span id="like-count">0</span></button>
          <span class="social-meta" id="comment-count">0 comments</span>
        </div>
        <div id="comments-list" class="comments-list"></div>
        <div class="comment-input-row">
          <input type="text" id="comment-input" placeholder="Add a comment…" maxlength="500" />
          <button class="btn-primary" id="comment-send">Send</button>
        </div>
      </div>` : (window.Cloud && window.Cloud.isReady && !window.Cloud.user ? `
      <div class="detail-section social-section">
        <div class="empty-state" style="padding:18px;font-size:13px;">Sign in to post this activity and let friends comment.</div>
      </div>` : "")}
    `;
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    setTimeout(() => initDetailMap(a), 80);
    wireDetailCarousel();
    if (a.cloudId && window.Cloud && window.Cloud.isReady) wireDetailSocial(a);

    // Notes save
    document.getElementById("detail-notes").addEventListener("input", debounce(async (e) => {
      a.notes = e.target.value;
      await PaceDB.putActivity(a);
    }, 400));

    // Photo upload
    document.getElementById("add-photo-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await fileToDataUrl(file, 1280);
      a.photos = a.photos || [];
      a.photos.push(dataUrl);
      await PaceDB.putActivity(a);
      activities = await PaceDB.allActivities();
      openActivityDetail(a.id); // re-render
      checkAchievements({});
    });

    // Photo tap → remove
    document.getElementById("detail-photos").addEventListener("click", async (e) => {
      const img = e.target.closest("[data-photo-idx]");
      if (!img) return;
      if (!confirm("Remove this photo?")) return;
      const idx = parseInt(img.dataset.photoIdx, 10);
      a.photos.splice(idx, 1);
      await PaceDB.putActivity(a);
      activities = await PaceDB.allActivities();
      openActivityDetail(a.id);
    });

    // Route star rating from inside detail
    document.querySelectorAll("#detail-body .route-rating-stars [data-star]").forEach((el) => {
      el.addEventListener("click", async () => {
        const v = parseInt(el.dataset.star, 10);
        const rid = a.followingRouteId;
        if (!rid) return;
        routeRatings[rid] = v;
        await PaceDB.putMeta("routeRatings", routeRatings);
        openActivityDetail(a.id);
        checkAchievements({ ratingsGiven: Object.keys(routeRatings).length });
      });
    });
  }

  function wireDetailCarousel() {
    const car = document.getElementById("detail-media-carousel");
    const dotsEl = document.getElementById("detail-media-dots");
    if (!car || !dotsEl) return;
    const slides = car.querySelectorAll(".media-slide");
    car.addEventListener("scroll", () => {
      const w = car.clientWidth;
      const idx = Math.round(car.scrollLeft / Math.max(1, w));
      dotsEl.querySelectorAll(".media-dot").forEach((d, i) => d.classList.toggle("active", i === idx));
      // Resize map when it scrolls into view
      if (idx === 0 && detailMap) setTimeout(() => detailMap.invalidateSize(), 80);
    });
    // Tap a dot → jump to that slide
    dotsEl.querySelectorAll(".media-dot").forEach((dot, i) => {
      dot.addEventListener("click", () => car.scrollTo({ left: i * car.clientWidth, behavior: "smooth" }));
    });
  }
  function initDetailMap(a) {
    detailMap = L.map("detail-map", { attributionControl: false }).setView([37.8, -122.2], 13);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(detailMap);
    if (a.points && a.points.length > 1) {
      const latlngs = a.points.map((p) => [p.lat, p.lon]);
      const trail = L.polyline(latlngs, { color: kindColor(a.kind), weight: 5, opacity: 0.95 }).addTo(detailMap);
      L.circleMarker(latlngs[0], { radius: 5, color: "#fff", fillColor: "#22c55e", fillOpacity: 1, weight: 2 }).addTo(detailMap);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 5, color: "#fff", fillColor: "#ef4444", fillOpacity: 1, weight: 2 }).addTo(detailMap);
      detailMap.fitBounds(trail.getBounds(), { padding: [20, 20] });
    } else if (a.points && a.points.length === 1) {
      detailMap.setView([a.points[0].lat, a.points[0].lon], 14);
    }
  }

  function renderSplitsHtml(splits) {
    if (!splits.length) return "";
    // Compute per-split pace
    let prevElapsedMs = 0;
    let fastestPace = Infinity;
    const enriched = splits.map((s) => {
      const dt = s.elapsedMs - prevElapsedMs;
      prevElapsedMs = s.elapsedMs;
      const paceSecPerKm = dt / 1000;
      if (paceSecPerKm < fastestPace) fastestPace = paceSecPerKm;
      return { ...s, paceSecPerKm, dtMs: dt };
    });
    return enriched.map((s) =>
      `<div class="split-row${s.paceSecPerKm === fastestPace ? " fastest" : ""}">
        <span>km ${s.km}</span>
        <span>${formatDuration(s.dtMs / 1000)} <span style="color:var(--text-dim);font-size:11px;">(${formatPaceSecPerMi(s.paceSecPerKm * 1.609)})</span></span>
      </div>`
    ).join("");
  }

  // ─── Install-as-app prompt + per-platform instructions ─────
  // Strategy:
  //   1. Hide the section if the page is already running standalone.
  //   2. On Chrome / Edge / Android: catch beforeinstallprompt, show a
  //      single "Install now" button that fires the native prompt.
  //   3. On iOS Safari: show step-by-step Add-to-Home-Screen instructions
  //      since iOS does not expose beforeinstallprompt.
  //   4. Fallback: show generic instructions.
  let deferredInstallPrompt = null;
  function wireInstallApp() {
    const section = document.getElementById("install-section");
    const btn = document.getElementById("install-btn");
    const blurb = document.getElementById("install-blurb");
    const list = document.getElementById("install-instructions");
    if (!section || !btn || !list) return;

    // If already installed (display-mode: standalone), bail out
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
                         window.navigator.standalone === true;
    if (isStandalone) return;

    section.style.display = "block";

    const ua = navigator.userAgent || "";
    const isIos = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const isFirefox = /Firefox\//i.test(ua);

    if (isIos) {
      blurb.textContent = "On iPhone / iPad you add it from Safari's share sheet:";
      list.innerHTML = `
        <li>Tap the <strong>Share</strong> button (the box with the up-arrow at the bottom of Safari).</li>
        <li>Scroll down and pick <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong> in the top right. Done — pacepost now lives on your home screen.</li>
      `;
      return;
    }

    if (isFirefox) {
      blurb.textContent = "Firefox doesn't yet support web-app install. Use Chrome, Edge, or Safari.";
      list.innerHTML = "";
      return;
    }

    // Chrome / Edge / Android Chrome: listen for the install event
    list.innerHTML = `
      <li>Tap <strong>Install now</strong> below — your browser will pop a confirm dialog.</li>
      <li>If no button appears, open the browser menu (⋮) and pick <strong>Install app</strong> or <strong>Add to home screen</strong>.</li>
    `;

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      btn.style.display = "inline-block";
    });
    btn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) {
        // Maybe already installed or browser dropped the event — show fallback
        toast("If your browser doesn't pop a dialog, use the menu → Install app", "");
        return;
      }
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === "accepted") {
        toast("Installed!", "success");
        section.style.display = "none";
      }
      deferredInstallPrompt = null;
      btn.style.display = "none";
    });
    window.addEventListener("appinstalled", () => {
      toast("pacepost is installed", "success");
      section.style.display = "none";
    });

    // Some Android browsers fire beforeinstallprompt right away; if it never
    // arrives within 1.5s assume the user is on an unsupported browser and
    // leave only the manual instructions.
    setTimeout(() => {
      if (!deferredInstallPrompt && !isStandalone) {
        // Button stays hidden — only the manual steps show.
      }
    }, 1500);
  }

  // ─── Achievements engine ───────────────────────────────────
  // Pure function: given activities + state, compute which badges should be
  // unlocked. Returns the newly-unlocked defs (if any) and persists state.
  function checkAchievements(context = {}) {
    const newly = [];
    for (const def of achievementDefs) {
      if (unlockedBadges.has(def.id)) continue;
      if (evalRule(def.rule, context)) {
        unlockedBadges.add(def.id);
        newly.push(def);
      }
    }
    if (newly.length) {
      PaceDB.putMeta("unlockedBadges", [...unlockedBadges]);
    }
    return newly;
  }

  function evalRule(rule, context) {
    switch (rule.type) {
      case "any-activity-count": return activities.length >= rule.value;
      case "activity-count": return activities.filter((a) => a.kind === rule.kind).length >= rule.value;
      case "single-distance":
        return activities.some((a) => a.kind === rule.kind && (a.distanceKm || 0) >= rule.km);
      case "start-time-before":
        return activities.some((a) => new Date(a.startTs).getHours() < rule.hour);
      case "start-time-after":
        return activities.some((a) => new Date(a.startTs).getHours() >= rule.hour);
      case "streak":
        return currentStreak() >= rule.value;
      case "weekly-count":
        return thisWeekActivities().length >= rule.value;
      case "single-elevation-ft":
        return activities.some((a) => (a.elevationGainM || 0) * 3.28084 >= rule.value);
      case "total-elevation-ft":
        return activities.reduce((s, a) => s + ((a.elevationGainM || 0) * 3.28084), 0) >= rule.value;
      case "activities-with-photos":
        return activities.filter((a) => (a.photos || []).length > 0).length >= rule.value;
      case "total-photos":
        return activities.reduce((s, a) => s + (a.photos || []).length, 0) >= rule.value;
      case "coached-count":
        return activities.filter((a) => a.coachWorkoutId).length >= rule.value;
      case "completed-coached-kind":
        return activities.some((a) => {
          if (!a.coachWorkoutId) return false;
          const w = workouts.find((x) => x.id === a.coachWorkoutId);
          return w && w.kind === rule.coachKind;
        });
      case "pace-under":
        return activities.some((a) => {
          if (a.kind !== rule.kind) return false;
          const distMi = (a.distanceKm || 0) * 0.621371;
          if (distMi < rule.distanceMi * 0.95) return false;
          const paceSecPerMi = (a.elapsedMs / 1000) / distMi;
          return paceSecPerMi <= rule.paceSecPerMi;
        });
      case "pr-broken":
        return (context.prsBroken || 0) >= rule.value;
      case "multimodal-day": {
        const dayKinds = {};
        for (const a of activities) {
          const day = new Date(a.startTs).toDateString();
          dayKinds[day] = dayKinds[day] || new Set();
          dayKinds[day].add(a.kind);
        }
        return Object.values(dayKinds).some((s) => s.has("run") && s.has("drive") && s.has("bike"));
      }
      case "all-kinds-tried": {
        const kinds = new Set(activities.map((a) => a.kind));
        return ["run", "drive", "bike", "walk"].every((k) => kinds.has(k));
      }
      case "ratings-given":
        return (context.ratingsGiven ?? Object.keys(routeRatings).length) >= rule.value;
      case "completed-route-tag":
        return activities.some((a) => {
          const r = routes.find((x) => x.id === a.followingRouteId);
          return r && (r.tags || []).includes(rule.tag);
        });
      case "weekend-double": {
        // Find any Sat with at least one act AND the following Sun with one
        const days = activities.map((a) => new Date(a.startTs));
        for (const d of days) {
          if (d.getDay() !== 6) continue; // 6 = Sat
          const sun = new Date(d); sun.setDate(d.getDate() + 1);
          if (days.some((x) => x.toDateString() === sun.toDateString())) return true;
        }
        return false;
      }
      default: return false;
    }
  }

  // ─── PRs ───────────────────────────────────────────────────
  function updatePRsFor(act) {
    if (act.kind !== "run") return 0;
    const distances = [
      { key: "1k", km: 1 },
      { key: "1mi", km: 1.609 },
      { key: "5k", km: 5 },
      { key: "10k", km: 10 },
    ];
    let prsBroken = 0;
    for (const d of distances) {
      if ((act.distanceKm || 0) < d.km) continue;
      const time = (act.elapsedMs / 1000) * (d.km / act.distanceKm);
      const key = "run_" + d.key;
      if (!prs[key] || time < prs[key].time_sec) {
        prs[key] = { activityId: act.id, time_sec: time, achievedAt: act.startTs };
        prsBroken++;
      }
    }
    if (prsBroken > 0) PaceDB.putMeta("prs", prs);
    return prsBroken;
  }

  // ─── Helpers ───────────────────────────────────────────────
  function currentStreak() {
    if (!activities.length) return 0;
    const days = new Set(activities.map((a) => new Date(a.startTs).toDateString()));
    let streak = 0;
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!days.has(cursor.toDateString())) {
      // If today has no activity, the streak might still be alive via yesterday
      cursor.setDate(cursor.getDate() - 1);
      if (!days.has(cursor.toDateString())) return 0;
    }
    while (days.has(cursor.toDateString())) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function thisWeekActivities() {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay()); // Sunday
    return activities.filter((a) => a.startTs >= start.getTime());
  }
  function thisMonthActivities() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(1);
    return activities.filter((a) => a.startTs >= start.getTime());
  }

  function isMetric() { return profile.units === "metric"; }
  function formatDistance(km) {
    if (!km) return isMetric() ? "0.00 km" : "0.00 mi";
    if (isMetric()) {
      return km >= 10 ? `${km.toFixed(1)} km` : `${km.toFixed(2)} km`;
    }
    const mi = km * 0.621371;
    return mi >= 10 ? `${mi.toFixed(1)} mi` : `${mi.toFixed(2)} mi`;
  }
  function formatElevationFt(elevationM) {
    if (!elevationM) return isMetric() ? "0 m" : "0 ft";
    if (isMetric()) return `${Math.round(elevationM)} m`;
    return `${Math.round(elevationM * 3.28084)} ft`;
  }
  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function formatPace(act) {
    if (!act || !act.distanceKm || !act.elapsedMs) return "—";
    if (act.kind === "drive") {
      const hours = act.elapsedMs / 3600000;
      if (isMetric()) {
        const kph = act.distanceKm / Math.max(0.001, hours);
        return kph.toFixed(1) + " km/h";
      }
      const mph = (act.distanceKm * 0.621371) / Math.max(0.001, hours);
      return mph.toFixed(1) + " mph";
    }
    const timeSec = act.elapsedMs / 1000;
    if (isMetric()) {
      const paceSecPerKm = timeSec / act.distanceKm;
      return formatPaceSecPerUnit(paceSecPerKm, "/km");
    }
    const distMi = act.distanceKm * 0.621371;
    if (!distMi) return "—";
    return formatPaceSecPerUnit(timeSec / distMi, "/mi");
  }
  function formatPaceSecPerUnit(sec, suffix) {
    if (!isFinite(sec) || sec <= 0 || sec > 60 * 60) return "—";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")} ${suffix}`;
  }
  function formatPaceSecPerMi(s) { return formatPaceSecPerUnit(s, "/mi"); }
  function formatPaceFor(timeSec, km) {
    if (isMetric()) return formatPaceSecPerUnit(timeSec / km, "/km");
    const distMi = km * 0.621371;
    return formatPaceSecPerUnit(timeSec / distMi, "/mi");
  }

  function relativeTime(ts) {
    const dt = Date.now() - ts;
    const m = Math.floor(dt / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return "Morning";
    if (h < 17) return "Afternoon";
    return "Evening";
  }

  const KIND_ICON_SVGS = {
    run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="14" cy="4.5" r="2"/><path d="M7 11l3.5-3 3 2.5 1 4.5 2.5 2.5"/><path d="M9 21l2.5-4.5L10 13l-3 2"/><path d="M16.5 11.5l3-1"/></svg>',
    drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14l1.6-4.4A2 2 0 0 1 7.5 8h9a2 2 0 0 1 1.9 1.6L20 14"/><path d="M3 14h18v3.5a1 1 0 0 1-1 1h-1.2a2 2 0 1 1-4 0H9.2a2 2 0 1 1-4 0H4a1 1 0 0 1-1-1z"/><path d="M7 11.5h10"/></svg>',
    bike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17l4-8h4l5 8M9.5 9h-2M14 5h2l2.5 4"/></svg>',
    walk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="4" r="2"/><path d="M11 7l-1 5 3 2v6"/><path d="M14 14l3-1 2 3"/><path d="M10 12l-2 4-3 1"/></svg>',
    hike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20l6-11 4 6 3-4 5 9z"/><circle cx="17" cy="6" r="1.5"/></svg>',
    swim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
    yoga: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2"/><path d="M12 7v5"/><path d="M5 19l7-2 7 2"/><path d="M7 16l5-4 5 4"/></svg>',
    golf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3v12"/><path d="M10 4l7 2.5L10 9"/><ellipse cx="10" cy="19" rx="6" ry="2"/></svg>',
    workout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L5 14h6l-1 8 8-12h-6z"/></svg>',
    climb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="14" cy="4" r="2"/><path d="M13 7l-1 4 3 2 1 4-3 5"/><path d="M9 11l-3 1-2 5"/><path d="M15 13l4-1"/></svg>',
    ski: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20L20 4"/><path d="M14 4l4 4"/><circle cx="9" cy="14" r="1.4"/><path d="M11 12l-3-3"/></svg>',
    snowboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18l18-12"/><circle cx="9" cy="14" r="1.4" fill="currentColor"/><circle cx="15" cy="10" r="1.4" fill="currentColor"/></svg>',
    surf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17c2.5-2 5-2 7 0s5 2 7 0 3 0 4 0"/><path d="M10 14l3-9 3 9"/></svg>',
    kayak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12c4-3 16-3 20 0"/><path d="M2 12c4 3 16 3 20 0"/><line x1="5" y1="9" x2="19" y2="15"/></svg>',
    row: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="15" rx="9" ry="2"/><path d="M4 11l4 4 8-8 4 4"/></svg>',
    offroad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14h2l1-3h11l1 3h3"/><path d="M3 14v3h18v-3"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="18" r="2.2"/><path d="M9 8l2-3h3l2 3"/></svg>',
  };
  function kindIcon(k) {
    return KIND_ICON_SVGS[k] || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
  }
  function kindColor(k) {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--" + k).trim();
    return v || "#ea580c";
  }
  function kindLabel(k) {
    return ({
      run: "Run", drive: "Drive", bike: "Bike", walk: "Walk",
      hike: "Hike", swim: "Swim", yoga: "Yoga", golf: "Golf",
      workout: "Workout", climb: "Climb", ski: "Ski", snowboard: "Snowboard",
      surf: "Surf", kayak: "Kayak", row: "Row",
      offroad: "Offroad",
    }[k] || k);
  }
  // Whether a kind needs GPS tracking. Indoor activities (yoga, strength,
  // swim) just track elapsed time + manual notes — no map.
  function kindNeedsGps(k) {
    return ["run", "drive", "bike", "walk", "hike", "offroad", "ski", "snowboard", "surf", "kayak", "sup", "golf"].includes(k);
  }
  // MET (Metabolic Equivalent of Task) for calorie calc — kcal ≈ MET × kg × hours
  function kindMET(k, speedMph = null) {
    if (k === "run") {
      // Approximate: 9 mph ~13 MET, 6 mph ~10, 4 mph ~6
      if (speedMph >= 8) return 12;
      if (speedMph >= 6) return 10;
      if (speedMph >= 4) return 7;
      return 6;
    }
    if (k === "bike") {
      if (speedMph >= 16) return 10;
      if (speedMph >= 12) return 8;
      if (speedMph >= 10) return 6;
      return 4;
    }
    if (k === "swim") return 7;
    if (k === "hike") return 6;
    if (k === "walk") return 3.5;
    if (k === "yoga") return 3;
    if (k === "drive") return 1.5;
    if (k === "golf") return 4.3;
    if (k === "workout") return 6;
    if (k === "climb") return 8;
    if (k === "ski") return 7;
    if (k === "snowboard") return 5.5;
    if (k === "surf") return 6;
    if (k === "kayak") return 5;
    if (k === "row") return 7;
    if (k === "offroad") return 2.5;
    return 4;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function debounce(fn, ms) {
    let h;
    return (...args) => {
      clearTimeout(h);
      h = setTimeout(() => fn(...args), ms);
    };
  }

  function fileToDataUrl(file, maxDim = 1280) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        // Resize for storage efficiency
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function toast(text, type = "") {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = text;
    document.getElementById("toasts").appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
  function speakAndToast(text, type) {
    toast(text, type);
    if (type === "achievement") speak(text);
  }

  // ─── Google Sheets sync ─────────────────────────────────────
  // Posts each saved activity to a Google Apps Script web app URL the
  // user configures in their own Sheet. No OAuth, no Zapier — the
  // script the user pastes is shown in the help modal.
  const SHEETS_APPS_SCRIPT = `// pacepost → Google Sheets
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Date","Kind","Name","Distance (mi)","Duration","Pace","Elevation (ft)","Calories","RPE","Notes"]);
    }
    sheet.appendRow([
      data.date || "", data.kind || "", data.name || "",
      data.distanceMi || "", data.duration || "", data.pace || "",
      data.elevationFt || "", data.calories || "", data.rpe || "", data.notes || ""
    ]);
    return ContentService.createTextOutput(JSON.stringify({ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false, error: String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}`;

  let sheetsCfg = { enabled: false, url: "" };
  async function loadSheetsCfg() {
    sheetsCfg = (await PaceDB.getMeta("sheetsSync")) || { enabled: false, url: "" };
  }
  async function saveSheetsCfg() {
    await PaceDB.putMeta("sheetsSync", sheetsCfg);
    syncSheetsUI();
  }
  function syncSheetsUI() {
    const status = document.getElementById("sheets-status");
    if (status) status.textContent = sheetsCfg.enabled && sheetsCfg.url ? "On" : "Off";
    const en = document.getElementById("sheets-enable");
    if (en) en.checked = !!sheetsCfg.enabled;
    const u = document.getElementById("sheets-url");
    if (u && document.activeElement !== u) u.value = sheetsCfg.url || "";
  }
  function activityToSheetsPayload(act) {
    const dt = new Date(act.startedAt || act.endedAt || Date.now());
    const dur = act.elapsedMs ? formatDuration(act.elapsedMs / 1000) : "";
    const distMi = act.distanceKm ? +(act.distanceKm * 0.621371).toFixed(2) : 0;
    const elev = act.elevationGainM ? Math.round(act.elevationGainM * 3.28084) : 0;
    return {
      date: dt.toISOString().slice(0, 10),
      startedAt: dt.toISOString(),
      kind: kindLabel(act.kind),
      name: activityName(act),
      distanceKm: act.distanceKm || 0,
      distanceMi: distMi,
      duration: dur,
      durationSec: act.elapsedMs ? Math.round(act.elapsedMs / 1000) : 0,
      pace: kindNeedsGps(act.kind) ? (formatPace(act) || "") : "",
      speedMph: act.distanceKm && act.elapsedMs
        ? +((act.distanceKm * 0.621371) / (act.elapsedMs / 3600000)).toFixed(1)
        : 0,
      elevationFt: elev,
      calories: act.calories || 0,
      rpe: act.rpe || "",
      notes: act.notes || "",
    };
  }
  async function pushToSheets(act) {
    if (!sheetsCfg.enabled || !sheetsCfg.url) return;
    try {
      const payload = activityToSheetsPayload(act);
      await fetch(sheetsCfg.url, {
        method: "POST",
        // text/plain avoids a CORS preflight; Apps Script reads e.postData.contents
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        mode: "no-cors",
      });
    } catch (e) {
      console.warn("[Sheets] push failed", e);
    }
  }
  async function sheetsTestRow() {
    const url = document.getElementById("sheets-url").value.trim();
    const msg = document.getElementById("sheets-msg");
    msg.style.display = "";
    msg.className = "sheets-msg";
    if (!url) { msg.textContent = "Paste a Web App URL first."; msg.classList.add("error"); return; }
    if (!/^https:\/\/script\.google\.com\//.test(url)) {
      msg.textContent = "That doesn't look like a Google Apps Script URL.";
      msg.classList.add("error");
      return;
    }
    sheetsCfg.url = url;
    await saveSheetsCfg();
    msg.textContent = "Sending test row…";
    try {
      const payload = {
        date: new Date().toISOString().slice(0, 10),
        kind: "Test",
        name: "pacepost test row",
        distanceMi: 1.0,
        duration: "00:10:00",
        pace: "10:00",
        elevationFt: 0,
        calories: 0,
        rpe: "",
        notes: "If you see this in your sheet, sync is working.",
      };
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        mode: "no-cors",
      });
      msg.textContent = "Test sent. Check your sheet — it should have a 'Test' row.";
      msg.classList.add("success");
    } catch (e) {
      msg.textContent = "Couldn't reach the URL. Make sure it's deployed as a Web App with access = Anyone.";
      msg.classList.add("error");
    }
  }
  function wireSheets() {
    document.getElementById("sheets-enable")?.addEventListener("change", async (e) => {
      sheetsCfg.enabled = e.target.checked;
      sheetsCfg.url = document.getElementById("sheets-url").value.trim();
      await saveSheetsCfg();
      const msg = document.getElementById("sheets-msg");
      if (sheetsCfg.enabled && !sheetsCfg.url) {
        msg.style.display = ""; msg.className = "sheets-msg error";
        msg.textContent = "Add the Web App URL above first.";
      } else if (sheetsCfg.enabled) {
        msg.style.display = ""; msg.className = "sheets-msg success";
        msg.textContent = "Sync is on. Activities will push automatically.";
      } else {
        msg.style.display = "none";
      }
    });
    document.getElementById("sheets-url")?.addEventListener("change", async (e) => {
      sheetsCfg.url = e.target.value.trim();
      await saveSheetsCfg();
    });
    document.getElementById("sheets-test-btn")?.addEventListener("click", sheetsTestRow);
    document.getElementById("sheets-help-btn")?.addEventListener("click", openSheetsHelp);
    document.getElementById("sheets-help-close")?.addEventListener("click", closeSheetsHelp);
    document.getElementById("sheets-help-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "sheets-help-overlay") closeSheetsHelp();
    });
    document.getElementById("sheets-copy-script")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(SHEETS_APPS_SCRIPT);
        toast("Script copied", "success");
      } catch {
        toast("Couldn't copy — select the script and copy manually", "error");
      }
    });
  }
  function openSheetsHelp() {
    document.getElementById("sheets-script-pre").textContent = SHEETS_APPS_SCRIPT;
    const ov = document.getElementById("sheets-help-overlay");
    ov.classList.add("open");
    ov.setAttribute("aria-hidden", "false");
  }
  function closeSheetsHelp() {
    const ov = document.getElementById("sheets-help-overlay");
    ov.classList.remove("open");
    ov.setAttribute("aria-hidden", "true");
  }

  // ─── Golf ───────────────────────────────────────────────────
  let golfCourses = [];
  let golfRoundDraft = null;
  let golfRoundStartedAt = 0;

  async function loadGolfCourses() {
    golfCourses = (await PaceDB.getMeta("golfCourses")) || [];
  }
  async function saveGolfCourses() {
    await PaceDB.putMeta("golfCourses", golfCourses);
  }

  function openGolfFlow() {
    golfRoundStartedAt = Date.now();
    document.getElementById("golf-title").textContent = "Pick a course";
    renderGolfCoursePicker();
    showGolfModal();
  }
  function showGolfModal() {
    const ov = document.getElementById("golf-overlay");
    ov.classList.add("open");
    ov.setAttribute("aria-hidden", "false");
  }
  function closeGolfFlow() {
    const ov = document.getElementById("golf-overlay");
    ov.classList.remove("open");
    ov.setAttribute("aria-hidden", "true");
    golfRoundDraft = null;
  }

  function renderGolfCoursePicker() {
    const body = document.getElementById("golf-body");
    const list = golfCourses.length
      ? `<div class="golf-course-list">${golfCourses.map((c) => `
          <button class="golf-course-card" data-course-id="${c.id}">
            <div class="golf-course-name">${escapeHtml(c.name)}</div>
            <div class="golf-course-meta">${c.holes.length} holes · par ${c.holes.reduce((s, h) => s + h.par, 0)}</div>
          </button>`).join("")}</div>`
      : `<div class="empty-state" style="padding:20px;"><div>No courses yet. Add one to start tracking rounds.</div></div>`;
    body.innerHTML = `
      ${list}
      <button class="btn-primary" id="golf-new-course-btn" style="width:100%;margin-top:14px;">+ New course</button>
    `;
    body.querySelectorAll("[data-course-id]").forEach((b) => {
      b.addEventListener("click", () => {
        const c = golfCourses.find((x) => x.id === b.dataset.courseId);
        if (c) startScorecardForCourse(c);
      });
    });
    document.getElementById("golf-new-course-btn").addEventListener("click", openCourseEditor);
  }

  function openCourseEditor(existing) {
    const isEdit = !!existing;
    document.getElementById("golf-title").textContent = isEdit ? "Edit course" : "New course";
    const body = document.getElementById("golf-body");
    const draft = existing || {
      id: "c_" + Math.random().toString(36).slice(2, 9),
      name: "",
      holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4 })),
    };
    body.innerHTML = `
      <div class="auth-field"><label>Course name</label>
        <input type="text" id="course-name" value="${escapeHtml(draft.name)}" placeholder="e.g. Tilden Park Golf Course" maxlength="60" />
      </div>
      <div class="seg-tabs" id="course-len-tabs" style="margin-bottom:14px;">
        <button class="seg-tab ${draft.holes.length === 9 ? "active" : ""}" data-holes="9">9 holes</button>
        <button class="seg-tab ${draft.holes.length === 18 ? "active" : ""}" data-holes="18">18 holes</button>
      </div>
      <div class="course-holes-hint">Tap to change par for each hole.</div>
      <div id="course-holes-grid" class="course-holes-grid"></div>
      <div style="margin-top:14px;font-size:13px;color:var(--text-dim);">
        Total par: <strong id="course-total-par">—</strong>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn-ghost" id="course-back">Back</button>
        <button class="btn-primary" id="course-save" style="flex:1;">${isEdit ? "Save changes" : "Save course"}</button>
      </div>
    `;
    let editDraft = JSON.parse(JSON.stringify(draft));
    function renderHoleGrid() {
      const g = document.getElementById("course-holes-grid");
      g.innerHTML = editDraft.holes.map((h, i) => `
        <button class="hole-par-cell" data-idx="${i}">
          <div class="hole-num">${h.number}</div>
          <div class="hole-par">Par ${h.par}</div>
        </button>`).join("");
      g.querySelectorAll(".hole-par-cell").forEach((c) => {
        c.addEventListener("click", () => {
          const i = parseInt(c.dataset.idx, 10);
          const cur = editDraft.holes[i].par;
          editDraft.holes[i].par = cur === 5 ? 3 : cur + 1;
          renderHoleGrid();
        });
      });
      document.getElementById("course-total-par").textContent = editDraft.holes.reduce((s, h) => s + h.par, 0);
    }
    renderHoleGrid();
    document.querySelectorAll("#course-len-tabs .seg-tab").forEach((t) => {
      t.addEventListener("click", () => {
        document.querySelectorAll("#course-len-tabs .seg-tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        const n = parseInt(t.dataset.holes, 10);
        if (editDraft.holes.length !== n) {
          editDraft.holes = Array.from({ length: n }, (_, i) => ({
            number: i + 1,
            par: editDraft.holes[i]?.par || 4,
          }));
          renderHoleGrid();
        }
      });
    });
    document.getElementById("course-back").addEventListener("click", () => {
      document.getElementById("golf-title").textContent = "Pick a course";
      renderGolfCoursePicker();
    });
    document.getElementById("course-save").addEventListener("click", async () => {
      const name = document.getElementById("course-name").value.trim();
      if (!name) { toast("Course needs a name", "error"); return; }
      editDraft.name = name;
      if (isEdit) {
        const idx = golfCourses.findIndex((c) => c.id === editDraft.id);
        if (idx >= 0) golfCourses[idx] = editDraft; else golfCourses.unshift(editDraft);
      } else {
        editDraft.createdAt = Date.now();
        golfCourses.unshift(editDraft);
      }
      await saveGolfCourses();
      toast(`${isEdit ? "Updated" : "Saved"} "${name}"`, "success");
      startScorecardForCourse(editDraft);
    });
  }

  function startScorecardForCourse(course) {
    document.getElementById("golf-title").textContent = course.name;
    golfRoundDraft = {
      courseId: course.id,
      courseName: course.name,
      holes: course.holes.map((h) => ({ number: h.number, par: h.par, score: null })),
    };
    renderScorecard();
  }

  function renderScorecard() {
    const body = document.getElementById("golf-body");
    const draft = golfRoundDraft;
    const totals = scorecardTotals(draft);
    const half = draft.holes.length === 18 ? 9 : draft.holes.length;
    const front = draft.holes.slice(0, half);
    const back = draft.holes.length > 9 ? draft.holes.slice(9) : [];

    const renderHalf = (title, rows, startIdx) => `
      <div class="scorecard-half">
        <div class="scorecard-half-title">${title}</div>
        ${rows.map((h, i) => {
          const idx = startIdx + i;
          const val = h.score == null ? "" : h.score;
          return `<div class="scorecard-row">
            <div class="sc-hole">
              <div class="sc-hole-num">${h.number}</div>
              <div class="sc-hole-par">Par ${h.par}</div>
            </div>
            <button class="sc-step" data-step-down="${idx}">−</button>
            <input type="number" class="sc-score" inputmode="numeric" data-score-idx="${idx}" value="${val}" placeholder="—" />
            <button class="sc-step" data-step-up="${idx}">+</button>
            <div class="sc-vs">${h.score != null ? scoreVsParLabel(h.score - h.par) : ""}</div>
          </div>`;
        }).join("")}
      </div>`;

    body.innerHTML = `
      <div class="scorecard-summary">
        <div class="ss-cell"><div class="ss-label">Score</div><div class="ss-val">${totals.scored}</div></div>
        <div class="ss-cell"><div class="ss-label">Par played</div><div class="ss-val">${totals.parPlayed}</div></div>
        <div class="ss-cell"><div class="ss-label">vs Par</div><div class="ss-val">${totals.vsParLabel}</div></div>
        <div class="ss-cell"><div class="ss-label">Holes</div><div class="ss-val">${totals.holesPlayed}/${draft.holes.length}</div></div>
      </div>
      ${renderHalf(draft.holes.length === 18 ? "Front 9" : "Holes", front, 0)}
      ${back.length ? renderHalf("Back 9", back, 9) : ""}
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn-ghost" id="sc-back">Change course</button>
        <button class="btn-primary" id="sc-save" style="flex:1;">Save round</button>
      </div>
    `;

    body.querySelectorAll(".sc-score").forEach((inp) => {
      inp.addEventListener("input", () => {
        const i = parseInt(inp.dataset.scoreIdx, 10);
        const v = inp.value.trim();
        draft.holes[i].score = v === "" ? null : Math.max(1, Math.min(20, parseInt(v, 10) || 0));
        updateScorecardSummary();
      });
      inp.addEventListener("blur", () => renderScorecard());
    });
    body.querySelectorAll("[data-step-up]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = parseInt(b.dataset.stepUp, 10);
        const cur = draft.holes[i].score ?? draft.holes[i].par;
        draft.holes[i].score = Math.min(20, cur + 1);
        renderScorecard();
      });
    });
    body.querySelectorAll("[data-step-down]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = parseInt(b.dataset.stepDown, 10);
        const cur = draft.holes[i].score ?? draft.holes[i].par;
        draft.holes[i].score = Math.max(1, cur - 1);
        renderScorecard();
      });
    });
    document.getElementById("sc-back").addEventListener("click", () => {
      document.getElementById("golf-title").textContent = "Pick a course";
      renderGolfCoursePicker();
    });
    document.getElementById("sc-save").addEventListener("click", saveGolfRound);
  }

  function scorecardTotals(draft) {
    const played = draft.holes.filter((h) => h.score != null);
    const scored = played.reduce((s, h) => s + h.score, 0);
    const parPlayed = played.reduce((s, h) => s + h.par, 0);
    const vsPar = scored - parPlayed;
    return {
      scored, parPlayed, vsPar,
      vsParLabel: played.length ? (vsPar === 0 ? "E" : (vsPar > 0 ? `+${vsPar}` : String(vsPar))) : "—",
      holesPlayed: played.length,
    };
  }
  function scoreVsParLabel(diff) {
    if (diff <= -2) return "Eagle";
    if (diff === -1) return "Birdie";
    if (diff === 0) return "Par";
    if (diff === 1) return "Bogey";
    if (diff === 2) return "2x bogey";
    if (diff >= 3) return `+${diff}`;
    return "";
  }
  function updateScorecardSummary() {
    const draft = golfRoundDraft;
    const totals = scorecardTotals(draft);
    const cells = document.querySelectorAll(".scorecard-summary .ss-val");
    if (cells.length >= 4) {
      cells[0].textContent = totals.scored;
      cells[1].textContent = totals.parPlayed;
      cells[2].textContent = totals.vsParLabel;
      cells[3].textContent = `${totals.holesPlayed}/${draft.holes.length}`;
    }
  }

  async function saveGolfRound() {
    const draft = golfRoundDraft;
    if (!draft) return;
    const totals = scorecardTotals(draft);
    if (totals.holesPlayed === 0) { toast("Enter at least one hole score", "error"); return; }
    // Hybrid mode: if a live golf tracker is running, just stash the draft.
    // It'll be attached when the user taps Finish on the live overlay.
    if (tracker && tracker.kind === "golf") {
      closeGolfFlow();
      toast(`Scorecard saved (${totals.scored}, ${totals.vsParLabel}). Keep playing.`, "success");
      return;
    }
    // Otherwise: standalone scorecard (no GPS) — create a new activity now.
    const elapsedMs = Math.max(60_000, Date.now() - golfRoundStartedAt);
    const act = {
      id: "a_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      kind: "golf",
      startedAt: golfRoundStartedAt,
      endedAt: Date.now(),
      elapsedMs,
      distanceKm: 0,
      golf: golfDataFromDraft(draft, totals),
      notes: "",
      photos: [],
    };
    act.calories = estimateCalories(act);
    await PaceDB.putActivity(act);
    publishActivityToCloud(act).catch(() => {});
    pushToSheets(act).catch(() => {});
    activities = await PaceDB.allActivities();
    closeGolfFlow();
    renderAll();
    speakAndToast(`Round saved · ${totals.scored} (${totals.vsParLabel}) on ${draft.courseName}`, "success");
    setTimeout(() => openActivityDetail(act.id), 400);
  }
  function golfDataFromDraft(draft, totals) {
    return {
      courseId: draft.courseId,
      courseName: draft.courseName,
      holes: draft.holes,
      totalScore: totals.scored,
      totalPar: totals.parPlayed,
      vsPar: totals.vsPar,
      holesPlayed: totals.holesPlayed,
    };
  }

  function golfDetailHtml(a) {
    const g = a.golf;
    if (!g) return "";
    const rowsHtml = (rows) => rows.map((h) => `
      <div class="scorecard-row readonly">
        <div class="sc-hole"><div class="sc-hole-num">${h.number}</div><div class="sc-hole-par">Par ${h.par}</div></div>
        <div class="sc-score-readonly">${h.score ?? "—"}</div>
        <div class="sc-vs">${h.score != null ? scoreVsParLabel(h.score - h.par) : ""}</div>
      </div>
    `).join("");
    const front = g.holes.slice(0, 9);
    const back = g.holes.length > 9 ? g.holes.slice(9) : [];
    return `
      <div class="detail-section">
        <h4>Scorecard — ${escapeHtml(g.courseName)}</h4>
        <div class="scorecard-summary" style="margin-bottom:10px;">
          <div class="ss-cell"><div class="ss-label">Score</div><div class="ss-val">${g.totalScore}</div></div>
          <div class="ss-cell"><div class="ss-label">Par played</div><div class="ss-val">${g.totalPar}</div></div>
          <div class="ss-cell"><div class="ss-label">vs Par</div><div class="ss-val">${g.vsPar === 0 ? "E" : (g.vsPar > 0 ? "+" + g.vsPar : g.vsPar)}</div></div>
          <div class="ss-cell"><div class="ss-label">Holes</div><div class="ss-val">${g.holesPlayed}/${g.holes.length}</div></div>
        </div>
        <div class="scorecard-half"><div class="scorecard-half-title">${g.holes.length === 18 ? "Front 9" : "Holes"}</div>${rowsHtml(front)}</div>
        ${back.length ? `<div class="scorecard-half"><div class="scorecard-half-title">Back 9</div>${rowsHtml(back)}</div>` : ""}
      </div>
    `;
  }

  // Close handler
  document.addEventListener("click", (e) => {
    if (e.target.id === "golf-overlay" || e.target.id === "golf-close") closeGolfFlow();
  });

  // ─── Cloud / Auth / Feed / Comments ─────────────────────────
  let authMode = "signin";
  let unsubComments = null;
  let unsubLikes = null;

  function cloud() { return window.Cloud; }

  function syncCloudUI() {
    const C = cloud();
    const signedIn = !!(C && C.user);
    const ready = !!(C && C.isReady);
    document.getElementById("topbar-signin").style.display = (ready && !signedIn) ? "" : "none";
    const profileSignin = document.getElementById("profile-signin-btn");
    const profileAccount = document.getElementById("profile-account-row");
    if (profileSignin) profileSignin.style.display = (ready && !signedIn) ? "" : "none";
    if (profileAccount) profileAccount.style.display = (ready && signedIn) ? "" : "none";
    if (signedIn) {
      const e = document.getElementById("profile-account-email");
      if (e) e.textContent = `${C.user.displayName} · ${C.user.email}`;
    }
    document.getElementById("feed-signed-out").style.display = (ready && !signedIn) ? "" : "none";
  }

  function wireCloudUI() {
    const C = cloud();
    if (!C) return;
    C.onAuth(() => { syncCloudUI(); if (currentViewName() === "feed") renderFeed(); });

    document.getElementById("profile-signin-btn")?.addEventListener("click", () => openAuthModal("signin"));
    document.getElementById("profile-signout-btn")?.addEventListener("click", async () => {
      try { await C.signOut(); toast("Signed out", "success"); } catch (e) { toast("Sign out failed", "error"); }
    });
    document.getElementById("feed-signin-btn")?.addEventListener("click", () => openAuthModal("signin"));
    document.getElementById("feed-refresh")?.addEventListener("click", () => renderFeed());
    document.getElementById("auth-close")?.addEventListener("click", closeAuthModal);
    document.getElementById("auth-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "auth-overlay") closeAuthModal();
    });
    document.querySelectorAll("#auth-tabs .seg-tab").forEach((t) => {
      t.addEventListener("click", () => {
        document.querySelectorAll("#auth-tabs .seg-tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        authMode = t.dataset.authTab;
        const isSignup = authMode === "signup";
        document.querySelector("[data-auth-field='name']").style.display = isSignup ? "" : "none";
        document.getElementById("auth-title").textContent = isSignup ? "Create account" : "Sign in";
        document.getElementById("auth-submit").textContent = isSignup ? "Create account" : "Sign in";
        document.getElementById("auth-error").style.display = "none";
      });
    });
    document.getElementById("auth-submit")?.addEventListener("click", submitAuth);
  }

  function currentViewName() {
    const v = document.querySelector(".view.active");
    return v?.dataset.view || "home";
  }

  function openAuthModal(mode = "signin") {
    const C = cloud();
    if (!C || !C.isReady) {
      toast("Cloud features need a Firebase config", "error");
      return;
    }
    authMode = mode;
    document.querySelectorAll("#auth-tabs .seg-tab").forEach((x) => x.classList.toggle("active", x.dataset.authTab === mode));
    const isSignup = mode === "signup";
    document.querySelector("[data-auth-field='name']").style.display = isSignup ? "" : "none";
    document.getElementById("auth-title").textContent = isSignup ? "Create account" : "Sign in";
    document.getElementById("auth-submit").textContent = isSignup ? "Create account" : "Sign in";
    document.getElementById("auth-error").style.display = "none";
    document.getElementById("auth-name").value = profile.name || "";
    document.getElementById("auth-email").value = "";
    document.getElementById("auth-password").value = "";
    const ov = document.getElementById("auth-overlay");
    ov.classList.add("open");
    ov.setAttribute("aria-hidden", "false");
    setTimeout(() => document.getElementById("auth-email").focus(), 80);
  }
  function closeAuthModal() {
    const ov = document.getElementById("auth-overlay");
    ov.classList.remove("open");
    ov.setAttribute("aria-hidden", "true");
  }
  async function submitAuth() {
    const C = cloud();
    if (!C) return;
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const name = document.getElementById("auth-name").value.trim();
    const err = document.getElementById("auth-error");
    err.style.display = "none";
    if (!email || !password) { err.textContent = "Email and password required."; err.style.display = ""; return; }
    if (authMode === "signup" && password.length < 6) { err.textContent = "Password must be at least 6 characters."; err.style.display = ""; return; }
    const submitBtn = document.getElementById("auth-submit");
    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = "…";
    try {
      if (authMode === "signup") {
        await C.signUp(email, password, name || profile.name || "");
        if (name) { profile.name = name; await PaceDB.putMeta("profile", profile); }
        toast("Account created", "success");
      } else {
        await C.signIn(email, password);
        toast("Signed in", "success");
      }
      closeAuthModal();
    } catch (e) {
      err.textContent = friendlyAuthError(e);
      err.style.display = "";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }
  function friendlyAuthError(e) {
    const code = (e && e.code) || "";
    if (code.includes("invalid-email")) return "That email doesn't look right.";
    if (code.includes("email-already-in-use")) return "That email is already registered.";
    if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Email or password is incorrect.";
    if (code.includes("weak-password")) return "Password must be at least 6 characters.";
    if (code.includes("network-request-failed")) return "Network error. Check your connection.";
    return e?.message || "Something went wrong.";
  }

  async function publishActivityToCloud(act) {
    const C = cloud();
    if (!C || !C.isReady || !C.user) return;
    try {
      // Upload photos first
      const localPhotos = act.photos || [];
      const uploaded = [];
      for (let i = 0; i < localPhotos.length; i++) {
        const blob = await dataUrlToBlob(localPhotos[i]);
        const url = await C.uploadPhoto(act.id, blob, i);
        uploaded.push(url);
      }
      const cloudId = await C.publishActivity({ ...act, photoUrls: uploaded });
      act.cloudId = cloudId;
      act.photoUrls = uploaded;
      await PaceDB.putActivity(act);
    } catch (e) {
      console.error("Cloud publish failed", e);
      toast("Couldn't sync to cloud", "error");
    }
  }
  async function dataUrlToBlob(dataUrl) {
    const r = await fetch(dataUrl);
    return await r.blob();
  }

  // Feed view
  let feedFilter = "nearby";
  // Placeholder users + their posts so the feed feels alive before the real
  // social backend is wired. Tap any name/avatar to open their profile.
  const PLACEHOLDER_USERS = {
    "mike-zhao": {
      uid: "mike-zhao", name: "Mike Zhao", region: "East Bay · Berkeley",
      bio: "Runner, climber, plays golf badly. Always down for a coffee after.",
      joinedAt: new Date("2024-01-08").getTime(),
      followers: 142, following: 187, avatarBg: "#0ea5e9",
    },
    "priya-nakamura": {
      uid: "priya-nakamura", name: "Priya Nakamura", region: "SF · Marina",
      bio: "Yoga teacher · marathon hopeful · sunrise enthusiast.",
      joinedAt: new Date("2023-06-12").getTime(),
      followers: 624, following: 211, avatarBg: "#ec4899",
    },
    "daniel-kim": {
      uid: "daniel-kim", name: "Daniel Kim", region: "Oakland · Piedmont",
      bio: "Cycling commuter, weekend climber, espresso snob.",
      joinedAt: new Date("2023-02-19").getTime(),
      followers: 89, following: 92, avatarBg: "#a855f7",
    },
    "sam-yamamoto": {
      uid: "sam-yamamoto", name: "Sam Yamamoto", region: "Marin · Mill Valley",
      bio: "Golf is a sport, fight me. Tilden regular, working on the short game.",
      joinedAt: new Date("2023-11-04").getTime(),
      followers: 56, following: 41, avatarBg: "#16a34a",
    },
    "alex-rivera": {
      uid: "alex-rivera", name: "Alex Rivera", region: "Marin · Mt Tam",
      bio: "Long miles, big climbs. PCT section hiker.",
      joinedAt: new Date("2023-09-22").getTime(),
      followers: 312, following: 145, avatarBg: "#65a30d",
    },
  };
  const PHOTO = {
    run: [
      "https://images.unsplash.com/photo-1486218119243-13883505764c?w=900&q=75&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=900&q=75&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=900&q=75&auto=format&fit=crop",
    ],
    bike: [
      "https://images.unsplash.com/photo-1485965127911-862fe79029dd?w=900&q=75&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1471506480208-9e21b59edcc1?w=900&q=75&auto=format&fit=crop",
    ],
    drive: [
      "https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=900&q=75&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1542362567-b07e54358753?w=900&q=75&auto=format&fit=crop",
    ],
    golf: [
      "https://images.unsplash.com/photo-1535131749006-b7f58c99034b?w=900&q=75&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1587381419618-a6e93b7e0c40?w=900&q=75&auto=format&fit=crop",
    ],
    hike: [
      "https://images.unsplash.com/photo-1551632811-561732d1e306?w=900&q=75&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1454942901704-3c44c11b2ad1?w=900&q=75&auto=format&fit=crop",
    ],
    yoga: [
      "https://images.unsplash.com/photo-1545205597-3d9d02c29597?w=900&q=75&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1588286840104-8957b019727f?w=900&q=75&auto=format&fit=crop",
    ],
    walk: [
      "https://images.unsplash.com/photo-1517524008697-84bbe3c3fd98?w=900&q=75&auto=format&fit=crop",
    ],
    swim: [
      "https://images.unsplash.com/photo-1530549387789-4c1017266635?w=900&q=75&auto=format&fit=crop",
    ],
  };
  const PLACEHOLDER_POSTS = (function () {
    const now = Date.now();
    const ago = (h) => now - h * 3600_000;
    return [
      // ── Mike Zhao ────────────────────────────────────────
      {
        id: "p-mike-1", uid: "mike-zhao",
        kind: "run", distanceKm: 8.4, elapsedMs: 41 * 60 * 1000 + 12000,
        pace: "4:54", elevationFt: 220, startedAt: ago(2), createdAt: ago(2),
        region: "East Bay · Berkeley Hills",
        notes: "Cool morning loop up to Grizzly Peak. Felt strong on the climb. Saw a deer near Centennial.",
        photoUrls: [PHOTO.run[0]],
        _likes: 12,
        _comments: [
          { authorName: "Priya Nakamura", text: "Those hills are brutal — nice pace!" },
          { authorName: "Daniel Kim", text: "Saw you at the trailhead, missed saying hi" },
        ],
      },
      {
        id: "p-mike-2", uid: "mike-zhao",
        kind: "drive", distanceKm: 38.6, elapsedMs: 62 * 60 * 1000,
        elevationFt: 1100, startedAt: ago(28), createdAt: ago(28),
        region: "Marin · Skyline Blvd",
        notes: "Sunday drive up Skyline. Pulled over at the overlook for a while.",
        photoUrls: [PHOTO.drive[0]],
        _likes: 5, _comments: [],
      },
      {
        id: "p-mike-3", uid: "mike-zhao",
        kind: "bike", distanceKm: 32.1, elapsedMs: 84 * 60 * 1000,
        elevationFt: 950, startedAt: ago(50), createdAt: ago(50),
        region: "East Bay · Three Bears",
        notes: "Three Bears loop. Wind was rough on the way out.",
        photoUrls: [PHOTO.bike[0]],
        _likes: 8,
        _comments: [{ authorName: "Sam Yamamoto", text: "Solid effort" }],
      },
      {
        id: "p-mike-4", uid: "mike-zhao",
        kind: "golf", distanceKm: 0, elapsedMs: 3.7 * 3600 * 1000,
        startedAt: ago(72), createdAt: ago(72),
        region: "East Bay · Tilden Park",
        notes: "Shot an 82. Three birdies on the back nine. Putter finally cooperating.",
        golf: { courseName: "Tilden Park Golf Course", totalScore: 82, totalPar: 72, vsPar: 10, holesPlayed: 18, holes: [] },
        photoUrls: [PHOTO.golf[0]],
        _likes: 3, _comments: [],
      },
      // ── Priya Nakamura ───────────────────────────────────
      {
        id: "p-priya-1", uid: "priya-nakamura",
        kind: "run", distanceKm: 16.2, elapsedMs: 84 * 60 * 1000 + 30000,
        pace: "5:13", elevationFt: 180, startedAt: ago(5), createdAt: ago(5),
        region: "SF · Crissy Field → GG Bridge",
        notes: "Long run to the bridge and back. First time hitting 10mi without walking. 🌅",
        photoUrls: [PHOTO.run[1]],
        _likes: 27,
        _comments: [
          { authorName: "Mike Zhao", text: "huge!! marathon ready" },
          { authorName: "Alex Rivera", text: "🔥🔥" },
        ],
      },
      {
        id: "p-priya-2", uid: "priya-nakamura",
        kind: "yoga", distanceKm: 0, elapsedMs: 75 * 60 * 1000,
        startedAt: ago(20), createdAt: ago(20),
        region: "SF · Marina Studio",
        notes: "Taught a sunrise vinyasa class. Best students ever.",
        photoUrls: [PHOTO.yoga[0]],
        _likes: 18, _comments: [],
      },
      // ── Daniel Kim ───────────────────────────────────────
      {
        id: "p-daniel-1", uid: "daniel-kim",
        kind: "bike", distanceKm: 45.8, elapsedMs: 112 * 60 * 1000,
        elevationFt: 2400, startedAt: ago(8), createdAt: ago(8),
        region: "East Bay · Mt Diablo",
        notes: "Diablo summit ride. Brutal headwind near the top. Reward = views.",
        photoUrls: [PHOTO.bike[1]],
        _likes: 22,
        _comments: [
          { authorName: "Mike Zhao", text: "the climb that humbles everyone" },
        ],
      },
      {
        id: "p-daniel-2", uid: "daniel-kim",
        kind: "walk", distanceKm: 5.0, elapsedMs: 58 * 60 * 1000,
        elevationFt: 60, startedAt: ago(32), createdAt: ago(32),
        region: "Oakland · Lake Merritt",
        notes: "Lake loop with the dog. Slow pace, lots of stops.",
        photoUrls: [PHOTO.walk[0]],
        _likes: 6, _comments: [],
      },
      // ── Sam Yamamoto ─────────────────────────────────────
      {
        id: "p-sam-1", uid: "sam-yamamoto",
        kind: "golf", distanceKm: 0, elapsedMs: 4.2 * 3600 * 1000,
        startedAt: ago(14), createdAt: ago(14),
        region: "Marin · Mill Valley GC",
        notes: "Front nine was a disaster (+8), came back with a +1 back nine. Inconsistency is my brand.",
        golf: { courseName: "Mill Valley GC", totalScore: 89, totalPar: 72, vsPar: 17, holesPlayed: 18, holes: [] },
        photoUrls: [PHOTO.golf[1]],
        _likes: 9,
        _comments: [
          { authorName: "Mike Zhao", text: "back 9 was clean tho" },
        ],
      },
      // ── Alex Rivera ──────────────────────────────────────
      {
        id: "p-alex-1", uid: "alex-rivera",
        kind: "hike", distanceKm: 19.4, elapsedMs: 5.5 * 3600 * 1000,
        elevationFt: 3200, startedAt: ago(38), createdAt: ago(38),
        region: "Marin · Mt Tam Verna Dutton",
        notes: "East Peak via Verna Dutton. Saw 3 deer, 0 humans for two hours.",
        photoUrls: [PHOTO.hike[0]],
        _likes: 35,
        _comments: [
          { authorName: "Priya Nakamura", text: "stunning" },
          { authorName: "Daniel Kim", text: "putting this on my list" },
        ],
      },
      {
        id: "p-alex-2", uid: "alex-rivera",
        kind: "hike", distanceKm: 12.1, elapsedMs: 3.1 * 3600 * 1000,
        elevationFt: 1800, startedAt: ago(60), createdAt: ago(60),
        region: "Marin · Steep Ravine",
        notes: "Quick Steep Ravine loop. Trail is muddy after the rain.",
        photoUrls: [PHOTO.hike[1]],
        _likes: 14, _comments: [],
      },
    ].map((p) => {
      const user = PLACEHOLDER_USERS[p.uid];
      return { ...p, authorName: user.name, _placeholder: true };
    });
  })();
  function placeholderUser(uid) { return PLACEHOLDER_USERS[uid]; }
  function placeholderPostsFor(uid) {
    return PLACEHOLDER_POSTS
      .filter((p) => p.uid === uid)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  // ── Follows / messaging ───────────────────────────────────────
  let follows = new Set();
  let dmThreads = {}; // { uid: [{ from, text, ts }] }
  async function loadSocialState() {
    follows = new Set((await PaceDB.getMeta("follows")) || []);
    dmThreads = (await PaceDB.getMeta("dmThreads")) || {};
  }
  async function saveFollows() { await PaceDB.putMeta("follows", [...follows]); }
  async function saveDms() { await PaceDB.putMeta("dmThreads", dmThreads); }
  async function toggleFollow(uid) {
    if (follows.has(uid)) follows.delete(uid); else follows.add(uid);
    await saveFollows();
  }

  // ── Messages inbox ────────────────────────────────────────────
  function openMessages() {
    const overlay = document.getElementById("messages-overlay");
    const body = document.getElementById("messages-body");
    // Build conversation list. Start with users we have threads with;
    // append placeholder users we follow (as suggestions to message).
    const uids = new Set();
    Object.keys(dmThreads).forEach((u) => uids.add(u));
    follows.forEach((u) => uids.add(u));
    const rows = [...uids]
      .map((uid) => {
        const u = placeholderUser(uid);
        if (!u) return null;
        const msgs = dmThreads[uid] || [];
        const last = msgs[msgs.length - 1];
        return {
          uid, name: u.name, region: u.region, avatarBg: u.avatarBg,
          lastText: last?.text || "Say hi —",
          lastTs: last?.ts || 0,
          fromMe: last?.from === "me",
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.lastTs - a.lastTs);

    if (!rows.length) {
      body.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <div style="font-size:14px;">No conversations yet.</div>
          <div style="margin-top:8px;font-size:13px;color:var(--text-dim);">Tap a user in the feed and hit Message to start a chat.</div>
        </div>`;
    } else {
      body.innerHTML = `<div class="dm-list">${rows.map((r) => `
        <button class="dm-row" data-dm-uid="${r.uid}">
          <div class="dm-row-avatar" style="background:${r.avatarBg};">${escapeHtml(r.name[0].toUpperCase())}</div>
          <div class="dm-row-body">
            <div class="dm-row-top">
              <span class="dm-row-name">${escapeHtml(r.name)}</span>
              <span class="dm-row-time">${r.lastTs ? timeAgo(r.lastTs) : ""}</span>
            </div>
            <div class="dm-row-snippet">${r.fromMe ? "You: " : ""}${escapeHtml(r.lastText.slice(0, 80))}</div>
          </div>
        </button>
      `).join("")}</div>`;
      body.querySelectorAll("[data-dm-uid]").forEach((b) => {
        b.addEventListener("click", () => {
          closeMessages();
          setTimeout(() => {
            const uid = b.dataset.dmUid;
            // open the user profile, then jump to thread
            openUserProfile(uid);
            setTimeout(() => openDmThread(uid), 60);
          }, 180);
        });
      });
    }
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
  }
  function closeMessages() {
    const overlay = document.getElementById("messages-overlay");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
  }
  document.addEventListener("click", (e) => {
    if (e.target.id === "messages-overlay" || e.target.id === "messages-close" ||
        e.target.closest && e.target.closest("#messages-close")) closeMessages();
  });

  // ── User profile modal ────────────────────────────────────────
  function openUserProfile(uid) {
    const u = placeholderUser(uid);
    const overlay = document.getElementById("user-overlay");
    const body = document.getElementById("user-body");
    if (!u) {
      // Real cloud user — minimal profile for now
      body.innerHTML = `<div class="empty-state" style="padding:30px;"><div>Profile view for cloud users is coming soon.</div></div>`;
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
      return;
    }
    const posts = placeholderPostsFor(uid);
    const totalKm = posts.reduce((s, p) => s + (p.distanceKm || 0), 0);
    const totalMi = totalKm * 0.621371;
    const totalActs = posts.length;
    const totalTime = posts.reduce((s, p) => s + (p.elapsedMs || 0), 0);
    const followsBack = false; // placeholders never follow you back
    const isFollowing = follows.has(uid);
    const memberSince = new Date(u.joinedAt).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    const initial = u.name[0].toUpperCase();

    body.innerHTML = `
      <div class="user-cover" style="background: linear-gradient(135deg, ${u.avatarBg}33 0%, ${u.avatarBg}11 100%);"></div>
      <div class="user-head">
        <div class="user-avatar-large" style="background:${u.avatarBg};">${escapeHtml(initial)}</div>
        <div class="user-head-info">
          <div class="user-name">${escapeHtml(u.name)}</div>
          <div class="user-meta">${escapeHtml(u.region)} · Member since ${memberSince}</div>
          <div class="user-meta" style="margin-top:2px;">Public account</div>
        </div>
      </div>
      <div class="user-bio">${escapeHtml(u.bio || "")}</div>
      <div class="user-stat-row">
        <div class="user-stat"><div class="user-stat-val">${totalActs}</div><div class="user-stat-lbl">activities</div></div>
        <div class="user-stat"><div class="user-stat-val">${totalMi >= 100 ? totalMi.toFixed(0) : totalMi.toFixed(1)}</div><div class="user-stat-lbl">total mi</div></div>
        <div class="user-stat"><div class="user-stat-val">${u.followers.toLocaleString()}</div><div class="user-stat-lbl">followers</div></div>
        <div class="user-stat"><div class="user-stat-val">${u.following.toLocaleString()}</div><div class="user-stat-lbl">following</div></div>
      </div>
      <div class="user-actions">
        <button class="btn-primary user-follow-btn" id="user-follow-btn">${isFollowing ? "✓ Following" : "+ Follow"}</button>
        <button class="btn-ghost" id="user-message-btn">Message</button>
      </div>
      <div class="section-row" style="margin-top:18px;">
        <h2 class="section-title">Recent activities</h2>
      </div>
      <div id="user-posts" class="user-posts"></div>
    `;

    const postsEl = body.querySelector("#user-posts");
    posts.forEach((p) => postsEl.appendChild(feedItemEl(p)));

    const followBtn = document.getElementById("user-follow-btn");
    followBtn.classList.toggle("following", isFollowing);
    followBtn.addEventListener("click", async () => {
      await toggleFollow(uid);
      const nowFollowing = follows.has(uid);
      followBtn.textContent = nowFollowing ? "✓ Following" : "+ Follow";
      followBtn.classList.toggle("following", nowFollowing);
      toast(nowFollowing ? `Now following ${u.name}` : `Unfollowed ${u.name}`, "success");
    });
    document.getElementById("user-message-btn").addEventListener("click", () => openDmThread(uid));

    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
  }
  function closeUserProfile() {
    const ov = document.getElementById("user-overlay");
    ov.classList.remove("open");
    ov.setAttribute("aria-hidden", "true");
  }
  function openDmThread(uid) {
    const u = placeholderUser(uid);
    if (!u) return;
    const body = document.getElementById("user-body");
    const messages = dmThreads[uid] || [];
    document.getElementById("user-overlay-title").textContent = u.name;
    body.innerHTML = `
      <div class="dm-thread" id="dm-thread"></div>
      <div class="dm-input-row">
        <input type="text" id="dm-input" placeholder="Message ${escapeHtml(u.name.split(" ")[0])}…" maxlength="500" />
        <button class="btn-primary" id="dm-send">Send</button>
      </div>
      <div style="text-align:center;margin-top:14px;">
        <button class="link-btn" id="dm-back">← Back to profile</button>
      </div>
    `;
    const renderThread = () => {
      const list = document.getElementById("dm-thread");
      const msgs = dmThreads[uid] || [];
      if (!msgs.length) {
        list.innerHTML = `<div class="empty-state" style="padding:14px;font-size:13px;">Say hi to ${escapeHtml(u.name.split(" ")[0])}.</div>`;
        return;
      }
      list.innerHTML = msgs.map((m) => `
        <div class="dm-msg ${m.from === "me" ? "me" : "them"}">
          <div class="dm-bubble">${escapeHtml(m.text)}</div>
          <div class="dm-time">${timeAgo(m.ts)}</div>
        </div>
      `).join("");
      list.scrollTop = list.scrollHeight;
    };
    renderThread();
    const send = async () => {
      const inp = document.getElementById("dm-input");
      const text = inp.value.trim();
      if (!text) return;
      dmThreads[uid] = dmThreads[uid] || [];
      dmThreads[uid].push({ from: "me", text, ts: Date.now() });
      await saveDms();
      inp.value = "";
      renderThread();
      // Mock reply from placeholder (simple canned)
      setTimeout(async () => {
        const replies = [
          "haha nice", "lmk when you wanna run", "good seeing you out there",
          "for sure 🤙", "got it", "agreed",
        ];
        dmThreads[uid].push({ from: uid, text: replies[Math.floor(Math.random() * replies.length)], ts: Date.now() });
        await saveDms();
        renderThread();
      }, 900 + Math.random() * 1400);
    };
    document.getElementById("dm-send").addEventListener("click", send);
    document.getElementById("dm-input").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    document.getElementById("dm-back").addEventListener("click", () => {
      document.getElementById("user-overlay-title").textContent = "Profile";
      openUserProfile(uid);
    });
  }
  document.addEventListener("click", (e) => {
    if (e.target.id === "user-overlay" || e.target.id === "user-close") closeUserProfile();
  });

  // ── Settings ──────────────────────────────────────────────────
  const AVATAR_COLORS = [
    "#38bdf8", "#0ea5e9", "#16a34a", "#9333ea", "#ec4899",
    "#f59e0b", "#ef4444", "#0d9488", "#64748b", "#1e293b",
  ];
  function wireSettings() {
    document.querySelectorAll("#units-tabs .seg-tab").forEach((t) => {
      t.addEventListener("click", async () => {
        document.querySelectorAll("#units-tabs .seg-tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        profile.units = t.dataset.units;
        await PaceDB.putMeta("profile", profile);
        applyUnitLabels();
        renderAll();
      });
    });
    document.getElementById("settings-audio")?.addEventListener("change", async (e) => {
      profile.muteCoach = !e.target.checked;
      await PaceDB.putMeta("profile", profile);
    });
    document.getElementById("settings-autopause")?.addEventListener("change", async (e) => {
      profile.autopause = e.target.checked;
      await PaceDB.putMeta("profile", profile);
    });
    document.getElementById("settings-public-default")?.addEventListener("change", async (e) => {
      profile.publicDefault = e.target.checked;
      await PaceDB.putMeta("profile", profile);
    });
    document.getElementById("settings-wakelock")?.addEventListener("change", async (e) => {
      profile.wakeLock = e.target.checked;
      await PaceDB.putMeta("profile", profile);
    });
  }
  function applyUnitLabels() {
    const metric = isMetric();
    document.querySelectorAll(".unit-tag").forEach((el) => {
      el.textContent = metric ? (el.dataset.metric || "") : (el.dataset.imperial || "");
    });
    syncProfileBodyInputs();
  }
  function syncProfileBodyInputs() {
    const wEl = document.getElementById("profile-weight-lbs");
    if (wEl) {
      if (profile.weightLbs == null) wEl.value = "";
      else wEl.value = isMetric() ? (profile.weightLbs / 2.2046).toFixed(1) : Math.round(profile.weightLbs);
    }
    const impGroup = document.querySelector(".height-imperial-group");
    const metGroup = document.querySelector(".height-metric-group");
    if (impGroup && metGroup) {
      const metric = isMetric();
      impGroup.style.display = metric ? "none" : "";
      metGroup.style.display = metric ? "" : "none";
    }
    const ftEl = document.getElementById("profile-height-ft");
    const inExtraEl = document.getElementById("profile-height-in-extra");
    const cmEl = document.getElementById("profile-height-cm");
    if (profile.heightIn == null) {
      if (ftEl) ftEl.value = "";
      if (inExtraEl) inExtraEl.value = "";
      if (cmEl) cmEl.value = "";
    } else {
      const total = profile.heightIn;
      const ft = Math.floor(total / 12);
      const inches = Math.round(total - ft * 12);
      if (ftEl) ftEl.value = ft;
      if (inExtraEl) inExtraEl.value = inches;
      if (cmEl) cmEl.value = Math.round(total * 2.54);
    }
  }
  function syncSettingsUI() {
    const u = profile.units || "imperial";
    document.querySelectorAll("#units-tabs .seg-tab").forEach((x) => x.classList.toggle("active", x.dataset.units === u));
    const audio = document.getElementById("settings-audio"); if (audio) audio.checked = !profile.muteCoach;
    const ap = document.getElementById("settings-autopause"); if (ap) ap.checked = !!profile.autopause;
    const pd = document.getElementById("settings-public-default"); if (pd) pd.checked = profile.publicDefault !== false;
    const wl = document.getElementById("settings-wakelock"); if (wl) wl.checked = profile.wakeLock !== false;
    applyUnitLabels();
  }

  function wireProfileCustomization() {
    const swatchEl = document.getElementById("profile-avatar-swatches");
    if (swatchEl && !swatchEl.children.length) {
      swatchEl.innerHTML = AVATAR_COLORS.map((c) =>
        `<button class="avatar-swatch" data-color="${c}" style="background:${c};" aria-label="${c}"></button>`
      ).join("");
      swatchEl.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-color]");
        if (!b) return;
        profile.avatarBg = b.dataset.color;
        await PaceDB.putMeta("profile", profile);
        syncProfileAvatar();
      });
    }
    document.getElementById("profile-bio")?.addEventListener("input", debounce(async (e) => {
      profile.bio = e.target.value;
      await PaceDB.putMeta("profile", profile);
    }, 400));
    document.getElementById("profile-region")?.addEventListener("input", debounce(async (e) => {
      profile.region = e.target.value;
      await PaceDB.putMeta("profile", profile);
    }, 400));
  }
  function syncProfileAvatar() {
    const av = document.getElementById("profile-avatar");
    if (av) {
      av.style.background = profile.avatarBg || "#38bdf8";
      av.style.color = "#fff";
      av.textContent = (profile.name?.[0] || "○").toUpperCase();
    }
    document.querySelectorAll(".avatar-swatch").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === profile.avatarBg);
    });
  }

  async function renderFeed() {
    const C = cloud();
    const list = document.getElementById("feed-list");
    const empty = document.getElementById("feed-empty");
    const banner = document.getElementById("feed-signed-out");
    list.innerHTML = "";
    empty.style.display = "none";

    const cloudReady = !!(C && C.isReady);
    const signedIn = !!(C && C.user);
    banner.style.display = (cloudReady && !signedIn) ? "" : "none";

    // Always start by collecting cloud posts (if any), then add placeholders
    // so the feed feels alive even before friends sign up.
    let real = [];
    if (cloudReady && signedIn) {
      try { real = await C.fetchFeed(30); } catch (e) { console.warn("feed fetch failed", e); }
    }

    let placeholders = PLACEHOLDER_POSTS;
    if (feedFilter === "friends") {
      // Show placeholders we follow (local follows set)
      placeholders = placeholders.filter((p) => follows.has(p.uid));
    }
    // Sort by recency
    placeholders = [...placeholders].sort((a, b) => b.startedAt - a.startedAt);

    const combined = [
      ...real.map((r) => ({ ...r, _real: true })),
      ...placeholders,
    ];

    // For "Nearby" we'd ideally filter by region/geo — since we don't have
    // user locations yet, just keep all (Mike is already tagged nearby).
    if (feedFilter === "friends" && !real.length) {
      empty.style.display = "";
      empty.querySelector("div").textContent = "No friends posting yet. Use Nearby to see people in your area.";
      return;
    }

    if (!combined.length) {
      empty.style.display = "";
      empty.querySelector("div").textContent = "No activities yet. Go track one.";
      return;
    }

    combined.forEach((it) => list.appendChild(feedItemEl(it)));
  }

  function wireFeedFilters() {
    document.querySelectorAll("#feed-filter .filter-chip").forEach((c) => {
      c.addEventListener("click", () => {
        document.querySelectorAll("#feed-filter .filter-chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        feedFilter = c.dataset.feedFilter;
        const note = document.getElementById("feed-area-note");
        if (note) note.textContent = {
          nearby: "Activities near you",
          all: "Activities from everyone",
          friends: "People you follow",
        }[feedFilter] || "Activities near you";
        renderFeed();
      });
    });
  }
  function feedItemEl(it) {
    const el = document.createElement("div");
    el.className = "feed-card";
    if (it._placeholder) el.classList.add("placeholder");
    const dist = it.kind === "golf"
      ? (it.golf ? `${it.golf.totalScore} (${it.golf.vsPar >= 0 ? "+" + it.golf.vsPar : it.golf.vsPar} on ${it.golf.holesPlayed} holes)` : "")
      : formatDistance(it.distanceKm || 0);
    const dur = formatDuration((it.elapsedMs || 0) / 1000);
    const when = it.startedAt ? timeAgo(it.startedAt) : "";
    const photo = (it.photoUrls && it.photoUrls[0])
      ? `<img class="feed-photo" src="${escapeHtml(it.photoUrls[0])}" alt="" loading="lazy" />` : "";
    const initial = ((it.authorName || "?")[0] || "?").toUpperCase();
    const regionLine = it.region ? `<div class="feed-region">${escapeHtml(it.region)}</div>` : "";
    const placeholderUserBg = it._placeholder ? PLACEHOLDER_USERS[it.uid]?.avatarBg : null;
    el.innerHTML = `
      <div class="feed-head">
        <button class="feed-avatar feed-tap-user" data-feed-uid="${it.uid || ""}" style="${placeholderUserBg ? `background:${placeholderUserBg};color:#fff;` : ""}">${escapeHtml(initial)}</button>
        <div class="feed-author">
          <button class="feed-name feed-tap-user" data-feed-uid="${it.uid || ""}">${escapeHtml(it.authorName || "athlete")}${it._placeholder ? ' <span class="feed-badge">nearby</span>' : ""}</button>
          <div class="feed-when">${when}${it.region ? " · " + escapeHtml(it.region) : ""}</div>
        </div>
        <div class="act-icon ${it.kind}">${kindIcon(it.kind)}</div>
      </div>
      <div class="feed-title">${kindLabel(it.kind)}${dist ? " · " + dist : ""}${dur ? " · " + dur : ""}</div>
      ${it.notes ? `<div class="feed-notes">${escapeHtml(it.notes)}</div>` : ""}
      ${photo}
      <div class="feed-actions">
        <button class="like-btn" data-feed-like="${it.id}">♡ <span data-feed-like-count="${it.id}">${it._placeholder ? it._likes : "…"}</span></button>
        <button class="link-btn" data-feed-comments="${it.id}"><span data-feed-comment-count="${it.id}">${it._placeholder ? (it._comments?.length || 0) : "…"}</span> comments</button>
      </div>
      <div class="feed-comments" id="feed-comments-${it.id}" style="display:none;"></div>
    `;
    // Tap name/avatar → open profile
    el.querySelectorAll(".feed-tap-user").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const uid = b.dataset.feedUid;
        if (uid) openUserProfile(uid);
      });
    });

    if (it._placeholder) {
      // Local-only like / comment toggle just for the demo. Persists in memory
      // until reload; doesn't hit Firestore.
      let liked = false;
      let localLikes = it._likes;
      const localComments = [...(it._comments || [])];
      const likeBtn = el.querySelector(`[data-feed-like="${it.id}"]`);
      likeBtn.addEventListener("click", () => {
        liked = !liked;
        localLikes += liked ? 1 : -1;
        likeBtn.classList.toggle("liked", liked);
        likeBtn.innerHTML = `${liked ? "♥" : "♡"} <span data-feed-like-count="${it.id}">${localLikes}</span>`;
      });
      el.querySelector(`[data-feed-comments="${it.id}"]`).addEventListener("click", () => {
        const box = el.querySelector(`#feed-comments-${it.id}`);
        if (box.style.display === "none") {
          box.style.display = "";
          box.innerHTML = renderLocalComments(localComments, it.id);
          const sendBtn = box.querySelector("[data-local-comment-send]");
          const inp = box.querySelector(".comment-input-feed");
          const send = () => {
            const text = inp.value.trim();
            if (!text) return;
            const name = (cloud()?.user?.displayName) || (profile?.name) || "you";
            localComments.push({ authorName: name, text });
            box.innerHTML = renderLocalComments(localComments, it.id);
            const ib = box.querySelector(".comment-input-feed"); ib.value = ""; ib.focus();
            const sb = box.querySelector("[data-local-comment-send]");
            sb?.addEventListener("click", send);
            box.querySelector(".comment-input-feed")?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
            el.querySelector(`[data-feed-comment-count="${it.id}"]`).textContent = localComments.length;
          };
          sendBtn?.addEventListener("click", send);
          inp?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
        } else {
          box.style.display = "none";
        }
      });
      return el;
    }

    // Real Firestore-backed post — wire live listeners.
    cloud().listenLikes(it.id, (likes) => {
      const me = cloud().user?.uid;
      el.querySelectorAll(`[data-feed-like="${it.id}"]`).forEach((b) => {
        const liked = me && likes.has(me);
        b.classList.toggle("liked", liked);
        b.innerHTML = `${liked ? "♥" : "♡"} <span data-feed-like-count="${it.id}">${likes.size}</span>`;
      });
    });
    cloud().listenComments(it.id, (cs) => {
      el.querySelector(`[data-feed-comment-count="${it.id}"]`).textContent = cs.length;
      const box = el.querySelector(`#feed-comments-${it.id}`);
      if (box.style.display !== "none") box.innerHTML = renderCommentsHtml(cs, it.id);
    });
    el.querySelector(`[data-feed-like="${it.id}"]`).addEventListener("click", async () => {
      if (!cloud().user) return openAuthModal("signin");
      try { await cloud().toggleLike(it.id); } catch (e) { console.error(e); }
    });
    el.querySelector(`[data-feed-comments="${it.id}"]`).addEventListener("click", async () => {
      const box = el.querySelector(`#feed-comments-${it.id}`);
      if (box.style.display === "none") {
        box.style.display = "";
        cloud().listenComments(it.id, (cs) => { box.innerHTML = renderCommentsHtml(cs, it.id); wireCommentSendButton(box, it.id); });
      } else {
        box.style.display = "none";
      }
    });
    return el;
  }
  function renderLocalComments(cs, activityId) {
    const items = cs.map((c) => `
      <div class="comment">
        <span class="comment-author">${escapeHtml(c.authorName || "athlete")}</span>
        <span class="comment-text">${escapeHtml(c.text)}</span>
      </div>
    `).join("");
    return `${items}
      <div class="comment-input-row">
        <input type="text" class="comment-input-feed" placeholder="Add a comment…" maxlength="500" />
        <button class="btn-primary" data-local-comment-send="${activityId}">Send</button>
      </div>`;
  }
  function renderCommentsHtml(cs, activityId) {
    const items = cs.map((c) => `
      <div class="comment">
        <span class="comment-author">${escapeHtml(c.authorName || "athlete")}</span>
        <span class="comment-text">${escapeHtml(c.text)}</span>
      </div>
    `).join("");
    return `${items}
      <div class="comment-input-row">
        <input type="text" class="comment-input-feed" placeholder="Add a comment…" maxlength="500" />
        <button class="btn-primary" data-feed-comment-send="${activityId}">Send</button>
      </div>`;
  }
  function wireCommentSendButton(box, activityId) {
    const btn = box.querySelector(`[data-feed-comment-send="${activityId}"]`);
    const input = box.querySelector(".comment-input-feed");
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      if (!cloud().user) return openAuthModal("signin");
      try { await cloud().addComment(activityId, text); input.value = ""; }
      catch (e) { toast("Couldn't post comment", "error"); }
    };
    btn?.addEventListener("click", send);
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  }

  function wireDetailSocial(act) {
    const C = cloud();
    if (!C || !act.cloudId) return;
    if (unsubLikes) { unsubLikes(); unsubLikes = null; }
    if (unsubComments) { unsubComments(); unsubComments = null; }
    const likeBtn = document.getElementById("like-btn");
    const likeCount = document.getElementById("like-count");
    const commentCount = document.getElementById("comment-count");
    const commentsList = document.getElementById("comments-list");
    unsubLikes = C.listenLikes(act.cloudId, (likes) => {
      const liked = C.user && likes.has(C.user.uid);
      likeBtn.dataset.liked = liked ? "true" : "false";
      likeBtn.innerHTML = `${liked ? "♥" : "♡"} <span id="like-count">${likes.size}</span>`;
      likeBtn.classList.toggle("liked", !!liked);
    });
    unsubComments = C.listenComments(act.cloudId, (cs) => {
      commentCount.textContent = `${cs.length} comment${cs.length === 1 ? "" : "s"}`;
      commentsList.innerHTML = cs.map((c) => `
        <div class="comment"><span class="comment-author">${escapeHtml(c.authorName || "athlete")}</span><span class="comment-text">${escapeHtml(c.text)}</span></div>
      `).join("");
    });
    likeBtn.addEventListener("click", async () => {
      if (!C.user) return openAuthModal("signin");
      try { await C.toggleLike(act.cloudId); } catch (e) { console.error(e); }
    });
    const sendComment = async () => {
      const input = document.getElementById("comment-input");
      const text = input.value.trim();
      if (!text) return;
      if (!C.user) return openAuthModal("signin");
      try { await C.addComment(act.cloudId, text); input.value = ""; }
      catch (e) { toast("Couldn't post comment", "error"); }
    };
    document.getElementById("comment-send")?.addEventListener("click", sendComment);
    document.getElementById("comment-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") sendComment(); });
  }

  function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  // Boot cloud UI either now or when cloud.js finishes loading
  if (window.Cloud) wireCloudUI();
  else window.addEventListener("pacepost-cloud-ready", () => { wireCloudUI(); syncCloudUI(); });
})();
