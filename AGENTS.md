# AGENTS.md

Guide for any AI agent (or human) touching this repository. Explains
**what** the project is, **how** APKs are built, and the **architecture**
of the refactored codebase.

---

## What this project is

`trck` is a small **React Native** Android app that records GPS tracks in
the background and writes them to the public `Downloads/trck/` folder as
`.gpx` files.

Key features:

- A single big **Start / Stop** button.
- A duration display (`mm:ss` or `h:mm:ss`) that ticks every second.
- A persistent **foreground-service notification** with a **Stop** action
  so the user can stop recording without opening the app.
- GPS fixes saved as a GPX 1.1 file under `Downloads/trck/`.
- Recording survives: app backgrounded, app swiped from recents, screen
  off (partial `WakeLock`), and system memory kills (`START_STICKY`).
- Points flushed to a temp file every 5 s so a crash mid-recording still
  yields a usable partial GPX.
- Five independent post-processing toggles (on-the-fly filter, Gaussian
  smoothing, radial distance filter, time sampling, Douglas-Peucker).
- Auto-pause when stationary + gap detection for signal loss.

---

## Project layout

```
.
├── App.tsx                          # RN UI composition root (496 lines)
├── index.js                         # RN entrypoint
├── app.json                         # RN app name
├── package.json                     # JS deps
├── .github/
│   └── workflows/
│       └── build-apk.yml            # GitHub Actions: build release APK on push
├── src/
│   ├── NativeGpsRecorder.ts         # TS bridge to the native module
│   ├── hooks/                       # Extracted React hooks
│   │   ├── useRecordingSession.ts   # 5 event subs + handleStart/Stop
│   │   ├── useSettings.ts           # 11 settings state + 10 handlers
│   │   ├── useRecordingEventHandlers.ts  # event handler factories
│   │   ├── useRecordingControls.ts  # handleStart/handleStop
│   │   ├── usePermissions.ts        # permission + battery-opt
│   │   └── useGnssMonitor.ts        # GNSS status state
│   ├── components/                  # Presentational components
│   │   ├── StatsDisplay.tsx         # TIME/DISTANCE/TEMPO block
│   │   ├── ToggleRow.tsx            # reusable toggle row
│   │   ├── FilterSettingGroup.tsx   # toggle + stepper card
│   │   ├── StartStopButton.tsx
│   │   ├── SavedCard.tsx / ErrorCard.tsx / Overlays.tsx / Banners.tsx
│   │   ├── BigStat.tsx / Divider.tsx / GnssPill.tsx / StepperRow.tsx
│   │   └── ErrorBoundary.tsx
│   └── styles/
│       ├── index.ts                 # COLOR palette + formatters
│       └── appStyles.ts             # StyleSheet entries
└── android/
    ├── build.gradle                 # Top-level gradle config
    ├── settings.gradle
    ├── gradle.properties
    ├── gradlew / gradlew.bat
    └── app/
        ├── build.gradle             # App-level config (versionCode, etc.)
        └── src/main/
            ├── AndroidManifest.xml
            ├── java/com/gpsrecorder/
            │   ├── GpsRecorderService.kt          # Service orchestration (497 lines)
            │   ├── LocationChangedHandler.kt      # 8-stage GPS filter pipeline
            │   ├── AutoPauseGapController.kt      # auto-pause + gap state machine
            │   ├── AutoPauseHandler.kt            # auto-pause decision logic
            │   ├── StateRepository.kt             # prefs + START_STICKY recovery
            │   ├── GpsRecorderModule.kt           # @ReactMethod forwarders
            │   ├── SettingsBridge.kt              # 22 settings @ReactMethods
            │   ├── GnssMonitor.kt                 # always-on GNSS monitor
            │   ├── GpsEventEmitter.kt             # singleton event emitter
            │   ├── PermissionHelper.kt            # permission + battery-opt
            │   ├── GpxFileSaver.kt                # finalize/save pipeline
            │   ├── GpxIO.kt                       # GPX parse/format/serialize
            │   ├── GpxPostProcessors.kt           # Gaussian + Douglas-Peucker
            │   ├── TempFileBuffer.kt             # L26 append-only temp file
            │   ├── LocationSource.kt              # GPS + GNSS callbacks
            │   ├── GpsRecorderNotification.kt     # foreground notification
            │   ├── GpsRecorderSettings.kt         # settings keys + defaults
            │   ├── SegmentedBuffer.kt             # track segments + buffer
            │   ├── DistanceAccumulator.kt         # haversine accumulator
            │   ├── WakeLockManager.kt             # PARTIAL_WAKE_LOCK
            │   ├── GpsPoint.kt                    # data class
            │   ├── TrackMath.kt                   # haversine + cross-track
            │   ├── SafeLog.kt                     # privacy-aware logging
            │   ├── MainActivity.kt                # RN activity + perms
            │   ├── MainApplication.kt             # registers GpsRecorderPackage
            │   └── GpsRecorderPackage.kt          # RN package
            └── res/
                ├── drawable/ic_gps_notification.xml
                └── values/strings.xml
```

