# Changelog

All notable changes to **trck** are documented here. Entries are grouped
by release, newest first. Bug-fix rationales that previously littered the
source code have been moved here so the code stays readable while the
"why" is preserved.

---

## v1.4.0 (2026-07-23) — JS state architecture refactor

### Summary

The previous JS-side state design smeared recording state across `App.tsx`
+ four hooks (`useSettings`, `usePermissions`, `useGnssMonitor`,
`useRecordingSession`) + two factory files (`useRecordingEventHandlers`,
`useRecordingControls`) + a forest of mirror refs (`recordingStateRef`,
`movingMsRef`, `elapsedMsRef`, `isAutoPausedRef`, `autoPauseEnabledRef`,
`gapDetectionEnabledRef`, `showMovingTimeRef`, `recentSpeedsRef`,
`lastDurationSeqRef`, `cancelPermissionWaitRef`, `hasAskedBatteryOptRef`,
`stopTimeoutRef`, `stopHardTimeoutRef`) and a `forceRerender` hammer
(because `recentSpeedsRef.current.push()` mutates in place and React
can't see it).

That has been collapsed into **two Zustand stores**:

- `src/store/recordingStore.ts` — single source of truth for the
  recording state machine, live telemetry, GNSS status, permissions,
  saved-card snapshot, error message, and the pace-smoothing window.
  Event handlers read `useRecordingStore.getState()` at call time, which
  is always fresh — no mirror refs needed.
- `src/store/settingsStore.ts` — single source of truth for the 11
  user-facing settings, with one `SETTINGS_SPEC` table describing each
  setting's type / default / clamp range / lock-while-recording flag /
  native getter+setter. One generic `toggle(key)` action and one
  generic `step(key, delta)` action replace the previous 11 near-
  identical handlers.

`src/hooks/` is gone (6 files, ~2,000 lines deleted). `App.tsx` dropped
from 496 to ~330 lines and is now mostly wiring: selectors → components.
The "every file under 500 lines" rule was dropped — it had produced
files that were split-but-not-abstracted, sharing mutable state through
back-references (see AGENTS.md → Code organisation principles).

### Files added

| File | Responsibility |
|---|---|
| `src/store/recordingStore.ts` | Zustand store: recording state machine + event reducers + permission/start/stop actions. |
| `src/store/settingsStore.ts` | Zustand store + `SETTINGS_SPEC` table + generic `toggle` / `step` actions. |
| `__tests__/store/recordingStore.test.ts` | ~45 tests covering event reducers, syncFromNative, handleStart/Stop, permissions. |
| `__tests__/store/settingsStore.test.ts` | ~25 tests covering SETTINGS_SPEC, toggle/step, lock check, re-entrancy, loadAll. |

### Files deleted

| File | Was |
|---|---|
| `src/hooks/useRecordingSession.ts` | 560 lines, 19-param hook, recording state machine. |
| `src/hooks/useRecordingEventHandlers.ts` | 330 lines, 5 factory functions with 10-20 params each. |
| `src/hooks/useRecordingControls.ts` | 249 lines, start/stop factories. |
| `src/hooks/useSettings.ts` | 482 lines, 11 near-identical handlers. |
| `src/hooks/useGnssMonitor.ts` | 124 lines, GNSS state hook. |
| `src/hooks/usePermissions.ts` | 162 lines, permission/battery-opt hook. |
| `__tests__/hooks/useRecordingSession.test.ts` (and 4 others) | ~118 hook tests, replaced by store tests. |
| `__tests__/helpers/renderHook.tsx` | renderHook helper, no longer needed. |

### Behavioural invariants preserved

All behavioural invariants from the previous design are preserved by
the store reducers. The `L*` / `U*` / `Task N` tags are now referenced
in inline comments where they're still load-bearing (mostly in the
event reducers and the stop fallbacks), but the previous "every fix
gets a tag, every tag is permanent" discipline has been dropped — see
AGENTS.md → Code organisation principles #3.

### Why zustand

- ~1 KB dependency, zero boilerplate, no provider component needed.
- `getState()` is stable, so event handlers wired up once at mount
  can read fresh state without subscribing — eliminates the mirror-ref
  pattern entirely.
- Selectors with `useStore(s => s.foo)` re-render only when the
  selected slice changes — no `forceRerender` needed for in-place
  array mutations (the store replaces arrays on update).
- The store IS the single source of truth — no parallel "ref mirror"
  system to keep in sync.

