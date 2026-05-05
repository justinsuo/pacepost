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
  let profile = { name: "", joinedAt: null, muteCoach: false };
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

    wireNav();
    wireTopbar();
    wireTrack();
    wireRoutesView();
    wireHistory();
    wireProfile();
    wireLiveControls();
    wireDetailModal();
    wireInstallApp();

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
    if (name === "profile") renderProfile();
    window.scrollTo(0, 0);
  }

  // ─── Top bar ────────────────────────────────────────────────
  function wireTopbar() {
    document.getElementById("profile-btn").addEventListener("click", () => switchView("profile"));
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
      <div class="hero-stat">${totalActs ? totalMi.toFixed(1) + " mi" : "Welcome 👋"}</div>
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
      recentEl.innerHTML = `<div class="empty-state" style="padding:24px;"><div class="empty-icon">📭</div><div>No activities yet.</div></div>`;
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
        tag: "Morning ⚡",
        title: w.name,
        meta: `${w.duration_min} min · ${w.description}`,
        go: () => startCoachedWorkout(w.id),
      };
    }
    if (isEvening) {
      const r = routes.find((x) => x.id === "berkeley-marina-walk") || routes.find((r) => r.kind === "walk");
      if (r) return {
        tag: "Evening 🌅",
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
  function wireRoutesView() {
    document.querySelectorAll("#routes-filter .filter-chip").forEach((c) => {
      c.addEventListener("click", () => {
        document.querySelectorAll("#routes-filter .filter-chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        routeFilter = c.dataset.routeKind;
        renderRoutes();
      });
    });
  }
  function renderRoutes() {
    const container = document.getElementById("route-cards");
    container.innerHTML = "";
    const list = routeFilter === "all" ? routes : routes.filter((r) => r.kind === routeFilter);
    list.forEach((r) => container.appendChild(routeCardEl(r)));
  }

  function routeCardEl(r) {
    const el = document.createElement("div");
    el.className = "route-card";
    const stars = ratingStars(routeRatings[r.id] || 0);
    el.innerHTML = `
      <div class="route-head">
        <div>
          <div class="route-name">${escapeHtml(r.name)}</div>
          <div class="route-region">${kindIcon(r.kind)} ${escapeHtml(r.region)}</div>
        </div>
        <div class="act-icon ${r.kind}">${kindIcon(r.kind)}</div>
      </div>
      <div class="route-tags">${r.tags.map((t) => `<span class="route-tag">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="route-summary">${escapeHtml(r.summary)}</div>
      <div class="route-stats">
        <span><strong>${r.distance_km}</strong> km</span>
        <span><strong>${r.elevation_ft}</strong> ft elev</span>
        <span style="color:${r.color || 'inherit'};">${escapeHtml(r.best_time)}</span>
      </div>
      <div class="route-rating-stars editable" data-route-id="${r.id}">${stars}</div>
      <div class="route-actions">
        <button class="btn-primary act-start">▶ Start tracking</button>
        <button class="btn-secondary act-view">Map</button>
      </div>
    `;
    el.querySelector(".act-start").addEventListener("click", (e) => {
      e.stopPropagation();
      startLive(r.kind, { routeId: r.id });
    });
    el.querySelector(".act-view").addEventListener("click", (e) => {
      e.stopPropagation();
      openRouteDetail(r.id);
    });
    el.querySelector(".route-rating-stars").addEventListener("click", (e) => {
      e.stopPropagation();
      const star = e.target.closest("[data-star]");
      if (!star) return;
      const v = parseInt(star.dataset.star, 10);
      routeRatings[r.id] = v;
      PaceDB.putMeta("routeRatings", routeRatings);
      renderRoutes();
      checkAchievements({ ratingsGiven: Object.keys(routeRatings).length });
    });
    return el;
  }

  function ratingStars(value) {
    let html = "";
    for (let i = 1; i <= 5; i++) {
      const filled = i <= value;
      html += `<span data-star="${i}" style="cursor:pointer;color:${filled ? "var(--gold)" : "var(--text-dim)"};">${filled ? "★" : "☆"}</span>`;
    }
    return html;
  }

  // Open a curated route in a small detail modal
  function openRouteDetail(routeId) {
    const r = routes.find((x) => x.id === routeId);
    if (!r) return;
    const overlay = document.getElementById("detail-overlay");
    const title = document.getElementById("detail-title");
    const body = document.getElementById("detail-body");
    title.textContent = r.name;
    document.getElementById("detail-delete").style.display = "none";
    body.innerHTML = `
      <div class="detail-map" id="route-detail-map"></div>
      <div class="detail-stat-grid">
        <div class="detail-stat"><div class="detail-stat-label">Distance</div><div class="detail-stat-val">${r.distance_km} km</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Elevation</div><div class="detail-stat-val">${r.elevation_ft} ft</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Region</div><div class="detail-stat-val">${escapeHtml(r.region)}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Type</div><div class="detail-stat-val">${kindLabel(r.kind)}</div></div>
      </div>
      <div class="detail-section">
        <h4>About</h4>
        <p style="font-size:14px;line-height:1.55;color:var(--text);">${escapeHtml(r.summary)}</p>
        <p style="font-size:13px;color:var(--text-dim);margin-top:6px;">Best time: ${escapeHtml(r.best_time)}</p>
      </div>
      <div class="route-actions" style="margin-top:0;">
        <button class="btn-primary" id="route-detail-start">▶ Start tracking</button>
      </div>
    `;
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    setTimeout(() => {
      const m = L.map("route-detail-map", { zoomControl: true, attributionControl: true });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19, attribution: "© OSM · CARTO" }).addTo(m);
      const ll = [r.start.lat, r.start.lon];
      m.setView(ll, 13);
      L.marker(ll).addTo(m).bindPopup(escapeHtml(r.name)).openPopup();
    }, 80);
    document.getElementById("route-detail-start").addEventListener("click", () => {
      closeDetail();
      startLive(r.kind, { routeId: r.id });
    });
  }

  // ─── History view ───────────────────────────────────────────
  let historyFilter = "all";
  function wireHistory() {
    document.querySelectorAll("#history-filter .filter-chip").forEach((c) => {
      c.addEventListener("click", () => {
        document.querySelectorAll("#history-filter .filter-chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        historyFilter = c.dataset.histKind;
        renderHistory();
      });
    });
  }
  function renderHistory() {
    const list = document.getElementById("history-list");
    const empty = document.getElementById("history-empty");
    list.innerHTML = "";
    const filtered = historyFilter === "all" ? activities : activities.filter((a) => a.kind === historyFilter);
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
    document.getElementById("profile-name").value = profile.name || "";
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
    document.getElementById("live-mute").addEventListener("click", () => {
      profile.muteCoach = !profile.muteCoach;
      PaceDB.putMeta("profile", profile);
      document.getElementById("live-mute").textContent = profile.muteCoach ? "🔇" : "🔊";
      toast(profile.muteCoach ? "Audio muted" : "Audio on", "success");
    });
  }

  function startLive(kind, options = {}) {
    if (!navigator.geolocation) {
      toast("Geolocation not supported in this browser", "error");
      return;
    }
    activityForCoach = options;
    tracker = new PaceTracker();
    tracker.on("tick", onTick);
    tracker.on("fix", onFix);
    tracker.start(kind, options);

    document.getElementById("live-overlay").classList.add("open");
    document.getElementById("live-overlay").setAttribute("aria-hidden", "false");
    document.getElementById("live-kind").textContent = kindLabel(kind);
    document.getElementById("live-mute").textContent = profile.muteCoach ? "🔇" : "🔊";
    document.getElementById("live-pause").textContent = "Pause";
    document.getElementById("live-pause").classList.remove("paused");
    document.getElementById("coach-strip").style.display = "none";

    // Init the live map
    setTimeout(initLiveMap, 80);

    // If a coached workout is bundled with this start, kick off the coach
    if (options.coachWorkoutId) {
      const w = workouts.find((x) => x.id === options.coachWorkoutId);
      if (w) startCoachEngine(w);
    }
  }

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
    document.getElementById("live-time").textContent = formatDuration(state.elapsedMs / 1000);
    document.getElementById("live-distance").textContent = formatDistance(state.distanceKm);
    const pace = tracker.recentPaceSecPerKm(60000);
    if (pace && pace < 600) {
      document.getElementById("live-pace").textContent = formatPaceSecPerMi(pace * 1.609);
    } else {
      document.getElementById("live-pace").textContent = "—";
    }
    const speedMph = (state.distanceKm / Math.max(0.001, state.elapsedMs / 3600000)) * 0.621371;
    if (state.elapsedMs > 5000 && speedMph > 0) {
      document.getElementById("live-speed").textContent = speedMph.toFixed(1) + " mph";
    }
    // Coach tick
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
    // Attach context (route / coach)
    if (activityForCoach?.routeId) act.followingRouteId = activityForCoach.routeId;
    if (activityForCoach?.coachWorkoutId) act.coachWorkoutId = activityForCoach.coachWorkoutId;
    await PaceDB.putActivity(act);
    activities = await PaceDB.allActivities();
    closeLive();
    // Update PRs + check achievements
    const prUpdates = updatePRsFor(act);
    const newlyUnlocked = checkAchievements({ ratingsGiven: Object.keys(routeRatings).length, prsBroken: prUpdates });
    renderAll();
    speakAndToast(`${kindLabel(act.kind)} saved · ${formatDistance(act.distanceKm)} · ${formatDuration(act.elapsedMs / 1000)}`, "success");
    newlyUnlocked.forEach((d) => speakAndToast(`Unlocked: ${d.icon} ${d.name}`, "achievement"));
    setTimeout(() => openActivityDetail(act.id), 600);
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
    const photosHtml = (a.photos || []).map((p, i) =>
      `<img class="detail-photo" data-photo-idx="${i}" src="${p}" alt="" />`
    ).join("");
    const splitsHtml = (a.splits || []).length
      ? `<div class="detail-section"><h4>Splits</h4>${renderSplitsHtml(a.splits)}</div>`
      : "";
    const ratedHtml = a.followingRouteId
      ? `<div class="detail-section"><h4>Rate this route</h4><div class="route-rating-stars editable" data-route-id="${a.followingRouteId}">${ratingStars(routeRatings[a.followingRouteId] || 0)}</div></div>`
      : "";
    document.getElementById("detail-body").innerHTML = `
      <div class="detail-map" id="detail-map"></div>
      <div class="detail-stat-grid">
        <div class="detail-stat"><div class="detail-stat-label">Distance</div><div class="detail-stat-val">${formatDistance(a.distanceKm)}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Time</div><div class="detail-stat-val">${formatDuration(a.elapsedMs / 1000)}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">${a.kind === "drive" ? "Avg speed" : "Pace"}</div><div class="detail-stat-val">${a.kind === "drive" ? speedMph.toFixed(1) + " mph" : formatPace(a)}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Elevation</div><div class="detail-stat-val">${Math.round(elev)} ft</div></div>
      </div>
      <div class="detail-section"><h4>Notes</h4>
        <textarea class="detail-notes" id="detail-notes" placeholder="How did it feel?">${escapeHtml(a.notes || "")}</textarea>
      </div>
      <div class="detail-section"><h4>Photos</h4>
        <div class="detail-photos" id="detail-photos">
          ${photosHtml}
          <label class="add-photo-btn" for="add-photo-input">+</label>
          <input type="file" id="add-photo-input" accept="image/*" capture="environment" style="display:none;" />
        </div>
      </div>
      ${splitsHtml}
      ${ratedHtml}
    `;
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    setTimeout(() => initDetailMap(a), 80);

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
      toast("pacepost is installed 🎉", "success");
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

  function formatDistance(km) {
    if (!km) return "0.00 mi";
    const mi = km * 0.621371;
    return mi >= 10 ? `${mi.toFixed(1)} mi` : `${mi.toFixed(2)} mi`;
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
      const speedMph = (act.distanceKm / Math.max(0.001, act.elapsedMs / 3600000)) * 0.621371;
      return speedMph.toFixed(1) + " mph";
    }
    const distMi = act.distanceKm * 0.621371;
    if (!distMi) return "—";
    const paceSecPerMi = (act.elapsedMs / 1000) / distMi;
    return formatPaceSecPerMi(paceSecPerMi);
  }
  function formatPaceSecPerMi(paceSecPerMi) {
    if (!isFinite(paceSecPerMi) || paceSecPerMi <= 0 || paceSecPerMi > 60 * 60) return "—";
    const m = Math.floor(paceSecPerMi / 60);
    const s = Math.round(paceSecPerMi % 60);
    return `${m}:${String(s).padStart(2, "0")} /mi`;
  }
  function formatPaceFor(timeSec, km) {
    const distMi = km * 0.621371;
    return formatPaceSecPerMi(timeSec / distMi);
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

  function kindIcon(k) { return ({ run: "🏃", drive: "🏎️", bike: "🚴", walk: "🚶" }[k] || "▶"); }
  function kindColor(k) { return getComputedStyle(document.documentElement).getPropertyValue("--" + k).trim() || "#f97316"; }
  function kindLabel(k) { return ({ run: "Run", drive: "Drive", bike: "Bike", walk: "Walk" }[k] || k); }

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
})();
