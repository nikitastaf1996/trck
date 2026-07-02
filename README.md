# trck

A small **React Native** Android app that records GPS tracks in the background
and saves them as `.gpx` files to the public `Downloads/trck/` folder.

> The APK is committed in [`apk/trck-release.apk`](./apk/trck-release.apk)
> because the developer's PC is down and they cannot build it themselves.
> See [`AGENTS.md`](./AGENTS.md) for the full explanation and the rebuild
> workflow.

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
The APK at `apk/trck-release.apk` is up to date with the source.

| Metric | Value |
|---|---|
| `versionCode` | 5 |
| `versionName` | 1.3.1 |
| APK size | 24.3 MB |
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

1. Download `apk/trck-release.apk` from this repo.
2. On your Android phone, open the file (e.g. from the Files app or a
   browser download notification).
3. Allow "install from unknown sources" if prompted.
4. Open the app, grant the location and notification permissions, and
   tap **СТАРТ**.

GPX files will appear under `Downloads/trck/`.

## How to build (for agents / future me)

See [`AGENTS.md`](./AGENTS.md) for the full workflow. The short version:

```bash
npm install
npx tsc --noEmit && npx jest && npx eslint .   # JS checks
cd android
./gradlew --no-daemon assembleRelease
cp app/build/outputs/apk/release/app-release.apk ../apk/trck-release.apk
```

Requires OpenJDK 21, Android SDK (platform-tools, android-35,
build-tools 35.0.0, NDK 27.1.12297006, CMake 3.22.1), and Node.js 22+.

## Tech stack

- React Native 0.86 (Hermes JS engine)
- Kotlin (Android side)
- Android `LocationManager` (no Google Play Services dependency)
- Foreground service + `WakeLock` + `START_STICKY` for stability
- `MediaStore.Downloads` for writing GPX files (Android 10+), with a
  legacy `Environment.DIRECTORY_DOWNLOADS` fallback for older versions
- Pure-function GPX post-processing (Gaussian smoothing + Douglas-Peucker)
- XmlPullParser-based GPX parsing (no regex)

## Documentation

- [`AGENTS.md`](./AGENTS.md) — build instructions, architecture notes,
  code organisation principles.
- [`CHANGELOG.md`](./CHANGELOG.md) — version history, invariant list
  (L* / U* / O* / Task N tags), bug-fix rationales.
