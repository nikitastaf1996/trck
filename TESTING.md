# Testing

This document describes the `trck` test suite — what's tested, where
the tests live, and how to run them locally and in CI.

The test suite covers both halves of the codebase:

| Layer        | Framework                 | Test runner           | Tests |
|--------------|---------------------------|-----------------------|-------|
| TypeScript   | Jest + react-test-renderer | `npx jest`            | ~315  |
| Kotlin       | JUnit 4 + Robolectric      | `./gradlew testDebugUnitTest` | ~80 |

Combined, the suite grew from **42 tests** (the original `format.test.ts`
+ `GapPauseRaceTest.kt`) to **≈ 395 tests** covering pure helpers, React
hooks, presentational components, GPX parsing/formatting, the auto-pause
state machine, the on-the-fly filter pipeline, and the post-processors
(Gaussian smoothing + Douglas-Peucker).

---

## Layout

```
.
├── __tests__/
│   ├── format.test.ts                 ← original 39 tests (formatters)
│   ├── NativeGpsRecorder.test.ts      ← TS wrapper around the native module
│   ├── styles.test.ts                ← COLOR palette + RecordingState type
│   ├── appStyles.test.ts             ← App.tsx's StyleSheet entries
│   ├── hooks/
│   │   ├── usePermissions.test.ts     ← permission + battery-opt flows
│   │   ├── useSettings.test.ts        ← 11 settings + U15 re-entrancy guard
│   │   ├── useGnssMonitor.test.ts     ← GNSS state + start/stop monitor
│   │   ├── useRecordingEventHandlers.test.ts  ← 5 native event handlers
│   │   └── useRecordingControls.test.ts       ← handleStart / handleStop
│   ├── components/
│   │   ├── StartStopButton.test.tsx
│   │   ├── ToggleRow.test.tsx
│   │   ├── StepperRow.test.tsx
│   │   ├── FilterSettingGroup.test.tsx
│   │   ├── BigStat.test.tsx
│   │   ├── Divider.test.tsx
│   │   ├── GnssPill.test.tsx
│   │   ├── SavedCard.test.tsx        ← also tests selectPaceTimeMs helper
│   │   ├── ErrorCard.test.tsx
│   │   ├── Banners.test.tsx          ← SignalLost / BatteryOpt / OverFilter / PauseBadge
│   │   ├── Overlays.test.tsx         ← PermissionWaitOverlay / StopOverlay
│   │   ├── StatsDisplay.test.tsx     ← also tests getStatusText + selectPaceTimeMs
│   │   └── ErrorBoundary.test.tsx    ← top-level React error boundary
│   └── helpers/
│       ├── index.ts                  ← shared mock utilities
│       ├── render.tsx                ← TestRenderer + Pressable helpers
│       └── renderHook.tsx            ← renderHook() helper (no extra deps)
└── android/app/src/test/java/com/gpsrecorder/
    ├── GapPauseRaceTest.kt                  ← original 3 tests + 8 new
    ├── TrackMathTest.kt                     ← haversine / bearing / cross-track
    ├── GpsPointTest.kt                      ← data class equality / copy
    ├── SegmentedBufferTest.kt               ← multi-segment buffer
    ├── GpxIOTest.kt                         ← GPX parse + format (Robolectric)
    ├── GpxPostProcessorsTest.kt             ← Gaussian + Douglas-Peucker (Robolectric)
    ├── AutoPauseGapControllerConstantsTest.kt  ← auto-pause thresholds
    ├── LocationChangedHandlerConstantsTest.kt  ← filter constants
    └── DistanceAccumulatorLogicTest.kt      ← velocity/accuracy gate logic
```

---

## Running the tests

### TypeScript (Jest)

```bash
npm install
npx jest                      # run everything
npx jest __tests__/hooks/     # only the hook tests
npx jest --coverage           # with coverage report
npx tsc --noEmit              # TypeScript typecheck (not a test, but a related check)
```

The Jest config (`jest.config.js`) uses `@react-native/jest-preset` and
adds:

