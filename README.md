# pacepost ⚡

> A Strava-style tracker for runs, drives, rides, and walks — with coached workouts, achievements, streaks, and a Beli-style "rank the spots" twist.

Single-user PWA. Everything lives in your browser (IndexedDB). No accounts, no backend, no telemetry, no ads.

**Live:** _link goes here once deployed_

## Features

### Track every kind of move
- **Run** 🏃 · **Drive** 🏎️ · **Bike** 🚴 · **Walk** 🚶
- Real GPS tracking with pace, distance, time, splits, elevation gain
- Pause / resume mid-activity
- Live map shows your trail in real time

### Coached workouts
- HIIT (Tabata, Morning Jolt)
- Track repeats (400m × 6)
- Fartlek, easy recovery, long runs
- Bike Zone-2, sprint intervals
- Each step has audio + visual countdown — beep on transitions, voice on each cue
- Mute toggle right on the live screen

### Curated routes
- Hand-picked running, biking, driving, and walking routes around the Bay Area
- Tap one to start tracking + auto-attribute the activity to that route
- Beli-style ★ rating per route (1–5 stars)

### Achievements
- 30 badges across bronze / silver / gold / platinum tiers
- First Steps, 5K/10K/Half/Full club, streaks (3 / 7 / 30 / 100 days), Hill Climber, Sprinter, Touge Driver, Multimodal day, Variety Pack, etc.
- Auto-checked after every saved activity

### Goals & streaks
- Daily activity streak (any kind counts)
- Weekly mileage progress
- Monthly activity-count target
- Total badges progress

### PRs
- Personal records auto-tracked at 1km, 1 mi, 5K, 10K
- Detailed splits per kilometer

### Photos & notes
- Snap a photo or upload from gallery on any activity
- Auto-resized + stored locally
- Free-form notes per activity

### Heatmap
- Aggregate Leaflet heatmap of every GPS fix you've recorded

### Built like a real app
- Bottom-nav iOS/Android-style UI
- Installable PWA — "Add to home screen"
- Offline-first via service worker
- Works on phones, tablets, desktops

## Run locally

```bash
git clone https://github.com/justinsuo/pacepost.git
cd pacepost
python -m http.server 8765
# open http://localhost:8765/
```

GPS tracking requires HTTPS or localhost. GitHub Pages is HTTPS — local dev server works on localhost.

## Stack

- **Vanilla JS** — no framework, no bundler, no build step
- **IndexedDB** for activity storage (`db.js` thin wrapper)
- **Geolocation API** for GPS (`tracker.js`)
- **Leaflet** for maps + heatmap
- **Web Speech API** for coach voice cues
- **Web Audio API** for HIIT beeps
- **Service Worker** for offline support

## Privacy

All data stays in your browser. Use **Profile → Export** to back up to a JSON file you control. **Import** to restore on a new device.

## License

MIT
