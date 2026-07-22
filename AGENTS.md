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
├── App.tsx                          # RN UI composition root
├── index.js                         # RN entrypoint
├── app.json                         # RN app name
├── package.json                     # JS deps
├── .github/
│   └── workflows/
│       └── build-apk.yml            # GitHub Actions: build release APK on push
├── src/
│   ├── NativeGpsRecorder.ts         # TS bridge to the native module
│   ├── store/                       # Zustand stores (single source of truth)
│   │   ├── recordingStore.ts        # recording state machine + event reducers
│   │   └── settingsStore.ts         # 11 settings + generic useSetting hook
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

Files should be **tidy and cohesive** — one concept per file, no hard line
limit. If a file grows to the point that you can no longer hold its purpose
in your head, split it; otherwise leave it. (The previous "every file must
be under 500 lines" rule produced files that were split-but-not-abstracted
— the splits increased coupling rather than reducing it.)

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
> in GitHub Actions. The APK is then **auto-published** to a rolling
> [`latest` prerelease](https://github.com/nikitastaf1996/symmetrical-goggles/releases/tag/latest)
> so the stable URL `…/releases/download/latest/trck-latest.apk` always
> serves the freshest build. Workflow artifacts (`trck-apk`, `build-log`)
> are also uploaded for build debugging and older APKs.
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
10. **Stages the APK** as `trck-latest.apk` (stable filename so the
    release asset URL never changes between pushes).
11. **Publishes / updates** the rolling `latest` prerelease via
    `softprops/action-gh-release@v2`, attaching `trck-latest.apk` and
    refreshing the release body with the new commit SHA + push timestamp
    + run URL.

Steps 10–11 only run on `push` events to `main` (not on
`workflow_dispatch` manual runs). They require `permissions: contents: write`
at the job level — without it, the release step fails with HTTP 403
("Resource not accessible by integration") because the default
`GITHUB_TOKEN` is read-only.

### To download an APK

**Primary — stable URL (always freshest):**

```
https://github.com/nikitastaf1996/symmetrical-goggles/releases/download/latest/trck-latest.apk
```

This URL is overwritten on every push to `main`, so bookmarking it or
sharing it always serves the latest build.

**Browse all releases:**

1. Open https://github.com/nikitastaf1996/symmetrical-goggles/releases
2. Open the **Latest Build** prerelease for the freshest APK, or any
   older versioned release for a specific version.
3. Download the `trck-latest.apk` (or `trck-vX.Y.Z.apk`) asset attached
   to the release.

**Fallback — workflow artifacts (for build logs or APKs older than the
`latest` release):**

1. Open https://github.com/nikitastaf1996/symmetrical-goggles/actions
2. Click any past **Build APK** run (green check = success).
3. Scroll to the bottom — **Artifacts** section.
4. Click `trck-apk` to download a `.zip` containing the APK, or
   `build-log` for the full Gradle log (7-day retention).

### Why we moved away from committing the APK

Previously the APK binary was checked into the repo at
`apk/trck-release.apk`. This was a workaround for the developer's broken
PC — they couldn't build the APK themselves, so the agent built it and
committed the binary. The downside: every code change bloated the git
history with multi-MB binary diffs, and the committed APK was often
stale relative to the source.

GitHub Actions gives us a cleaner separation: source lives in the repo,
APKs are built on demand and distributed via GitHub Releases (rolling
`latest` prerelease) plus workflow artifacts for build debugging. No git
bloat, no staleness — every push produces a fresh APK matching the
latest commit, published to a stable URL that always points at the
freshest build.

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
   runner, faster with Gradle cache hits). The APK is auto-published to
   the rolling `latest` prerelease when the build succeeds.
6. **Download the APK** — either from the stable URL
   `https://github.com/nikitastaf1996/symmetrical-goggles/releases/download/latest/trck-latest.apk`
   or from the [Releases page](https://github.com/nikitastaf1996/symmetrical-goggles/releases/tag/latest).
   Workflow artifacts (older APKs, build logs) remain on the
   [Actions tab](https://github.com/nikitastaf1996/symmetrical-goggles/actions).
7. **Sideload and test** on your phone.

No more manual `./gradlew assembleRelease` + `cp` + `git add apk/` —
the workflow handles all of that, including the release publishing.

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

1. **Tidy and cohesive files, no hard line limit.** A file should own
   one concept (GPX I/O, settings, notification, the auto-pause state
   machine, the recording store, etc.). If you can no longer hold its
   purpose in your head, split it. Don't split just to hit a line count
   — that produces files which share mutable state through back-references
   and increase coupling rather than reducing it.

2. **State has a single owner.** JS-side state lives in a Zustand store
   (`src/store/`). Native-side state lives in the service or (better) in
   a dedicated state-machine class with private fields. Mirror refs,
   `forceRerender`, and the like are a smell — they appear when state is
   smeared across closures that can't see each other.

3. **Bug fixes are just bug fixes.** The old `L*` / `U*` / `O*` / `Task N`
   tag system was useful when there were five of them; at 268 occurrences
   it became a parallel language readers had to learn before they could
   read the code. New fixes get a normal commit message explaining the
   "why"; only the genuinely-surprising invariants get an inline comment.

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
