# pacepost

> Personal fitness tracker + social feed. Tracks runs, drives, rides, hikes, golf rounds, lifts, yoga, climbs, ski/snowboard sessions, surf days, kayak trips, rows, offroad runs, and walks. Built as a PWA, wraps to native iOS via Capacitor, syncs to a Google Sheet, and is wired up for Firebase-backed social features (auth, feed, comments, messages) when you plug in a project.

---

## What it does

### Activity tracking
16 activity types, each with its own icon, color, and live UI:
- **GPS-tracked:** Run · Drive · Offroad · Bike · Walk · Hike · Swim · Ski · Snowboard · Surf · Kayak · Golf
- **Indoor (time + rep counter):** Yoga · Workout · Climb · Row

Outdoor activities get a real-time map with your trail drawn live, distance, pace (or speed for drive/offroad), splits, elevation gain, calorie estimate from MET × weight × time, and a route polyline if you started from a saved route. Indoor activities get a focused big-clock timer, calorie estimate, and a ± rep counter.

### Routes
**72 curated Bay Area + NorCal routes** out of the box covering all five outdoor categories:

- **40 hand-picked classics** — Lake Merritt, Stanford Dish, Lands End, Crissy Field, Sweeney Ridge, Mt Tam East Peak, Dipsea Trail, Three Bears Loop, OLH, Skyline Boulevard, Highway 1 Pacifica→HMB, Hwy 9, Mt Hamilton Road, plus 27 more
- **21 touge driving routes** auto-imported from [tougespot-in-norcal](https://github.com/justinsuo/tougespot-in-norcal) — Pinehurst, Wildcat Canyon, Grizzly Peak, Page Mill, Niles Canyon, Mines Road, Silverado Trail, Panoramic Highway, plus the Sacramento Valley straights, with their actual road-traced waypoints
- **11 NorCal/CA offroad spots** — Rubicon Trail, Fordyce Creek, Hollister Hills SVRA, Carnegie SVRA, Stonyford OHV, Saline Valley Road, Oceano Dunes, plus more

Routes view has tabs (List / Map), filter chips by activity kind plus a Mine tab, and a personal **route builder** for runs/drives/bikes/walks/hikes/swims — tap waypoints on a map, name it, save it.

Tap any route card to open its full-page detail: a swipeable media carousel (route polyline drawn along actual roads via OSRM + photos), distance/elevation/best-time/attempts stats, About copy, your previous attempts with PRs highlighted, and a Start/Time-this-drive action.

### Drive route timing (Strava-segment-style)
Time yourself on the same route, compare best/avg/recent attempts. Drive and offroad routes show a "Time this drive/offroad" button on detail; finishing a drive while following a saved route automatically logs the attempt against that route's PR table.

### Coached workouts
9 templates (Morning HIIT, Tabata, Fartlek 30, Track 400s, Easy Recovery, 90-min Long Run, Bike Zone-2, Bike Sprint Intervals, Sunday Cruise). Each step has audio cues (Web Speech voice + Web Audio beeps) and a visual countdown.

### Golf (hybrid)
Start golf from Track → GPS walk-tracking begins like any other activity → tap **Scorecard** in the live header to open the digital scorecard mid-round. Build courses (9 or 18 holes, per-hole par) once, reuse them forever. Score per hole with ± steppers, see live vs-par tally, birdie/par/bogey labels. When you tap Finish, the GPS track and scorecard save together.

### Activity history + detail
Filter by kind, search by name/notes/tags. Tap any activity → full-page detail with:
- Swipeable media carousel: GPS map first, photos after
- Distance · time · pace/speed · elevation · calories · effort (RPE 1–10) · weather at start
- Notes, photos, splits, route rating
- For activities posted to the cloud: like + comment thread (live Firestore listeners when configured)

### Achievements + streaks + PRs
30 achievements across Bronze / Silver / Gold / Platinum tiers — distance club, streak tiers, Hill Climber, Sprinter, Touge Driver, Multimodal day, Variety Pack, and more. Auto-checked after every saved activity. PRs auto-tracked at 1k, 1mi, 5K, 10K. Aggregate heatmap of every GPS fix you've recorded.

### Profile + customization
- Bio (one-line) and location
- 10 preset avatar colors
- Weight (lbs or kg) and Height (ft + in, or cm)
- Auto-converts when you flip the units toggle
- Member-since, total miles, total time, achievement progress

### Settings
- **Units** — Imperial / Metric (everything respects this: km↔mi, ft↔m, mph↔km/h, /mi↔/km, lbs↔kg, in↔cm)
- Audio cues toggle
- Auto-pause toggle
- Public posts by default toggle
- Keep screen awake during tracking
- Export/import all data as JSON
- Reset everything

### Social (feed + profiles + DMs)
- **Feed** tab in the bottom nav — Nearby / All / Friends filters, default Nearby
- 5 placeholder users (Mike Zhao, Priya Nakamura, Daniel Kim, Sam Yamamoto, Alex Rivera) with 11+ posts and real photos so the feed is populated for testing
- Tap a name or avatar → **full-page profile view** with cover gradient, large avatar, bio, location, member-since, follower/following counts, Follow + Message buttons, and their recent activities
- **Direct messages** — DM icon in the topbar opens a full-page inbox of conversations. Tap → opens the user profile → tap Message to start/continue a thread. Threads persist locally.
- Likes + comments work locally on placeholder posts (in-memory) and on real cloud posts (live Firestore listeners) when Firebase is configured

### Google Sheets sync
Profile → Google Sheets sync. Paste a Google Apps Script Web App URL → enable → every saved activity auto-pushes Date · Kind · Name · Distance · Duration · Pace · Elevation · Calories · RPE · Notes to your sheet. Step-by-step setup with copy-pasteable script lives in the help modal. No Zapier, no Sheets API key — your own script, your own sheet.

### Offline-first
- All web assets bundled into the iOS app — works without network
- Map tiles cached aggressively (1000 tiles via service worker) — pan an area online before heading out, tiles stay available offline
- GPS works regardless of connectivity (hardware-level)
- Firestore offline persistence — activities posted while offline queue up and sync when back online
- Falls back to straight start→end line for routes when OSRM road-snap can't reach the internet

### Optional Firebase backend
`firebase-config.js` ships as a placeholder. Drop in your config object from a Firebase project (Auth: email/pwd, Firestore, Storage) and the social features come alive: real signup/signin, posts pushed to a shared feed, photos uploaded to Storage, real comments + likes from other users, live updates via Firestore listeners.

---

## Stack

Pure vanilla. No framework, no bundler, no build step for the web layer.

- **HTML / CSS / vanilla JS** — single page, multiple views toggled by `data-view`
- **IndexedDB** via `db.js` for activity storage
- **Geolocation API** via `tracker.js` for GPS
- **Leaflet 1.9** + **leaflet.heat** for maps + heatmap
- **OSRM public API** for road-snapping route polylines (with localStorage caching)
- **Web Speech API** for coach voice cues
- **Web Audio API** for HIIT beeps
- **open-meteo** (free, no key) for weather snapshots
- **Service Worker** (`sw.js`) for offline shell + tile cache
- **Capacitor 6** to wrap into a native iOS app
- **Firebase 10 modular SDK** (loaded via ES module from gstatic) for auth + Firestore + Storage, optional

---

## Run it

### As a web app

```bash
cd pacepost
python -m http.server 8766
# open http://localhost:8766/
```

GPS tracking requires HTTPS or localhost. GitHub Pages and localhost both work.

### As an iOS app (Simulator)

```bash
cd pacepost
npm install
npx cap sync ios
cd ios/App
# Build pods first (one-time)
for tgt in CapacitorCordova Capacitor CapacitorGeolocation CapacitorSplashScreen Pods-App; do
  xcodebuild -project Pods/Pods.xcodeproj -target "$tgt" -configuration Debug \
    -sdk iphonesimulator -arch arm64 CODE_SIGNING_ALLOWED=NO build
done
# Then the app
xcodebuild -project App.xcodeproj -target App -configuration Debug \
  -sdk iphonesimulator -arch arm64 CODE_SIGNING_ALLOWED=NO build

# Create + boot a simulator + install + launch
SIM_ID=$(xcrun simctl create "pacepost-test" \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
  com.apple.CoreSimulator.SimRuntime.iOS-26-4)
xcrun simctl boot "$SIM_ID"
open -a Simulator
xcrun simctl install "$SIM_ID" build/Debug-iphonesimulator/App.app
xcrun simctl launch "$SIM_ID" com.justinsuo.pacepost
```

Requires Xcode 26.4+ and the iOS 26.4 simulator runtime (`xcodebuild -downloadPlatform iOS` if not already installed).

### As an iOS app (real iPhone, free Apple ID)

1. Open `ios/App/App.xcworkspace` in Xcode
2. Select the **App** target → **Signing & Capabilities**
3. Set **Team** to your Apple ID (Personal Team — free)
4. Change **Bundle Identifier** to something unique like `com.yourname.pacepost.dev`
5. Plug iPhone in, unlock, tap Trust
6. Select your iPhone as the run destination, hit ▶
7. On iPhone: Settings → General → VPN & Device Management → trust your dev cert
8. Re-launch from home screen

Free signing certificates expire every 7 days. For permanent install, TestFlight, or the App Store, enroll in Apple Developer Program ($99/yr).

### Rebuild after editing web files

```bash
cd pacepost
# Mirror web assets into www/ (the Capacitor source folder)
rsync -a --delete \
  --exclude='node_modules' --exclude='ios' --exclude='android' \
  --exclude='www' --exclude='.git' --exclude='.github' \
  --exclude='package*.json' --exclude='capacitor.config.json' \
  --exclude='LICENSE' --exclude='README.md' \
  ./ ./www/
npx cap copy ios

# Then rebuild + reinstall via xcodebuild + simctl as above
```

---

## Firebase setup (optional, for social features)

Without Firebase the app runs perfectly as a local-only fitness tracker — placeholder users + Mike Zhao posts populate the feed for testing. To enable real signin and shared social:

1. Go to https://console.firebase.google.com → Add project → enable Email/Password auth → create Firestore in production mode → enable Storage
2. Project settings → Your apps → register a Web app → copy the `firebaseConfig` object
3. Paste into [`firebase-config.js`](firebase-config.js) — the file is already wired for it
4. Deploy basic Firestore + Storage security rules (the app talks to `users/{uid}`, `activities/{id}`, `activities/{id}/comments/{cid}`, `activities/{id}/likes/{uid}`, and `users/{uid}/...` in Storage)

---

## Project layout

```
pacepost/
├── index.html              # All views, modals, nav
├── app.js                  # All app logic (~3500 lines, one IIFE)
├── styles.css              # All styling
├── db.js                   # IndexedDB wrapper
├── tracker.js              # GPS tracker with pause/resume + splits
├── cloud.js                # Firebase wrapper (ES module)
├── firebase-config.js      # Placeholder for your Firebase config
├── sw.js                   # Service worker (offline shell + tile cache)
├── manifest.webmanifest    # PWA manifest
├── data/
│   ├── routes.json         # 72 curated Bay Area + NorCal routes
│   ├── workouts.json       # 9 coached workout templates
│   └── achievements.json   # 30 achievement definitions
├── www/                    # Capacitor source folder (mirror of root web files)
├── ios/                    # Capacitor-generated Xcode project
├── capacitor.config.json
└── package.json
```

---

## Privacy + data ownership

All your data lives on your device by default. Profile → Export downloads a JSON backup; Import restores it. Reset clears everything.

When Firebase is configured and you sign in, activities you save get pushed to your Firebase project (which you own and control). Public-by-default means others can see your feed posts; we'll add a per-post privacy toggle next.

Google Sheets sync uses a webhook URL you control — your script, your sheet, your data.

---

## License

MIT
