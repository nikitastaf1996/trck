# Changelog

All notable changes to **trck** are documented here. Entries are grouped
by release, newest first. Bug-fix rationales that previously littered the
source code have been moved here so the code stays readable while the
"why" is preserved.

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