- A `jest.setup.js` that mocks `react-native-safe-area-context` and
  registers the `NativeModules.GpsRecorder` mock so any test can drive
  the native module via `global.__gpsRecorderMock.start.mockResolvedValueOnce(...)`.
- A `testPathIgnorePatterns` that excludes `android/`, `ios/`, and
  `__tests__/helpers/` (the helpers are modules, not test files).
- A `coverageThreshold` floor at 50/40/50/50 — not aiming for 100% (the
  recording pipeline is hard to exercise in JSDOM) but every helper,
  every presentational component, and every hook has at least one test.

### Kotlin (JUnit + Robolectric)

```bash
cd android
./gradlew testDebugUnitTest --no-daemon --stacktrace
```

Robolectric is added so we can test classes that depend on the Android
framework (`android.util.Log`, `org.xmlpull.v1.XmlPullParser`) without
a real device or emulator. The pure-JVM tests (TrackMath, GpsPoint,
SegmentedBuffer, AutoPauseGapControllerConstants, etc.) run on a stock
JDK without Robolectric.

Test HTML reports are at:
`android/app/build/reports/tests/testDebugUnitTest/index.html`

### Both (CI)

The `.github/workflows/test.yml` GitHub Actions workflow runs both suites
on every push and pull request:

- **jest** job: `npx tsc --noEmit` + `npx jest --coverage --ci`
- **kotlin** job: `./gradlew testDebugUnitTest --no-daemon --stacktrace`

Both jobs upload their artifacts (coverage report, test log, HTML report)
with 7-day retention so they can be downloaded from the Actions tab.

---

## What's tested (and what isn't)

### Tested

- **Pure helpers** (TS): `pad2`, `pluralRu`, `formatDuration`,
  `formatDistance`, `computeAvgPace`, `computeCurrentPace` — 39 tests
  in the original `format.test.ts`, plus the `COLOR` palette, the
  `RecordingState` type, and `appStyles` integrity.
- **Native module wrapper** (TS): the `GpsRecorder` object delegates
  correctly to `NativeModules.GpsRecorder` with the right argument
  shapes; `subscribe()` returns the `EmitterSubscription`; the fallback
  no-op object is used when the native module is missing.
- **Hooks** (TS):
  - `usePermissions`: 15 tests — permission flow, battery-opt flow,
    initialCheck, handleGrantPermissions.
  - `useSettings`: 36 tests — 11 settings + 3 mirror refs + U15
    re-entrancy + revert-on-error + clamp ranges + loadSettings.
  - `useGnssMonitor`: 18 tests — initial state, handleGnssEvent,
    resetGnss, start/stopMonitor, individual setters.
  - `useRecordingEventHandlers`: 31 tests — the 5 factory functions
    (location / duration / state / saved / error).
  - `useRecordingControls`: 18 tests — handleStart / handleStop, the
    1s fallback, the 15s hard fallback, error revert paths.
- **Components** (TS): all 13 presentational components have rendering
  tests — StartStopButton, ToggleRow, StepperRow, FilterSettingGroup,
  BigStat, Divider, GnssPill, SavedCard (incl. `selectPaceTimeMs`),
  ErrorCard, Banners (4 sub-components), Overlays (3 variants),
  StatsDisplay (incl. `getStatusText` + `selectPaceTimeMs`),
  ErrorBoundary.
- **Geodesy math** (Kotlin): `TrackMath.haversineMeters`,
  `bearingRad`, `crossTrackDistanceM` — known distances (Moscow →
  St Petersburg), symmetry, triangle inequality, degenerate-segment
  handling, NaN safety.
- **Data classes** (Kotlin): `GpsPoint` equality / hashCode / copy /
  toString with null fields.
- **Segmented buffer** (Kotlin): `SegmentedBuffer` — append, finalize,
  deep-copy snapshots, reset, multi-segment support.
