# trck

A small **React Native** Android app that records GPS tracks in the background
and saves them as `.gpx` files to the public `Downloads/trck/` folder.

> Release APKs are built automatically by GitHub Actions on every push to
> `main`. Download the latest from the
> [Actions tab](https://github.com/nikitastaf1996/symmetrical-goggles/actions) —
> click the most recent **Build APK** run, then scroll to **Artifacts**.
> See [`AGENTS.md`](./AGENTS.md) for the full build workflow.

## Features

- Big **Start / Stop** button.
- Duration of recording, ticking every second.
- Persistent **foreground-service notification** with a **Stop** action —
  stop recording without ever opening the app.
- GPS fixes saved as a GPX 1.1 file under `Downloads/trck/`.
- Recording survives the app being backgrounded, swiped away from
  recents, the screen turning off, and (best-effort) the system killing
  the process.
- **Five independent post-processing toggles:**
  - On-the-fly track filtering (accuracy ≤ 25 m, velocity ≤ 20 km/h)
  - Gaussian smoothing (post-processing, ±5-point kernel)
  - Radial distance filter (on-the-fly, drop fixes < X m from last kept)
  - Time sampling (on-the-fly, keep every N-th fix)
  - Douglas-Peucker simplification (post-processing)
- **Auto-pause** when stationary (speed < 0.35 m/s + displacement < 3.5 m
  over 10 s); auto-resumes when moving again.
- **Gap detection** — no fix for 15 s → new `<trkseg>` + red banner.
- **Moving-time** display toggle (excludes paused / signal-lost intervals).
- Russian-language UI.

## Current status

**v1.3.1** — fully refactored. Every source file is under 500 lines.
APKs are built by GitHub Actions; the latest successful build is always
one click away from the [Actions tab](https://github.com/nikitastaf1996/symmetrical-goggles/actions).

| Metric | Value |
|---|---|
| `versionCode` | 5 |
| `versionName` | 1.3.1 |
| APK size | ~24 MB (varies slightly per build) |
| Largest source file | 497 lines (`GpsRecorderService.kt`) |
| TypeScript tests | 39 / 39 passing |
| Kotlin files | 26 |
| TypeScript files | 22 |

### What was refactored (v1.3.1)

The two giant files that prompted the refactor are now both under 500
lines:

| File | Before | After | Reduction |
|---|---|---|---|
| `GpsRecorderService.kt` | 3 445 | **497** | −86 % |
| `App.tsx` | 2 135 | **496** | −77 % |
| `GpsRecorderModule.kt` | 1 223 | **373** | −69 % |

21 new Kotlin modules and 12 new TypeScript modules were extracted. No
behaviour changed — every invariant, threshold, and Russian string is
preserved. See [`CHANGELOG.md`](./CHANGELOG.md) for the full breakdown.

## How to install

1. Go to the [Actions tab](https://github.com/nikitastaf1996/symmetrical-goggles/actions).
2. Click the most recent successful **Build APK** run.
3. Scroll to the bottom — **Artifacts** section.
4. Click `trck-apk` to download a `.zip` containing the APK.
5. Unzip and copy `app-release.apk` to your Android phone.
6. Open the file (e.g. from the Files app or a browser download
   notification).
7. Allow "install from unknown sources" if prompted.
8. Open the app, grant the location and notification permissions, and
   tap **СТАРТ**.

GPX files will appear under `Downloads/trck/`.

## How to build

The canonical build path is GitHub Actions — see
[`AGENTS.md`](./AGENTS.md) for the full workflow. Every push to `main`
triggers a fresh release-APK build, distributed as a workflow artifact
with 30-day retention.

For local builds (optional):

```bash
npm ci
cd android
./gradlew --no-daemon assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk
```

Requires JDK 17 (or 21), Android SDK (platform-tools, android-35,
build-tools 35.0.0, NDK 27.1.12297006), and Node.js 22+. The debug
keystore is generated automatically by the GitHub Actions workflow; for
local builds, generate it once with `keytool` (see AGENTS.md → Signing).

## Tech stack

- React Native 0.86 (Hermes JS engine, new architecture enabled)
- Kotlin (Android side)
- Android `LocationManager` (no Google Play Services dependency)
- Foreground service + `WakeLock` + `START_STICKY` for stability
- `MediaStore.Downloads` for writing GPX files (Android 10+), with a
  legacy `Environment.DIRECTORY_DOWNLOADS` fallback for older versions
- Pure-function GPX post-processing (Gaussian smoothing + Douglas-Peucker)
- XmlPullParser-based GPX parsing (no regex)
- GitHub Actions for CI / APK distribution

## Documentation

- [`AGENTS.md`](./AGENTS.md) — build workflow (GitHub Actions), architecture
  notes, code organisation principles.
- [`CHANGELOG.md`](./CHANGELOG.md) — version history, invariant list
  (L* / U* / O* / Task N tags), bug-fix rationales.
