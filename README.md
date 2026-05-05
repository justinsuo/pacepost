# pacepost ⚡

> Fitness tracker for runs, drives, rides, walks, hikes, swims, strength, yoga. Coached workouts, achievements, streaks, custom route builder, calorie + weather snapshots, effort ratings.

Single-user PWA. Everything stays in your browser (IndexedDB). No accounts, no backend, no telemetry, no ads.

## Features

### 8 activity types
🏃 Run · 🏎️ Drive · 🚴 Bike · 🚶 Walk · 🥾 Hike · 🏊 Swim · 🏋️ Strength · 🧘 Yoga

GPS-tracked outdoors (run/drive/bike/walk/hike); time-only for indoor (swim/strength/yoga).

### Live tracking
- Real GPS pace, distance, time, splits, elevation gain
- Pause / resume mid-activity
- Live map shows your trail in real time
- Auto-detected splits per kilometer with the fastest highlighted

### Coached workouts
9 templates: Morning Jolt HIIT · Tabata · Fartlek 30 · Track 400s · Easy Recovery · 90-min Long Run · Bike Zone-2 · Bike Sprint Intervals · Sunday Cruise. Each step has audio cues (Web Speech voice + Web Audio beeps) and a visual countdown.

### Curated + custom routes
- 14 hand-picked Bay Area routes across all outdoor activity types
- **Build your own** — tap waypoints on a map, name it, save. Personal routes show up alongside curated ones with a ⭐ Mine filter.
- Beli-style 1–5 star ratings on any route, persisted locally

### After every activity
- **Effort prompt** (RPE 1–10) — "how hard was that?"
- **Calorie estimate** from MET × your weight × duration
- **Weather snapshot** (temp, wind, conditions) auto-pulled from open-meteo at the start point
- Editable notes + multi-photo upload

### 30 achievements + streaks + PRs
Bronze / Silver / Gold / Platinum tiers. First Steps, 5K-10K-Half-Marathon distance club, streak tiers (3 / 7 / 30 / 100 days), Hill Climber, Sprinter, Touge Driver, Multimodal day, Variety Pack, etc. Auto-checked after every saved activity.

PRs auto-tracked at 1k, 1mi, 5K, 10K (extracted from any longer run).

### Heatmap
Aggregate Leaflet heatmap of every GPS fix you've recorded.

### Built like a real app
- Bottom-nav iOS/Android-style UI
- Light theme with subtle shadows + warm gradient hero
- **Installable PWA** — Add to home screen on iPhone/Android, install button on desktop Chrome/Edge
- Offline-first via service worker
- Works on phones, tablets, desktops

## Run locally

```bash
git clone https://github.com/justinsuo/pacepost.git
cd pacepost
python -m http.server 8766
# open http://localhost:8766/
```

GPS tracking requires HTTPS or localhost. GitHub Pages is HTTPS — local dev server works on localhost.

## Install as an app

### iPhone / iPad (Safari)
1. Open the site in Safari
2. Tap **Share** (the box-with-arrow at the bottom)
3. **Add to Home Screen** → Add

It now lives on your home screen, opens fullscreen, no Safari chrome.

### Android (Chrome)
Open in Chrome → ⋮ menu → **Install app** (or **Add to home screen**).

### Desktop (Chrome / Edge)
Address bar shows an install icon (screen + ↓), or ⋮ menu → **Install pacepost**.

## Wrapping as a real iOS / Android app

This project includes a [Capacitor](https://capacitorjs.com) config (`capacitor.config.json` + `package.json` deps). Capacitor wraps the same web app into native iOS and Android shells so you can ship to the App Store / Play Store.

**Requires macOS for iOS builds.** Apple's tooling is Mac-only. Options:

| Path | Cost | Notes |
|---|---|---|
| Real Mac | One-time | Mac mini base ~$600. Cleanest. |
| MacInCloud / MacStadium | $20–30/mo | Rent a hosted Mac, drive Xcode via RDP/VNC. |
| GitHub Actions `macos-latest` runner | Free | Free 2,000 build minutes/mo for public repos; CI builds + uploads to TestFlight. |
| PWABuilder.com | Free | Generates an iOS package from a deployed PWA URL. Still need a Mac to actually submit. |

### One-time setup (on Mac)

```bash
npm install
npx cap add ios       # creates ios/ folder
npx cap add android   # creates android/ folder
npx cap sync
npx cap open ios      # opens Xcode
```

In Xcode:
1. Select a Team (your Apple ID, free) under Signing & Capabilities
2. Pick your iPhone as the run target
3. ▶ Run — pacepost installs on your phone for 7 days (free Apple ID limit) or 1 year (paid Apple Developer Program at $99/yr)

### App Store distribution

Requires:
- Apple Developer Program enrollment ($99/yr)
- Signing certificate + provisioning profile
- App Store Connect listing (icon, screenshots, privacy policy)
- Archive in Xcode → upload via Organizer → submit for review

App review typically takes 24-48 hours.

### Android (free, much easier)

```bash
npx cap add android
npx cap open android
# In Android Studio: Build → Generate Signed Bundle → APK
```

Sideload the APK directly to any Android phone. Google Play Store: $25 one-time developer fee.

## Stack

- **Vanilla JS** — no framework, no bundler, no build step
- **IndexedDB** for activity storage (`db.js` thin wrapper)
- **Geolocation API** for GPS (`tracker.js`)
- **Leaflet** for maps + heatmap
- **Web Speech API** for coach voice cues
- **Web Audio API** for HIIT beeps
- **open-meteo** (free, no key) for weather snapshots
- **Service Worker** for offline support
- **Capacitor** (optional) for native iOS / Android wrapping

## Privacy

All data stays in your browser. Use **Profile → Export** to back up to a JSON file you control. **Import** to restore on a new device.

## License

MIT