- **GPX I/O** (Kotlin, Robolectric): `GpxIO.gpxHeader`,
  `formatGpxPoint`, `serializeSegmentsToGpx` (incl. L17 single-point
  segment drop), `parseGpxSegments` round-trip + L21 skip-on-missing-
  time / lat / lon, `isoTime` / `parseIsoTime` round-trip.
- **Post-processors** (Kotlin, Robolectric): `gaussianSmoothGpx`
  (incl. L2 elevation-weighted-average fix), `douglasPeuckerGpx`
  (idempotency, corner preservation, epsilon=0 no-op, segment
  isolation), `douglasPeuckerSimplify` direct list→list helper.
- **Constants** (Kotlin): all the auto-pause / gap / filter constants
  are pinned so a silent refactor shows up as a failing test.
- **State machine** (Kotlin): the gap/pause race invariant from
  `GapPauseRaceTest.kt` is expanded with 8 more scenarios
  (auto-pause suppression, signalLost idempotency, gapDetectionEnabled
  toggle, no-fix-yet case, grace-window boundary, multiple cycles,
  steady-state recording).

### NOT tested (intentional)

- **`GpsRecorderService` itself** — extends Android `Service`, uses
  `SharedPreferences`, `LocationListener`, `PowerManager.WakeLock`,
  `Handler`. Would require Robolectric + heavy mocking for limited
  additional value over the pure-helper tests. The pure decision logic
  is extracted into mirror-test classes (`GapPauseStateMachine` in
  `GapPauseRaceTest.kt`, `accept()` in `DistanceAccumulatorLogicTest.kt`).
- **`LocationChangedHandler.onLocationChanged`** — same reason. The
  8 filter stages are tested via the constant-pinning tests + the
  DistanceAccumulator mirror logic.
- **`App.tsx`** — heavily dependent on the native GpsRecorder module,
  runs many async mount effects (subscribe, poll state, load settings),
  uses SafeAreaView + AppState listener. Brittle to test in JSDOM.
  The hook tests already cover the logic; the component tests cover
  the presentational layer.
- **Instrumented tests** (real device / emulator) — not added because
  they require an Android emulator in CI, which is much heavier than
  Robolectric. The pure-JVM + Robolectric coverage is sufficient for
  this codebase.

---

## Adding new tests

### TypeScript

1. Create a new file under `__tests__/` (or a subdirectory).
2. Import the helper utilities you need from `./helpers`:
   ```ts
   import { render, press, allText, allPressables } from './helpers/render';
   import { renderHook, act } from './helpers/renderHook';
   import { gpsMock, clearGpsMock, makeRef } from './helpers';
   ```
3. Use `describe()` / `it()` blocks. Each `it` should test ONE
   behavior.
4. For async hooks that use `setTimeout(800)` internally, use the
   pattern:
   ```ts
   let p: Promise<void>;
   act(() => { p = result.current.handleGrantPermissions(); });
   await act(async () => {
     await jest.advanceTimersByTimeAsync(800);
     await p!;
   });
   ```
5. Run `npx jest <your-file>` to verify locally.

### Kotlin

1. Create a new file under
   `android/app/src/test/java/com/gpsrecorder/`.
2. For pure-JVM tests (no Android framework dependencies), use plain
   JUnit 4 annotations (`@Test`, `@Before`, `org.junit.Assert.*`).
3. For tests that need Android framework (Log, Context, XmlPullParser),
   add `@RunWith(RobolectricTestRunner::class)` and `@Config(sdk = [33])`.
4. Use `@Config(sdk = [33])` because Robolectric doesn't yet support
   SDK 35 (the project's `compileSdk`).
5. Run `./gradlew testDebugUnitTest --no-daemon --stacktrace` to
   verify locally.

---

## Coverage

The Jest coverage threshold (in `jest.config.js`) is set to:

- Statements: 50%
- Branches: 40%
- Functions: 50%
- Lines: 50%

These are deliberately modest — the recording pipeline is hard to
exercise in JSDOM — but every pure helper, every presentational
component, and every hook has at least one test. If you add a new
public function / component / hook, please add at least one test
for it. CI will fail the build if coverage drops below the floor.
