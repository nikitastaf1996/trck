# AGENTS.md

This file is a guide for any AI agent (or human) that touches this repository.
It explains **what** this project is, **how** to build the APK, and **why** the
APK binary is checked into the repo (which is normally an anti-pattern).

## What this project is

`GpsRecorder` is a small **React Native** Android app that records GPS tracks in
the background and writes them to the public `Downloads/GpsRecorder/` folder as
`.gpx` files.

Key features:

- A single big **Start / Stop** button.
- A duration display (`mm:ss` or `h:mm:ss`) that ticks every second.
- A persistent **foreground-service notification** with a **Stop** action so the
  user can stop the recording without opening the app.
- GPS fixes are saved as a GPX 1.1 file under `Downloads/GpsRecorder/`.
- Recording survives:
  - The app being backgrounded.
  - The app being swiped away from the recents list.
  - The screen turning off (a partial `WakeLock` keeps the CPU running).
  - The system killing the process for memory (the service is `START_STICKY`
    and re-loads buffered points from a temp file on restart).
- Points are flushed to a temp file every 5 seconds so a crash mid-recording
  still yields a usable (partial) GPX file.

## Project layout

```
.
├── App.tsx                          # Main React Native UI (Start/Stop, duration, stats)
├── index.js                         # RN entrypoint
├── app.json                         # RN app name
├── package.json                     # JS deps
├── src/
│   └── NativeGpsRecorder.ts         # TS bridge to the native module
└── android/
    ├── build.gradle                 # Top-level gradle config
    ├── settings.gradle
    ├── gradle.properties            # newArchEnabled, hermesEnabled, etc.
    ├── gradlew / gradlew.bat        # Gradle wrapper
    └── app/
        ├── build.gradle             # App-level gradle config
        └── src/main/
            ├── AndroidManifest.xml  # Permissions + service declaration
            ├── java/com/gpsrecorder/
            │   ├── MainActivity.kt          # RN activity + permission requests
            │   ├── MainApplication.kt        # Registers GpsRecorderPackage
            │   ├── GpsRecorderPackage.kt    # RN package that exposes the module
            │   ├── GpsRecorderModule.kt     # JS bridge (start/stop/events)
            │   └── GpsRecorderService.kt    # The foreground service (heart of the app)
            └── res/
                ├── drawable/ic_gps_notification.xml
                └── values/strings.xml
```

## Why the APK is committed to this repo

> **TL;DR:** The user's dev PC is broken. They cannot build the APK locally. The
> committed APK is the **only** way for them to install the app on their phone.

Normally you should never commit build artifacts (`.apk`, `.aab`, etc.) to a
git repository. They are large, binary, not diff-able, and they bloat the repo
history forever. **This repo deliberately breaks that rule** because:

1. The user's only development machine is down, and they cannot run
   `./gradlew assembleRelease` themselves.
2. The AI agent (Claude / etc.) has access to a Linux build environment with the
   Android SDK installed, so it *can* build the APK on the user's behalf.
3. The user needs a way to download a ready-to-install APK from GitHub (via the
   "Releases" page or directly from the repo file view).

So: **after every meaningful source-code change, the agent must rebuild the APK
and re-commit it.** See the workflow below.

## Where the APK lives

The release APK is committed at:

```
apk/trck-release.apk
```

This single path is overwritten on every rebuild so the repo doesn't grow
unbounded. (The first build also added a historical APK under `release/`; that
path is no longer used — always use `apk/`.)

## What to do after every code change

This is the **mandatory** post-change workflow for any agent (or human with a
working Android build environment) editing this repo:

1. **Make your source changes** in `App.tsx`, `src/`, or `android/app/src/main/`.
2. **Commit the source changes** with a clear message:
   ```bash
   git add -A
   git commit -m "describe the change"
   ```
3. **Set up your environment** (only needed once per shell session):
   ```bash
   export ANDROID_HOME=/path/to/android-sdk          # must contain platforms;android-36, build-tools;36.0.0, ndk;27.1.12297006
   export ANDROID_SDK_ROOT=$ANDROID_HOME
   export JAVA_HOME=/path/to/jdk-21                  # OpenJDK 21+
   export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
   ```
4. **Build the release APK**:
   ```bash
   cd android
   chmod +x gradlew
   ./gradlew --no-daemon assembleRelease
   ```
   The output APK will be at:
   ```
   android/app/build/outputs/apk/release/app-release.apk
   ```
5. **Copy the freshly built APK into the repo** (overwrite the old one):
   ```bash
   cd /path/to/repo/root
   mkdir -p apk
   cp android/app/build/outputs/apk/release/app-release.apk apk/trck-release.apk
   ```