Every source file is **under 500 lines** — this is a deliberate design
constraint to keep the codebase navigable.

### App-name divergence (O6)

The user-facing app name is **`trck`** (in `app.json`, `strings.xml`,
`AndroidManifest.xml`). The Gradle `rootProject.name` is also `trck`.
However, the **`applicationId`** in `android/app/build.gradle` is
`com.gpsrecorder` — this MUST NOT change. Android treats `applicationId`
as the package identity; changing it would lose all user data and break
sideloaded-APK upgrades.

---

## How APKs are built (GitHub Actions)

> **TL;DR:** Every push to `main` triggers an automatic release-APK build
> in GitHub Actions. Download the APK from the run's **Artifacts** section.
> The APK is no longer committed to the repo.

The workflow lives at `.github/workflows/build-apk.yml`. It:

1. Checks out the repo on `ubuntu-24.04`.
2. Sets up JDK 17 (Temurin) + Android SDK 35 + NDK 27.1.12297006.
3. Sets up Node 22 LTS (React Native 0.86 requires Node ≥ 22.11.0).
4. Runs `npm ci` for deterministic JS dep install.
5. Generates the standard Android `debug.keystore` on the runner (the
   repo's `.gitignore` excludes keystores, so this is needed for every
   fresh build).
6. Runs `./gradlew assembleRelease --no-daemon --stacktrace`.
7. If the release build fails, falls back to `assembleDebug` (more
   forgiving — no ProGuard, no minification).
8. Uploads both the APK (as `trck-apk` artifact, 30-day retention) and
   the full Gradle log (as `build-log` artifact, 7-day retention).
9. Fails the run only if **no APK at all** was produced.

### To download an APK

1. Open https://github.com/nikitastaf1996/symmetrical-goggles/actions
2. Click the most recent **Build APK** run (green check = success).
3. Scroll to the bottom — **Artifacts** section.
4. Click `trck-apk` to download a `.zip` containing the APK.
5. Unzip and sideload `app-release.apk` (or `app-debug.apk` if release
   fell back) onto your phone.

### Why we moved away from committing the APK

Previously the APK binary was checked into the repo at
`apk/trck-release.apk`. This was a workaround for the developer's broken
PC — they couldn't build the APK themselves, so the agent built it and
committed the binary. The downside: every code change bloated the git
history with multi-MB binary diffs, and the committed APK was often
stale relative to the source.

GitHub Actions gives us a cleaner separation: source lives in the repo,
APKs are built on demand and distributed as workflow artifacts. No git
bloat, no staleness — every push produces a fresh APK matching the
latest commit.

### Manual trigger

You can also trigger a build manually without pushing code:

1. Go to https://github.com/nikitastaf1996/symmetrical-goggles/actions
2. Select **Build APK** in the left sidebar.
3. Click **Run workflow** → choose `main` branch → **Run workflow**.

Useful when you want a fresh APK for the current `main` without
modifying any files.

---

## What to do after every code change

1. **Make your source changes** in `App.tsx`, `src/`, or `android/app/src/main/`.
2. **Run the JS checks** locally if you have Node:
   ```bash
   npm install
   npx tsc --noEmit          # TypeScript typecheck
   npx jest                   # 39 tests
   npx eslint .               # lint
   ```
   (The GitHub Actions workflow does NOT run these — only the APK build.
   If you skip them and TS/jest fails, the Gradle build will still
   succeed but the app will crash at runtime on a type or test error.)
3. **Bump `versionCode`** in `android/app/build.gradle` (O25). Android
   refuses sideloaded-APK upgrades when `versionCode` does not strictly
   increase.
4. **Commit and push** to `main`:
   ```bash
   git add -A
   git commit -m "<one-line summary>"
   git push
   ```
5. **Wait for the GitHub Actions build** to finish (~8–15 min on a fresh
   runner, faster with Gradle cache hits).
6. **Download the APK** from the run's Artifacts section (see above).
7. **Sideload and test** on your phone.