### Test count change

- Before: ~315 TS tests + ~80 Kotlin tests = ~395 total.
- After: 269 TS tests + ~80 Kotlin tests = ~349 total.
- The drop is from deleting ~118 hook tests (which tested implementation
  structure rather than user-facing behaviour). The new store tests
  cover the same behavioural invariants more concisely.

### Build

- `versionCode` 5 → 6 and `versionName` 1.3.1 → 1.4.0 (bumped here, on
  the final state, as this entry's original note intended — so the APK
  auto-publish fires once for v1.4.0).
- One new runtime dependency: `zustand@^5` (~1 KB).

### Code review fixes (2026-10-17)

A full code-review pass. **No GUI or outward behaviour change** — the
fixes are internal correctness, safety, and test/lint hygiene.

**Kotlin (Android)**
- `GpxIO`: the `SimpleDateFormat` instances are now `ThreadLocal` (the
  shared, mutable formatters were a data race under concurrent GPX
  reads/writes) and the ISO formatter is pinned to UTC. Added
  `formatFileName(ms)` as the single filename-stamp helper.
- `GpxFileSaver`: uses `GpxIO.formatFileName()`; clears the stale
  `KEY_LAST_SAVED_URI` before writing a cache fallback so a failed
  MediaStore save can't leave a dangling URI.
- `GpsRecorderService`: the "saved" success check now excludes the
  `"Save failed:"` sentinel, so a failed save is no longer reported to
  the UI as success.
- `GpsRecorderModule.getState()`: parses the last-fix values with
  `toDoubleOrNull()` instead of `toDouble()` — one corrupt pref can no
  longer reject the whole `getState()` call (which would have silently
  killed the JS 2 s fallback polling).
- `TempFileBuffer`: removed the dead `setAppendState` callback (the
  service passed a no-op; the buffer already manages that state).