6. **Commit and push the APK**:
   ```bash
   git add apk/trck-release.apk
   git commit -m "Rebuild APK: <one-line summary of the source change>"
   git push
   ```

The user will then be able to download the new APK from the GitHub web UI and
install it on their phone.

### Why this is the only option for this user

- The user has no working PC to run `./gradlew` themselves.
- They explicitly authorized committing the APK to the repo against normal
  conventions because that is their only practical distribution channel.
- Building the APK in the cloud (CI, etc.) would require setting up GitHub
  Actions with the Android SDK, which the user is not in a position to do right
  now.
- So: the agent that made the change is also responsible for rebuilding and
  re-committing the APK. **Do not leave the user without a working APK after a
  source change.**

## Required build environment

To rebuild the APK you need:

- **OpenJDK 21** (or newer) — `java -version` should report 21.x.
- **Android SDK** with these components installed (via `sdkmanager`):
  - `platform-tools`
  - `platforms;android-36` (the app's `compileSdkVersion`)
  - `build-tools;36.0.0`
  - `ndk;27.1.12297006` (matches `ndkVersion` in `android/build.gradle`)
- **Node.js 22+** and **npm** — for installing JS dependencies before the JS
  bundle can be packaged into the APK.
- **Git** — to push the rebuilt APK back to the repo.

If the agent is using the deploy key on a machine without `openssh-client`
installed, they must use a Python `paramiko`-based SSH wrapper as
`GIT_SSH_COMMAND`. The original such wrapper lives at
`/home/z/my-project/scripts/ssh-wrapper.py` in the build agent's environment;
the pattern is reproducible if needed elsewhere.

## Local dev (for reference)

If you ever get a working Android dev environment, normal React Native commands
work:

```bash
npm install
npm start         # metro bundler
npm run android   # build + install debug APK on a connected device
```

For a release build:

```bash
cd android && ./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

The release variant is signed with the debug keystore (see
`android/app/build.gradle` → `signingConfigs`). This is fine for the user's
personal use; if you ever want to publish to the Play Store you'll need to
generate a real keystore.

## Architecture notes (for stability)

The whole point of this app is that **the recording must not die by accident**.
The design that achieves this:

- `GpsRecorderService` is a **foreground service** (`startForeground` +
  `foregroundServiceType="location"`). Android treats foreground services as
  user-visible and is very reluctant to kill them.
- The service is `START_STICKY`. If the system does kill it, Android restarts
  it and we recover state from `SharedPreferences` and the temp GPX file.
- The service holds a `PARTIAL_WAKE_LOCK` so the CPU stays awake while the
  screen is off — otherwise GPS fixes stop arriving.
- `onTaskRemoved` is overridden to NOT stop the service when the user swipes
  the app away from recents. The recording keeps running; the user can stop it
  from the notification.
- The notification is `setOngoing(true)` with a **Stop** action — the user
  can stop recording without re-opening the app.
- The service does NOT depend on the JS thread being alive. If the JS app is
  killed, the service keeps recording and writes the GPX file when stopped.
- Points are flushed to a temp file (`externalCacheDir/gps_temp_*.gpx`) every 5
  seconds. On service restart we parse the temp file back into the in-memory
  buffer. On stop, the temp file is finalized into the public Downloads folder.
- The JS side is purely informational; it only listens for events and renders
  the UI. It can be killed at any time without affecting recording.

If you change the service code, please re-read the above and make sure you
don't regress any of these properties.

## Post-processing setting

There are **two independent** user-facing toggles in the app, both located in
the **НАСТРОЙКИ** section. Both are **locked while a recording is in
progress** (the row is greyed out and a "🔒 Заблокировано на время записи"
badge appears next to the section header) so that changing either setting
mid-recording cannot change the filter / smoothing behaviour halfway through
the file.

### 1. "Фильтрация трека на лету" (on-the-fly track filtering)

When enabled, noisy / wild points are dropped at write time inside
`onLocationChanged` so the GPX buffer only ever contains clean, validated
fixes. When disabled, every fix is recorded raw (the fallback / diagnostic
mode) and the distance accumulator alone applies the same gates.

The on-the-fly filter applies two gates to each candidate fix:

1. **Accuracy gate.** Drop any fix whose reported horizontal accuracy is
   worse than `ACCURACY_THRESHOLD_M = 25.0 m` (tightened from 50 m — 25 m
   is still permissive enough for cold-start fixes but rejects the worst
   multipath noise).
2. **Velocity gate.** Compute the instantaneous velocity from the previous
   accepted fix to the candidate:
   ```
   velocity = haversine(prev, curr) / (t_curr - t_prev)
   ```
   and drop the candidate if it implies the user moved faster than
   `MAX_VELOCITY_MPS = 5.5556 m/s` (= 20 km/h, a generous walking/running
   ceiling). This **replaces** the old static 1 km jump gate, which only
   caught glitches that were already absurdly large. A zero-dt fix
   (duplicate timestamp) is dropped because it would imply infinite
   velocity.

The setting is persisted in a **separate** SharedPreferences file
(`gps_recorder_settings`) under the key `post_process_enabled`, so it
survives the per-recording state clear in `stopRecording()`. JS reads /
writes it via `GpsRecorder.getPostProcessEnabled()` /
`GpsRecorder.setPostProcessEnabled(bool)`.

### 2. "Сглаживание Гауссом (постобработка)" (Gaussian / kernel smoothing)

When enabled, after the (raw or on-the-fly-filtered) GPX file is written to
`Downloads/trck/`, the service reads it back, applies a Gaussian kernel
smoother, and overwrites the file. When disabled, only the raw /
on-the-fly-filtered track is written.

The algorithm (in `GpsRecorderService.gaussianSmoothGpx()`):

1. Parse all `<trkpt>` (lat/lon/ele/time/speed/accuracy).
2. Pre-compute the Gaussian kernel weights for offsets
   `-GAUSSIAN_HALF_WINDOW .. +GAUSSIAN_HALF_WINDOW`
   (`GAUSSIAN_HALF_WINDOW = 5`, `GAUSSIAN_SIGMA = 1.5`):
   ```
   w(k) = exp( -0.5 * (k / sigma)^2 )
   ```
3. For each point, replace its lat/lon (and altitude, if present) with the
   weighted average of itself and its neighbours within the ±5-point
   window. Timestamps, speed, and accuracy are preserved verbatim. The
   output has the SAME number of points as the input — only the
   spatial coordinates change.
4. Re-emit the GPX with the smoothed coordinates.

Effect: single-fix GPS glitches (typically a 20–80 m spike away from the
true track) get pulled back toward their neighbours because the
Gaussian-weighted average is dominated by the surrounding clean fixes.
Real corners are preserved reasonably well because the kernel is narrow
(±5 points at 1 Hz = ±5 s window).

The setting is persisted in the same `gps_recorder_settings` prefs file
under the key `gaussian_smoothing_enabled`, so it survives the
per-recording state clear. JS reads / writes it via
`GpsRecorder.getGaussianSmoothingEnabled()` /
`GpsRecorder.setGaussianSmoothingEnabled(bool)`.

A standalone Python reference implementation with tests lives at
`/home/z/my-project/scripts/test_post_process.py` in the build agent's
environment (not committed to the repo).

## Distance-leakage fix

Previous versions had a bug where pressing START sometimes showed a non-zero
distance (e.g. 9 m or 69 m) immediately. Two root causes, both fixed:

1. **Stale `getLastKnownLocation()` seed.** `startLocationUpdates()` used to
   call `lm.getLastKnownLocation(...)` and feed the result to
   `onLocationChanged()`. That cached fix was frequently stale (e.g. a fix
   from 30 s ago when the user was a few meters away). It became `prevLat`/
   `prevLon` with no distance added (prev was null), but the *next* fresh fix
   then had its Haversine distance to that stale point added — producing the
   spurious initial distance. **Fix:** removed the `getLastKnownLocation()`
   seed entirely. The always-on GNSS monitor already seeds the UI; the service
   just waits for the first real fix from `requestLocationUpdates()`.
2. **Defensive fix-age guard.** Even without the explicit seed, the OS can
   occasionally deliver a slightly stale fix immediately after
   `requestLocationUpdates()`. `onLocationChanged()` now drops any fix older
   than `MAX_FIX_AGE_MS` (3 s) before it can touch the buffer or the distance
   accumulator.
3. **Leftover `isRecording=true` state.** If a previous recording was killed
   (e.g. user force-stopped the app) before `stopRecording()` could clear
   `SharedPreferences`, the next app launch would recover `isRecording=true`
   and the old `totalDistanceM`. Pressing START would then hit the "already
   recording, ignoring start" early-return and never reset the distance.
   **Fix:** `startRecording(resume=false)` now ALWAYS resets state and starts
   fresh, even if `isRecording` happens to be true. Only `resume=true`
   (system-initiated restart via `START_STICKY`) skips the reset.
