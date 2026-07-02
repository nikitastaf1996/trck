# AGENTS.md

Guide for any AI agent (or human) touching this repository. Explains
**what** the project is, **how** to build the APK, **why** the APK binary
is checked into the repo, and the **architecture** of the refactored
codebase.

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
├── apk/
│   └── trck-release.apk            # Built APK (committed — see below)
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

## Why the APK is committed to this repo

> **TL;DR:** The user's dev PC is broken. The committed APK is the only
> way for them to install the app.

Normally you should never commit `.apk` files to git. This repo
deliberately breaks that rule because:

1. The user's only development machine is down.
2. The AI agent has access to a Linux build environment with the Android
   SDK and can build the APK on the user's behalf.
3. The user downloads the ready-to-install APK directly from GitHub.

**After every meaningful source-code change, rebuild the APK and
re-commit it.** See the workflow below.

---

## What to do after every code change

1. **Make your source changes** in `App.tsx`, `src/`, or `android/app/src/main/`.
2. **Run the JS checks**:
   ```bash
   npm install
   npx tsc --noEmit          # TypeScript typecheck
   npx jest                   # 39 tests
   npx eslint .               # lint
   ```
3. **Bump `versionCode`** in `android/app/build.gradle` (O25). Android
   refuses sideloaded-APK upgrades when `versionCode` does not strictly
   increase.
4. **Set up your environment** (only once per shell session):
   ```bash
   export ANDROID_HOME=/path/to/android-sdk
   export ANDROID_SDK_ROOT=$ANDROID_HOME
   export JAVA_HOME=/path/to/jdk-21
   export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
   ```
   The SDK must contain: `platform-tools`, `platforms;android-35`,
   `build-tools;35.0.0`, `ndk;27.1.12297006`, `cmake;3.22.1`.
5. **Build the release APK**:
   ```bash
   cd android
   chmod +x gradlew
   ./gradlew --no-daemon assembleRelease
   ```
   Output: `android/app/build/outputs/apk/release/app-release.apk`
6. **Copy the APK into the repo**:
   ```bash
   cp android/app/build/outputs/apk/release/app-release.apk apk/trck-release.apk
   ```
7. **Commit and push**:
   ```bash
   git add -A
   git commit -m "Rebuild APK: <one-line summary>"
   git push
   ```

### Build environment tips

- **Memory:** the native CMake build for React Native needs ~2 GB free
  RAM. If the Gradle daemon disappears (killed by OOM), kill lingering
  daemons (`pkill -f gradle; pkill -f kotlin`), set
  `CMAKE_BUILD_PARALLEL_LEVEL=1`, and retry with
  `-Dorg.gradle.jvmargs="-Xmx1536m"`.
- **ABI filter:** on memory-constrained machines, temporarily add
  `ndk { abiFilters "arm64-v8a" }` to `defaultConfig` in
  `android/app/build.gradle` to build for arm64 only (most modern
  phones). Remove it before committing if you want a multi-ABI APK.
- **Debug keystore:** if `android/app/debug.keystore` is missing,
  regenerate it (see O4 below).

---

## Required build environment

- **OpenJDK 21** — `java -version` reports 21.x.
- **Android SDK** with:
  - `platform-tools`
  - `platforms;android-35`
  - `build-tools;35.0.0`
  - `ndk;27.1.12297006`
  - `cmake;3.22.1` (auto-installed by Gradle on first build)
- **Node.js 22+** and **npm**.
- **Git** (with SSH deploy key access to the repo).

### Installing the SDK from scratch

```bash
mkdir -p $ANDROID_HOME/cmdline-tools
cd $ANDROID_HOME/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-*.zip && mv cmdline-tools latest
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
           "ndk;27.1.12297006"
```

---

## Signing (O3)

The release APK is signed with the **debug keystore** — the same one used
for debug builds. This is intentional for the user's personal sideloading
use case.

- The debug keystore is **not** in version control (O4 — in `.gitignore`).
  Regenerate on a fresh clone:
  ```bash
  keytool -genkey -v -keystore android/app/debug.keystore \
    -storepass android -alias androiddebugkey -keypass android \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US"
  ```
- The signing certificate differs between machines. If you switch
  machines, the user must uninstall the old APK first.
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