- `SettingsBridge`: the three auto-pause setters are **intentionally
  unclamped** — this was confirmed as a deliberate design (free-form
  text input; clamping made the field snap to a boundary and fight the
  user's keystrokes) and documented so it isn't "fixed" later. See the
  "INTENTIONALLY UNCLAMPED" comment and history commits `3cf19e4` /
  `4a98b11`.

**JS (React Native)**
- `settingsStore.set()`: fixed the no-op revert-on-error (it read the
  already-optimistic value). Kept and documented the deliberate no-clamp
  behaviour for the auto-pause values (free-form text input).
- `recordingStore.handleStart()`: made start race-safe (a superseded
  start no longer clobbers a newer session) and wrapped `start()` in
  try/catch so a failure returns to `idle` with an error instead of
  getting stuck in `recording`.
- `recordingStore.initialPermissionCheck()`: made reject-proof.
- `App.tsx`: mount now runs `loadAll()` first and each init step is
  independently try/caught, so one failure can't skip the rest.
- `AutoPauseTextInput`: local text now re-syncs when the store value
  changes from outside (loadAll / revert-on-error) without fighting free
  typing or a `1.2.3` NaN typo.
- `NativeGpsRecorder.ts`: typed the `removeListeners` fallback to match
  its declared signature.

**Tests / lint / tooling**
- Fixed the pre-existing ESLint failure (49 errors / 8 warnings): added
  a jest-env override for `jest.setup.js` / `jest.config.js`, removed
  stale `eslint-disable` comments, and cleaned up unused test imports.
- `recordingStore.test.ts`: the `handleStart` block now clears the real
  stop-fallback timers in `afterEach` (fixes the Jest "did not exit"
  open-handles warning). `settingsStore.test.ts` now locks in the
  deliberate no-clamp `set()` behaviour.

After this pass: `npx tsc --noEmit` clean · `npx jest --ci` 286/286 with
no open handles · `npx eslint .` clean (0 errors, 0 warnings).

---

## v1.3.1 (2026-07-02) — Refactor: every file under 500 lines

### Summary

The two giant files that prompted the refactor are now both **under 500
lines** — and every other source file in the project is too.

| File | Before | After | Reduction |
|---|---|---|---|
| `GpsRecorderService.kt` | 3 445 | **497** | −86 % |
| `App.tsx` | 2 135 | **496** | −77 % |
| `GpsRecorderModule.kt` | 1 223 | **373** | −69 % |

No behaviour changed. All `L*` / `U*` / `O*` invariants, every Russian
string, every filter threshold, and every race-condition fix is preserved
verbatim. The 39 existing tests pass; ESLint and `tsc` are clean.

### New Kotlin modules (`android/app/src/main/java/com/gpsrecorder/`)

| File | Lines | Responsibility |
|---|---|---|
| `GpsRecorderService.kt` | 497 | Orchestration shell — lifecycle, ticks, wiring. |
| `LocationChangedHandler.kt` | 457 | The 8-stage `onLocationChanged` filter pipeline. |
| `AutoPauseGapController.kt` | 475 | Auto-pause + gap-detection state machine. |
| `StateRepository.kt` | 417 | SharedPreferences persistence + START_STICKY recovery. |
| `GpsRecorderModule.kt` | 373 | Thin `@ReactMethod` forwarders. |
| `SettingsBridge.kt` | 362 | 22 settings getter/setter `@ReactMethod` bodies. |
| `GnssMonitor.kt` | 333 | Always-on GNSS monitor + L27 dedup cache. |
| `GpxFileSaver.kt` | 317 | Finalize / save pipeline (MediaStore + legacy). |
| `GpxIO.kt` | 316 | Pure GPX 1.1 parse / format / serialize. |
| `PermissionHelper.kt` | 303 | L9 / L23 pending-promise permission flow. |
| `GpxPostProcessors.kt` | 301 | Gaussian smoother + Douglas-Peucker. |
| `TempFileBuffer.kt` | 299 | L26 append-only temp-file strategy. |
| `GpsEventEmitter.kt` | 231 | Singleton event emitter (6 events). |
| `LocationSource.kt` | 215 | GPS provider + GNSS status tracking. |
| `GpsRecorderNotification.kt` | 203 | Foreground notification + L18 catch. |
| `AutoPauseHandler.kt` | 188 | Auto-pause decision logic extracted from `onLocationChanged`. |
| `GpsRecorderSettings.kt` | 156 | 8 toggle keys + 3 numeric params (single source of truth). |
| `SegmentedBuffer.kt` | 115 | `trackSegments` / `currentSegment` / `pointBufferLock`. |
| `DistanceAccumulator.kt` | 73 | Haversine distance accumulator. |
| `WakeLockManager.kt` | 49 | PARTIAL_WAKE_LOCK acquire / release (L34 no-timeout). |
| `GpsPoint.kt` | 21 | Top-level data class (was inner class of the service). |
| `TrackMath.kt` | 80 | Haversine + cross-track distance (pre-existing). |

### New TypeScript modules

**Hooks** (`src/hooks/`):

| File | Lines | Responsibility |
|---|---|---|
| `useRecordingSession.ts` | 497 | 5 event subscriptions + `handleStart` / `handleStop` + 2 s poll. |
| `useSettings.ts` | 482 | 11 settings state + 10 toggle / stepper handlers. |
| `useRecordingEventHandlers.ts` | 317 | Factory functions for the 5 native event handlers. |
| `useRecordingControls.ts` | 175 | `handleStart` / `handleStop` extracted. |
| `usePermissions.ts` | 162 | Permission + battery-opt state + handlers. |
| `useGnssMonitor.ts` | 124 | GNSS status state + event handler. |

**Components** (`src/components/`):

| File | Lines | Responsibility |
|---|---|---|
| `StatsDisplay.tsx` | 213 | TIME / DISTANCE / TEMPO block + status row. |
| `Banners.tsx` | 174 | Signal-lost / battery-opt / over-filter / pause badge. |
| `SavedCard.tsx` | 159 | "GPX СОХРАНЁН" card (replaced inline IIFE). |
| `ToggleRow.tsx` | 148 | Reusable toggle row (replaced 8 inlined copies). |
| `StepperRow.tsx` | 135 | − / + numeric stepper (pre-existing). |
| `Overlays.tsx` | 127 | Permission-wait + stop overlays. |
| `ErrorCard.tsx` | 106 | Error display card. |
| `ErrorBoundary.tsx` | 98 | React error boundary (pre-existing). |
| `StartStopButton.tsx` | 85 | Big circular START / STOP button. |
| `FilterSettingGroup.tsx` | 84 | ToggleRow + StepperRow card (replaced 3 copies). |
| `BigStat.tsx` | 83 | Large stat display (pre-existing). |
| `GnssPill.tsx` | 78 | GNSS fix-status pill (pre-existing). |

**Styles** (`src/styles/`):

| File | Lines | Responsibility |
|---|---|---|
| `index.ts` | 150 | `COLOR` palette + `formatDuration` / `formatDistance` / pace helpers. |
| `appStyles.ts` | 87 | Remaining `StyleSheet` entries used by `App.tsx`. |

### Invariants preserved (all verified)

- **L1** — `startLocationUpdates()` early-return contract.
- **L4** — every dropped fix still emits `location` + updates `lastFixTimeMs`.
- **L8** — `duration` event's `movingMs` preferred over `location`'s.
- **L9 / L23** — pending-promise pattern for permissions / battery-opt.
- **L10 / U17** — non-fatal errors do NOT reset to idle.
- **L14** — `GpsEventEmitter.unbind()` called first in `onCatalystInstanceDestroy`.
- **L18** — `ForegroundServiceStartNotAllowedException` catch + wakelock release.
- **L24** — out-of-order `duration` events dropped via `durationSeq`.
- **L25** — `saveLiveState` 5 s throttle (force bypasses).
- **L26** — append-only temp-file strategy (always-parseable GPX).
- **L27** — GNSS monitor 9-field dedup cache.
- **L32** — shared `SimpleDateFormat` (single-threaded).
- **L34** — wakelock acquired with NO timeout.
- **Task 1** — auto-pause resume grace window (`GAP_THRESHOLD_MS`).
- **Task 2** — `MOVING_CONFIRMATION_THRESHOLD = 3` hysteresis.
- **U3 / Task 4** — saved-card pace uses save-time snapshot of toggle state.
- **U4** — GNSS speed pushed to smoothing window only when not recording.
- **U10** — `location` handler skips `currentSpeed` when auto-paused.
- **U15** — settings toggle re-entrancy guard.
- **U16** — `handleStop` 1 s fallback timer; `saved` event cancels it.
- **U18** — `recordingStateRef` updated synchronously (not via `useEffect`).

### Build

- `versionCode` bumped 3 → 5, `versionName` 1.2 → 1.3.1.
- APK rebuilt and committed at `apk/trck-release.apk` (24.3 MB, arm64-v8a +
  armeabi-v7a + x86_64, signed with debug keystore per AGENTS.md O3).

---

## v1.2 (2026-06-22) — Five post-processing toggles + race-condition fixes

### Features

1. **On-the-fly track filtering** (`post_process_enabled`) — accuracy gate
   (≤ 25 m) + velocity gate (≤ 20 km/h) applied at `onLocationChanged` time.
2. **Gaussian smoothing** (`gaussian_smoothing_enabled`) — ±5-point kernel,
   σ = 1.5, applied at finalize time. L2 fix: elevation weighted-averaged
   correctly.
3. **Radial distance filter** (`radial_distance_filter_enabled` +
   `radial_distance_threshold_m`, default 5 m) — drops fixes closer than X
   m to the last kept point.
4. **Time sampling** (`time_sampling_enabled` + `time_sampling_n`, default
   5) — keeps every N-th fix.
5. **Douglas-Peucker** (`douglas_peucker_enabled` +
   `douglas_peucker_epsilon_m`, default 5 m) — iterative simplification
   with cross-track perpendicular distance.

### Bug fixes

- **Task 1** — auto-pause resume grace window prevents false `signalLost`
  declaration in the `GAP_THRESHOLD_MS` window after resume.
- **Task 2** — `MOVING_CONFIRMATION_THRESHOLD = 3` consecutive "clearly
  moving" fixes required to resume from auto-pause (prevents banner
  flicker).
- **L25** — `saveLiveState` throttled to 5 s (was 60 disk writes / min).
- **L26** — append-only temp-file strategy (was O(n²) full rewrite).
- **L27** — GNSS monitor dedup cache (was ~20 redundant events / min).
- **L21** — reload aborts if > 10 % of points have bad timestamps.
- **L13** — MediaStore URI persisted so `recomputeDistanceFromSavedGpx`
  can open the file via ContentResolver.
- **L1** — `startLocationUpdates()` returns `Boolean`; false means
  `stopRecording()` already called.

---

## v1.1 (2026-05-15) — Initial release

- Foreground service + START_STICKY + PARTIAL_WAKE_LOCK for stable
  background GPS recording.
- GPX 1.1 files saved to `Downloads/trck/`.
- Auto-pause (speed < 0.35 m/s + displacement < 3.5 m / 10 s).
- Gap detection (no fix > 15 s → new `<trkseg>`).
- Moving-time accumulator for honest average pace.
- Russian-language UI.
