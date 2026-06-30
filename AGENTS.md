# AGENTS.md

This file is a guide for any AI agent (or human) that touches this repository.
It explains **what** this project is, **how** to build the APK, and **why** the
APK binary is checked into the repo (which is normally an anti-pattern).

## What this project is

`GpsRecorder` is a small **React Native** Android app that records GPS tracks in
the background and writes them to the public `Downloads/trck/` folder as
`.gpx` files.

Key features:

- A single big **Start / Stop** button.
- A duration display (`mm:ss` or `h:mm:ss`) that ticks every second.
- A persistent **foreground-service notification** with a **Stop** action so the
  user can stop the recording without opening the app.
- GPS fixes are saved as a GPX 1.1 file under `Downloads/trck/`.
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

### App-name divergence (O6)

The user-facing app name is **`trck`** (set in `app.json`, `strings.xml`, and
`AndroidManifest.xml`'s `android:label`). The Gradle `rootProject.name` is
also `trck` (see `android/settings.gradle`). However, the **`applicationId`**
in `android/app/build.gradle` is `com.gpsrecorder` — this MUST NOT change,
because Android treats the `applicationId` as the package identity. Changing
it would make Android treat the app as a different package, losing all user
data (saved GPX files in the app's external cache, SharedPreferences) and
breaking the sideloaded-APK upgrade path (Android refuses to install an APK
whose `applicationId` differs from the installed one).

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
2.5. **Increment `versionCode`** in `android/app/build.gradle` (O25):
        - Change `versionCode N` to `versionCode N+1`.
        - Optionally update `versionName` (e.g. from `"1.1"` to `"1.2"`).
        - Commit this change together with the source change. Android's
          package installer refuses sideloaded-APK upgrades when the
          `versionCode` does not strictly increase.
3. **Set up your environment** (only needed once per shell session):
   ```bash
   export ANDROID_HOME=/path/to/android-sdk          # must contain platforms;android-35, build-tools;35.0.0, ndk;27.1.12297006
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
  - `platforms;android-35` (the app's `compileSdkVersion` — O2 pinned to 35)
  - `build-tools;35.0.0`
  - `ndk;27.1.12297006` (matches `ndkVersion` in `android/build.gradle`)
- **Node.js 22+** and **npm** — for installing JS dependencies before the JS
  bundle can be packaged into the APK.
- **Git** — to push the rebuilt APK back to the repo.

If the agent is using the deploy key on a machine without `openssh-client`
installed, they must use a Python `paramiko`-based SSH wrapper as
`GIT_SSH_COMMAND`. The original such wrapper lives at
`/home/z/my-project/scripts/ssh-wrapper.py` in the build agent's environment;
the pattern is reproducible if needed elsewhere.

**If `android/app/debug.keystore` is missing** (O4 — the keystore is no
longer tracked in git), regenerate it with:

```bash
keytool -genkey -v -keystore android/app/debug.keystore \
  -storepass android -alias androiddebugkey -keypass android \
  -keyalg RSA -keysize 2048 -validity 10000
```

(`react-native init` does this automatically on a fresh project, so a fresh
clone on a developer machine with RN installed will already have it. The
command above is for the case where the file is missing on a CI / build-agent
machine that does not have RN scaffolding.)

## Signing (O3)

The release APK is signed with the **debug keystore** — the same one used to
sign debug builds. See `android/app/build.gradle` → `signingConfigs.release`
(actually `signingConfigs.debug`, reused for the release variant).

- This is **intentional** for the user's personal sideloading use case. They
  install the APK directly from the GitHub repo's `apk/trck-release.apk` and
  do not distribute it through the Play Store.
- The debug keystore is **not** in version control (O4 — added to
  `.gitignore`). It is regenerated on each fresh clone with the `keytool`
  command above. The signing certificate therefore differs between machines,
  but Android's `applicationId` matches so sideloaded upgrades still work
  **as long as the APK is rebuilt on the same machine each time**. If you
  switch machines, the user will need to uninstall the old APK first.
- Before any wider distribution (Play Store, F-Droid, direct download from a
  public website), you MUST:
  1. Generate a real keystore with `keytool` (long validity, strong
     passwords, stored somewhere safe — NOT in the repo).
  2. Configure `signingConfigs.release` in `android/app/build.gradle` to
     point at it.
  3. Re-sign every release APK with that keystore.
  4. Keep the keystore safe — losing it means the app can never be updated
     on existing installs.

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

There are **multiple independent** user-facing toggles in the app, all located
in the **НАСТРОЙКИ** section. All are **locked while a recording is in
progress** (the row is greyed out and a "🔒 Заблокировано на время записи"
badge appears next to the section header) so that changing any setting
mid-recording cannot change the filter / smoothing / simplification behaviour
halfway through the file.

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

### 3. "Радиальный фильтр (на лету)" (on-the-fly radial distance filter)

Independent toggle (does NOT require `post_process_enabled` to be on). When
enabled, `onLocationChanged` drops every fix whose great-circle distance to
the **last KEPT point** is less than `radial_distance_threshold_m` meters.
The first fix of each segment (`prevLat == null`) is always kept because
there is no previous reference to compare against.

Implementation: in `onLocationChanged`, after the accuracy / velocity gate
passes (in the `post_process_enabled` branch) or before
`appendPointToCurrentSegment` (in the raw branch), check
`haversineMeters(prevLat, prevLon, pt.lat, pt.lon) < threshold`. If true,
drop the fix without advancing `prevLat` / `prevLon` — so the next fix is
compared against the same last-kept point. The dropped fix is still "fresh"
(good GPS, just denser than the user wants), so `lastFixTimeMs` is updated,
`saveLiveState(pt)` runs, and a `location` event is emitted before returning
— this keeps the UI's lastFix display current and prevents the gap watchdog
from falsely firing.

The user-tunable parameter `X` (default 5 m, range 0–1000 m, integer) is
exposed via a −/+ stepper row directly below the toggle. The value is
persisted in the `gps_recorder_settings` prefs file under
`radial_distance_threshold_m`. JS reads / writes it via
`GpsRecorder.getRadialDistanceThresholdM()` /
`GpsRecorder.setRadialDistanceThresholdM(int)`. The native setter clamps to
[0, 1000]; the JS stepper mirrors the same clamp.

The toggle itself is persisted under `radial_distance_filter_enabled` and
read / written via `GpsRecorder.getRadialDistanceFilterEnabled()` /
`GpsRecorder.setRadialDistanceFilterEnabled(bool)`.

Effect: suppresses stationary GPS jitter (the user standing still and the
GPS drifting around within a 3 m radius at ~0.3 m/s — below the 0.35 m/s
auto-pause threshold but well within the 20 km/h velocity ceiling). Also
collapses nearly-colinear slow-walk fixes into a sparser sequence, which
shrinks the GPX file by 30–70% depending on movement patterns.

### 4. "Децимация по времени (на лету)" (on-the-fly time sampling)

Independent toggle. When enabled, `onLocationChanged` keeps every N-th fix
and drops the rest. Useful for shrinking file size on long recordings where
1 Hz is overkill (e.g. an all-day hike at 5 km/h doesn't need 86 400 points
— every 5th second is plenty).

Implementation: a monotonic `timeSamplingCounter` is incremented for every
fix that reaches the time-sampling check (after the stale-fix / gap / auto-
pause checks). The fix is kept iff `n == 1`, `counter == 1` (always keep
the very first fix so the track has a starting point), or
`counter % n == 0`. Otherwise the fix is dropped with the same
`lastFixTimeMs + saveLiveState + emit + return` pattern as the radial
filter (so the UI stays fresh and the gap watchdog doesn't fire falsely).

The counter is reset to 0 in `startRecording(resume=false)` and is NOT
persisted across service restarts — a `START_STICKY` restart simply begins
a fresh sampling window, which is acceptable since the previously-kept
points are already in the buffer.

The user-tunable parameter `N` (default 5, range 1–60, integer) is exposed
via a −/+ stepper. At 1 Hz GPS, `N=5` yields one fix every ~5 s; `N=60`
yields one fix per minute. Persisted under `time_sampling_n` in the
`gps_recorder_settings` prefs file. JS reads / writes via
`GpsRecorder.getTimeSamplingN()` / `GpsRecorder.setTimeSamplingN(int)`. The
native setter clamps to [1, 60]; the JS stepper mirrors the same clamp.

The toggle is persisted under `time_sampling_enabled` and read / written
via `GpsRecorder.getTimeSamplingEnabled()` /
`GpsRecorder.setTimeSamplingEnabled(bool)`.

### 5. "Douglas-Peucker (постобработка)" (Douglas-Peucker simplification)

Independent toggle. When enabled, `finalizeGpxFile()` — AFTER writing the
raw / on-the-fly-filtered GPX file AND after Gaussian smoothing (if that is
also enabled) — reads the file back, applies the Douglas-Peucker algorithm
to each `<trkseg>` independently with tolerance
`douglas_peucker_epsilon_m` meters, and overwrites the file with the
simplified track.

The algorithm (`GpsRecorderService.douglasPeuckerSimplify`):

1. Keep the segment's first and last points unconditionally.
2. Find the intermediate point with the maximum perpendicular (cross-track)
   distance from the great circle through the first and last points.
3. If that max distance exceeds epsilon, mark that point as kept and
   recursively process the two halves (start→pivot and pivot→end).
4. Otherwise drop all intermediate points.
5. Implemented iteratively with an explicit `ArrayDeque<Pair<Int,Int>>`
   stack to avoid stack overflow on long tracks (a 3-hour walk at 1 Hz =
   ~10 800 points).

Perpendicular distance is the great-circle cross-track distance
(`crossTrackDistanceM`):

```
δ13 = d13 / R                  (angular distance from a to p)
θ13 = bearing(a → p)
θ12 = bearing(a → b)
d_xt = asin( sin(δ13) · sin(θ13 − θ12) ) · R
```

This is correct at any latitude (unlike a flat-Earth perpendicular distance
formula, which degrades near the poles). Degenerate segments where
`a == b` fall back to the straight-line haversine distance.

Timestamps, speed, accuracy, and elevation of the kept points are preserved
verbatim. The output has fewer (or equal) points than the input — only the
spatial density is reduced. Segments with fewer than 3 points are returned
unchanged (nothing to simplify). Empty `<trkseg>` blocks are preserved
as-is so the segment structure is mirrored in the output.

The user-tunable parameter `epsilon` (default 5.0 m, range 0.0–500.0 m,
Double) is exposed via a −/+ stepper (integer step). Persisted under
`douglas_peucker_epsilon_m` in the `gps_recorder_settings` prefs file as a
String (SharedPreferences has no `putDouble` — same pattern as
`total_distance_m`). JS reads / writes via
`GpsRecorder.getDouglasPeuckerEpsilonM()` /
`GpsRecorder.setDouglasPeuckerEpsilonM(double)`. The native setter clamps
to [0.0, 500.0]; the JS stepper clamps to [0, 500] (integer).

The toggle is persisted under `douglas_peucker_enabled` and read / written
via `GpsRecorder.getDouglasPeuckerEnabled()` /
`GpsRecorder.setDouglasPeuckerEnabled(bool)`.

Effect: collapses nearly-colinear sequences (long straight roads, slow
straight trails) into just their endpoints, while preserving real corners
and turnpoints. A typical 1 Hz walk track simplified with ε=5 m shrinks by
50–80% with negligible visual difference when plotted on a map.

### Chaining order at finalize time

When multiple post-processors are enabled, they chain in this order:

```
raw / on-the-fly-filtered buffer
   ↓
serializeSegmentsToGpx  →  write to Downloads/trck/*.gpx
   ↓ (if either Gaussian or DP is enabled: read back)
gaussianSmoothGpx       (if gaussian_smoothing_enabled)
   ↓
douglasPeuckerGpx       (if douglas_peucker_enabled)
   ↓
overwrite file
```

Gaussian runs first (to suppress single-fix glitches), then DP (to decimate
the smoothed track). Running them in the opposite order would let DP keep
glitchy points that Gaussian would have smoothed away. Either can be
enabled on its own.

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