No more manual `./gradlew assembleRelease` + `cp` + `git add apk/` —
the workflow handles all of that.

---

## Required build environment (for the GitHub Actions runner)

The workflow handles all of this automatically, but documenting it here
for reference / local builds:

- **JDK 17** (Temurin) — `java -version` reports 17.x.
- **Android SDK** with:
  - `platform-tools`
  - `platforms;android-35`
  - `build-tools;35.0.0`
  - `ndk;27.1.12297006`
- **Node.js 22+** and **npm**.
- **Git** (with SSH deploy key access to the repo).

> The previous local-build docs mentioned JDK 21 + `cmake;3.22.1`. RN
> 0.86's Gradle plugin now auto-installs CMake, and JDK 17 is what
> GitHub's `setup-android` action defaults to. Either JDK 17 or 21
> works for the build; 17 is what the workflow uses.

### Installing the SDK from scratch (for local builds)

```bash
mkdir -p $ANDROID_HOME/cmdline-tools
cd $ANDROID_HOME/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-*.zip && mv cmdline-tools latest
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
           "ndk;27.1.12297006"
```

### Local build (optional — GitHub Actions is the canonical path)

```bash
npm ci
cd android
./gradlew --no-daemon assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk
```

---

## Signing (O3)

The release APK is signed with the **debug keystore** — the same one used
for debug builds. This is intentional for the user's personal sideloading
use case.

- The debug keystore is **not** in version control (O4 — in `.gitignore`).
  The GitHub Actions workflow generates a fresh one per run via `keytool`
  with the standard Android debug cert DN
  (`CN=Android Debug,O=Android,C=US`), so APKs built by Actions will
  install over APKs built locally (same cert DN → same signing identity).
- The signing certificate differs between machines. If you switch
  machines or build with a different `keytool` config, the user must
  uninstall the old APK first.
- Before wider distribution (Play Store, F-Droid), generate a real
  keystore and configure `signingConfigs.release` in `build.gradle`.

---

## Architecture notes (for stability)

The whole point of this app is that **the recording must not die by
accident**. The design that achieves this:

- `GpsRecorderService` is a **foreground service**
  (`foregroundServiceType="location"`). Android is reluctant to kill
  foreground services.
- The service is `START_STICKY`. If killed, Android restarts it and
  `StateRepository.recoverStateIfAny()` reloads state from
  SharedPreferences + the temp GPX file.
- `WakeLockManager` holds a `PARTIAL_WAKE_LOCK` with **no timeout** (L34)
  so the CPU stays awake for hikes longer than 6 hours.
- `onTaskRemoved` is overridden to NOT stop the service when the user
  swipes the app away.
- The notification is `setOngoing(true)` with a **Stop** action.
- The service does NOT depend on the JS thread. If JS dies, the service
  keeps recording and writes the GPX when stopped.
- `TempFileBuffer` flushes points every 5 s using the L26 append-only
  strategy — the temp file is always a complete, parseable GPX document.
- The JS side is purely informational; it only listens for events and
  renders the UI.

If you change the service code, re-read the above and make sure you don't
regress any of these properties.

---

## Code organisation principles

1. **Every file under 500 lines.** If a file grows beyond 500, extract a
   cohesive module. The `wc -l` check is part of the "is the refactor
   done?" gate.

2. **Single responsibility per module.** Each `.kt` / `.ts` file owns one
   concept (GPX I/O, settings, notification, auto-pause state machine,
   etc.). Cross-cutting state lives on the service / App.tsx and is
   accessed via `service.` / hook-destructure.

3. **Invariants are tagged** with `L*` (numbered fixes), `U*` (UI fixes),
   `O*` (organisation fixes), or `Task N` (code-review tasks). When
   refactoring, search for these tags and preserve the behaviour they
   document. See CHANGELOG.md for the full list.

4. **Privacy:** `SafeLog.d` / `SafeLog.v` are no-ops in release builds
  (they would leak lat/lon). `Log.i` / `Log.w` / `Log.e` are
  unconditional but must never include coordinates.

5. **Russian strings are inline.** The UI is Russian-language only.
   Strings live directly in the JSX / Kotlin code, not in a separate
   i18n file. When extracting components, strings travel with their
   component.

---

## Post-processing settings

Five independent user-facing toggles, all in the **НАСТРОЙКИ** section,
all locked while recording (except `showMovingTime` per Task 4). See
CHANGELOG.md v1.2 for the full algorithm description of each.
