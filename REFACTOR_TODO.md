# Deferred Refactor Work — Post-v1.4.0 TODO

This file tracks the architectural refactors that were **identified but
deliberately deferred** during the v1.4.0 JS state-architecture refactor
(see `CHANGELOG.md` v1.4.0). Each item needs a real Android device to
verify behaviour — too risky to do blind.

The v1.4.0 refactor only touched the **JS side**. The items below are
all on the **Kotlin side** and address the deeper architectural issues
called out in the original code review.

---

## Why these were deferred

The v1.4.0 refactor was safe to do without a device because:
- The JS side is exercised by 269 Jest tests
- TypeScript catches type regressions at compile time
- The native bridge contract is unchanged — the stores call the exact
  same `GpsRecorder.*` methods the hooks used to call

The Kotlin-side refactors below touch code paths that **only run on a
real device** (foreground service lifecycle, GPS callbacks, file I/O,
SharedPreferences, wake locks). The existing Kotlin tests (~80) cover
pure helpers but explicitly skip `GpsRecorderService` and
`LocationChangedHandler` (see `TESTING.md` → "NOT tested"). Doing
these refactors blind would risk regressions in the recording-stability
guarantees that are the whole point of the app.

**Prerequisite for any of this work:** set up an Android device or
emulator for manual testing. Record at least one full track before and
after each refactor and diff the resulting GPX files.

---

## Item 1: Promote `AutoPauseGapController` to a real state machine

### Current state

`AutoPauseGapController.kt` (504 lines) is a "methods-only" helper that
mutates `GpsRecorderService`'s `@Volatile internal var` fields directly:

```kotlin
class AutoPauseGapController(private val service: GpsRecorderService) {
    fun enterAutoPause(now: Long) {
        service.isAutoPaused = true
        service.signalLost = false
        service.lastResumeMs?.let { r -> if (now > r) service.movingMs += (now - r) }
        service.lastResumeMs = null
        service.consecutiveMovingFixes = 0
        // ... 7 more service.X mutations
    }
}
```

The state fields live on the service as `@Volatile internal var`:
`isAutoPaused`, `signalLost`, `movingMs`, `lastResumeMs`,
`autoPauseResumeGraceUntilMs`, `consecutiveMovingFixes`, `rawWindow`.

The invariants between these fields (e.g. "if `signalLost` is true,
`lastResumeMs` must be null") are enforced **only by comments**. The
class header admits this:

> STATE OWNERSHIP: per the K6 design ..., the actual state fields stay
> on the service as `@Volatile internal var` so the 470-line
> `onLocationChanged` method can read/write them directly without
> changing hundreds of references. This controller's methods operate
> on those fields via `service.` references — identical behavior to
> the original inline implementation, just relocated.

This is decomposition theatre: the file count looks better, but the
coupling is identical to the pre-refactor monolith.

### Target state

The controller becomes a closed state machine that **owns its state
privately** and exposes a small decision-based API:

```kotlin
class AutoPauseStateMachine(
    private val settings: SettingsReader,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    // All state is private. No service back-reference.
    private var isAutoPaused = false
    private var signalLost = false
    private var movingMs = 0L
    private var lastResumeMs: Long? = null
    private var graceUntilMs = 0L
    private var consecutiveMovingFixes = 0
    private val rawWindow = LinkedList<GpsPoint>()

    sealed class Decision {
        object None : Decision()
        object EnterAutoPause : Decision()
        object ExitAutoPause : Decision()
        data class GapRecovered(val committedMovingDelta: Long) : Decision()
        data class SignalLost(val committedMovingDelta: Long) : Decision()
    }

    fun onFix(pt: GpsPoint): Decision { /* ... */ }
    fun onTick(now: Long): Decision { /* ... */ }
    fun liveMovingMs(now: Long): Long { /* ... */ }
    fun reset(startTimeMs: Long) { /* ... */ }
    fun snapshot(): StateSnapshot { /* ... */ }
    fun restore(s: StateSnapshot) { /* ... */ }
}
```

The service becomes a thin orchestrator: it routes `onLocationChanged`
→ filter pipeline → `stateMachine.onFix(pt)`, and `durationTick` →
`stateMachine.onTick(now)`. State invariants become compiler-enforced
(private fields) instead of comment-enforced.

### Migration plan

1. Create the new `AutoPauseStateMachine` class alongside the existing
   `AutoPauseGapController`. Don't delete the old one yet.
2. Add a feature flag (e.g. a `BuildConfig` boolean or a hidden setting)
   that routes fix/tick calls to the new machine when enabled.
3. Run both machines in parallel for one recording session, logging
   divergence. Diff the resulting GPX files.
4. Once confident, delete `AutoPauseGapController` and the `@Volatile
   internal var` fields on the service.

### Estimated effort

- 1 day to write the new state machine + adapter
- 1 day of device testing to validate behaviour parity
- 0.5 day to delete the old code and clean up

### Files affected

- `AutoPauseGapController.kt` (delete)
- `AutoPauseHandler.kt` (merge into the new machine)
- `GpsRecorderService.kt` (remove ~7 `@Volatile internal var` fields,
  rewire `onLocationChanged` and `durationTick` to call the new machine)
- `LocationChangedHandler.kt` (remove `service.` references to the
  moved fields)
- `StateRepository.kt` (update `saveLiveState` / `recoverStateIfAny`
  to call `stateMachine.snapshot()` / `restore()` instead of reading
  individual fields)
- New: `AutoPauseStateMachine.kt`

### Risk

Medium-high. The auto-pause + gap-detection logic is the most subtle
code in the app. The L*/Task tags in this area (Task 1, Task 2, H2)
document real race conditions that were fixed by careful ordering of
field mutations. The new state machine must preserve that ordering.
Run the `GapPauseRaceTest.kt` scenarios against the new machine before
any device test.

---

## Item 2: Drop the temp-file XML round-trip in post-processing

### Current state

The post-processing pipeline (`GpxFileSaver.kt`) does this on stop:

1. Write the raw GPX file from the in-memory segment buffer.
2. If Gaussian smoothing is enabled: read the file back, parse the XML,
   apply the smoother, serialize back to XML, overwrite the file.
3. If Douglas-Peucker is enabled: read the file back, parse the XML,
   apply the simplifier, serialize back to XML, overwrite the file.
4. Re-open the saved file via `ContentResolver`, parse the XML again,
   recompute the total distance (because smoothing changed the path
   length — L13 fix).

That's **up to 4 parse/serialize cycles** on a single stop. For a
3-hour 1Hz recording (~10,800 points), each cycle is non-trivial.

The temp-file strategy (`TempFileBuffer.kt`) is also doing byte-level
surgery: `RandomAccessFile.setLength` to truncate the closing GPX tags
before appending new points. This works (the closing tags are pure
ASCII so byte lengths are deterministic), but it's clever code that
future contributors will be afraid to touch.

### Target state

Keep the in-memory `SegmentedBuffer` as the source of truth during
recording. On stop:

1. Take a snapshot of the segments (`List<List<GpsPoint>>`).
2. Run Gaussian smoothing on the in-memory list (pure function:
   `List<GpsPoint> → List<GpsPoint>`).
3. Run Douglas-Peucker on the in-memory list (same signature).
4. Compute the final distance from the in-memory list (no file re-read).
5. Stream-write the final GPX file **once**, using a streaming XML
   writer (no DOM, no parse).

For crash recovery, replace the append-only temp-file strategy with a
binary serialization of the segment buffer:

```kotlin
// ~40 bytes per point: lat (8) + lon (8) + alt (8, nullable as 0/1 flag +
// value) + speed (4) + accuracy (4) + timeMs (8). A 3-hour 1Hz recording
// is ~432 KB — trivial.
data class GpsPointBinaryCodec {
    fun write(points: List<GpsPoint>, out: OutputStream) { /* ... */ }
    fun read(input: InputStream): List<GpsPoint> { /* ... */ }
}
```

The binary file is written atomically every 5 s (rename `.tmp` →
`.bin`). On START_STICKY recovery, read the binary file back into the
segment buffer. No XML parsing, no byte truncation, no closing-tag
hacks.

### Migration plan

1. Write the binary codec + round-trip tests (pure JVM, no Android).
2. Add the new post-processing pipeline alongside the old one, gated
   by a feature flag.
3. On device: record a track with Gaussian + Douglas-Peucker both on,
   diff the resulting GPX against the old pipeline's output. They
   should be byte-identical (or close — floating-point order may
   differ).
4. Once confident, delete `TempFileBuffer.kt`'s XML surgery and the
   re-read-after-write logic in `GpxFileSaver.kt`.

### Estimated effort

- 1 day for the binary codec + tests
- 0.5 day to rewire `GpxFileSaver`
- 1 day of device testing (especially crash recovery: kill the app
  mid-recording via `adb shell am force-stop`, restart, verify the
  track resumes cleanly)

### Files affected

- `TempFileBuffer.kt` (replace XML append-only strategy with binary)
- `GpxFileSaver.kt` (remove the 3 re-parse cycles, do in-memory
  transforms + single streaming write)
- `GpxIO.kt` (add a streaming writer; the parser can stay for
  backward-compat with old temp files if needed, or be removed if
  we decide to break recovery for in-flight recordings)
- `StateRepository.kt` (update `recoverStateIfAny` to read the binary
  format)
- New: `GpsPointBinaryCodec.kt`

### Risk

Medium. The crash-recovery path is the riskiest part — it's the whole
point of the temp file. Test by:
- Recording for 30 s, force-stop the app, relaunch — track should
  resume with all 30 s of data.
- Recording for 30 s, reboot the phone, relaunch — same.
- Recording for 30 s, let the OS kill the service under memory
  pressure — same.

### Edge case to handle

If a user upgrades from v1.4.0 (with an in-flight XML temp file) to
the new version, the recovery path will fail to parse the binary
format. Either: (a) detect the XML header and parse it once for
migration, or (b) accept that an in-flight recording at upgrade time
is lost (acceptable for a sideloaded personal app).

---

## Item 3: Collapse the three timing layers

### Current state

There are **three independent timing layers** all updating the same
logical "elapsed time" / "moving time" the UI displays:

1. **Native 1 Hz `durationTick`** — emits a `duration` event every
   second with `elapsedMs` + `movingMs` + a monotonically increasing
   `seq` counter.
2. **Native 5 s throttled `saveLiveState`** — writes the live state to
   SharedPreferences (used by the START_STICKY recovery path AND by the
   JS `getState()` poll).
3. **JS 2 s `syncStateFromNative` polling** — calls `getState()` every
   2 s while recording as a "fallback for when events are dropped."

Plus layered defenses against each layer's failure mode:

- **L24** — JS drops out-of-order `duration` events via the `seq`
  counter (because the 2 s poll and the 1 Hz tick can deliver values
  out of order, which would make the displayed timer jump backwards
  by ~1 s).
- **`syncFromNative` stale-value guard** — `setElapsedMs((prev) =>
  state.elapsedMs >= prev ? state.elapsedMs : prev)` rejects stale
  poll values.
- **`liveMovingMs(now)`** — computes "true up-to-the-second moving
  time" because the persisted `movingMs` field was only updated on
  transitions, not on ticks.
- **`STOP_HARD_FALLBACK_MS = 15_000`** — if neither the `'saved'`
  event nor the 1 s soft poll recovered the UI, forcibly reset to
  idle.

The architecture has three layers because the team didn't trust event
delivery — but instead of fixing event delivery, they kept adding
fallbacks. Each fallback got a tag. Each tag is now load-bearing.

### Target state

Pick **one** timing layer and delete the other two. Two options:

**Option A: Trust the 1 Hz `duration` event (preferred).**

- Keep the 1 Hz `durationTick` as the sole source of truth for
  `elapsedMs` and `movingMs`.
- Delete the 2 s JS `syncStateFromNative` polling entirely.
- Delete the `seq` counter and the L24 out-of-order-drop logic (no
  second source to be out of order with).
- Delete the `setElapsedMs(prev => state >= prev ? ...)` stale guard.
- Keep `saveLiveState` only for the START_STICKY recovery path (not
  for UI polling) — and only write it on `pause`/`resume`/`stop`
  transitions, not on a throttle.
- Delete `STOP_HARD_FALLBACK_MS` — if the `'saved'` event doesn't
  arrive, the user can press STOP again (the existing error revert
  path handles this).

**Option B: Single 1 Hz poll, no events.**

- Delete the `duration` event entirely.
- JS polls `getState()` every 1 s while recording.
- `getState()` reads from in-memory fields (not SharedPreferences —
  no throttle needed, no disk I/O).
- This is simpler but loses the "event-driven UI" property — every
  UI update is a poll, even for `'location'` and `'state'` events
  that we keep anyway. Inconsistent.

Option A is cleaner. The only risk is: what if the bridge drops a
`duration` event? In practice, `RCTDeviceEventEmitter` is reliable
when the JS app is in the foreground; when the app is backgrounded,
the UI doesn't need to update anyway (it'll re-sync on foreground
via the existing `AppState` listener).

### Migration plan

1. Add a feature flag that disables the 2 s JS poll.
2. On device: record a track with the app in the foreground the whole
   time. Verify the timer never jumps backwards and the displayed
   pace is smooth.
3. Background the app for 30 s mid-recording, bring it back to
   foreground. Verify the timer catches up correctly (the
   `AppState` listener calls `syncFromNative` once on foreground).
4. Once confident, delete the 2 s poll, the `seq` counter, the L24
   logic, and the stale-value guard.
5. Separately: evaluate whether `STOP_HARD_FALLBACK_MS` can be
   removed. It exists because the `'saved'` event might not arrive
   if the service is killed mid-stop. If the 1 s soft fallback is
   sufficient (it polls `getState()` which reads in-memory state),
   the 15 s hard fallback is redundant.

### Estimated effort

- 0.5 day to remove the 2 s poll + L24 logic + stale guard
- 0.5 day of device testing (foreground, background, kill-mid-stop
  scenarios)
- 0.5 day to evaluate and possibly remove `STOP_HARD_FALLBACK_MS`

### Files affected

- `src/store/recordingStore.ts` (remove `lastDurationSeq`, the L24
  check in `applyDurationEvent`, the stale-value guard in
  `syncFromNative`, the 2 s polling effect in `App.tsx`, possibly
  the hard fallback)
- `App.tsx` (remove the 2 s polling `useEffect`)
- `GpsEventEmitter.kt` (remove the `seq` field from `emitDuration`)
- `useRecordingEventHandlers` is already gone (v1.4.0), so the L24
  logic only lives in the store now
- `CHANGELOG.md` (note the L24 invariant is no longer needed)

### Risk

Low-medium. The 1 Hz `duration` event has been the primary source of
truth all along — the 2 s poll was always a fallback. Removing the
fallback is safe as long as the foreground/background transition is
tested. The `AppState` listener already calls `syncFromNative` on
foreground, so backgrounded time is recovered.

The hardest part is convincing yourself that `STOP_HARD_FALLBACK_MS`
can go. Test by: start a recording, press STOP, immediately
force-stop the app via `adb shell am force-stop`. Relaunch — the UI
should recover to idle (the 1 s soft fallback polls `getState()`,
which reports `isRecording=false` because the service's `onDestroy`
ran the finalize path).

---

## Item 4 (lower priority): Consolidate the Kotlin `@Volatile internal var` god-object

### Current state

`GpsRecorderService.kt` (585 lines) still owns ~15 `@Volatile internal
var` fields that every helper class (`LocationChangedHandler`,
`AutoPauseGapController`, `StateRepository`, `TempFileBuffer`,
`GpxFileSaver`, `GpsRecorderNotification`) reads and writes directly
via `service.X` references. This is the same pattern Item 1 addresses
for the auto-pause fields, but applied to the rest of the service's
state too.

The fields:
- `isRecording`, `startTimeMs`, `pointCount`, `tempFileName`
- `totalDistanceM`, `lastFixTimeMs`
- `prevLat`, `prevLon`, `prevTimeMs` (validation cursor)
- `isAutoPaused`, `signalLost`, `movingMs`, `lastResumeMs`,
  `autoPauseResumeGraceUntilMs`, `consecutiveMovingFixes` (owned by
  Item 1's state machine)
- `rawWindow` (owned by Item 1's state machine)

### Target state

After Item 1, the auto-pause fields move into `AutoPauseStateMachine`.
The remaining fields should be grouped into cohesive owners:

- `RecordingSession` — `isRecording`, `startTimeMs`, `pointCount`,
  `tempFileName`. The session lifecycle.
- `TrackAccumulator` — `totalDistanceM`, `prevLat`, `prevLon`,
  `prevTimeMs`, `lastFixTimeMs`. The distance/validation cursor.
- `SegmentedBuffer` (already exists) — `trackSegments`,
  `currentSegment`, `pointBufferLock`.

The service becomes a thin orchestrator that holds these three (plus
the state machine from Item 1, plus `WakeLockManager`,
`GpsRecorderNotification`, `LocationSource`, `TempFileBuffer`,
`GpxFileSaver`, `StateRepository`) and routes lifecycle events to
them.

### Estimated effort

- 2 days (after Item 1 lands)
- Mostly mechanical: move fields, update references, run tests
- Device testing: 1 day

### Risk

Low if Item 1 is done first (it establishes the pattern). Medium
otherwise (you'd be doing two architectural changes at once).

---

## Item 5 (lowest priority): Extract Russian strings to a single file

### Current state

Per `AGENTS.md` → Code organisation principles #5:

> Russian strings are inline. The UI is Russian-language only.
> Strings live directly in the JSX / Kotlin code, not in a separate
> i18n file. When extracting components, strings travel with their
> component.

This was a fine v1 decision. It's now permanent lock-in: any future
localization requires touching every component and every Kotlin string.

### Target state

Single `src/strings.ts` file exporting all user-facing strings:

```ts
export const STRINGS = {
  startButton: 'СТАРТ',
  stopButton: 'СТОП',
  settingsHeader: 'НАСТРОЙКИ',
  settingsLockedBadge: '🔒 Заблокировано на время записи (остановите, чтобы изменить)',
  // ... ~40 more
} as const;
```

Components import the strings they need. The Kotlin side keeps its
strings inline (notification text, error messages) — those are
Android resources, not JS strings, and extracting them to
`strings.xml` is a separate (smaller) task.

### Estimated effort

- 0.5 day, mostly find-and-replace
- No behaviour change, no risk

### Why it's lowest priority

The app is Russian-only by design. If that never changes, this is
busywork. If localization becomes a goal, this is the prerequisite.

---

## Testing strategy for all items

Every item should follow this pattern:

1. **Before**: record a reference track on the current code. Save the
   GPX file. Note the displayed elapsed time, distance, and average
   pace at the end.
2. **Implement** the refactor on a feature branch.
3. **Unit tests**: all existing Kotlin + TS tests must pass unchanged.
   Add new tests for the new code.
4. **After**: record the same route (or as close as possible). Diff
   the GPX files:
   - Point count should match (or be close — filter order shouldn't
     change which points pass).
   - Total distance should match within ~1% (floating-point order).
   - Segment breaks should be at the same timestamps.
5. **Crash recovery test** (especially for Item 2): force-stop the
   app mid-recording, relaunch, verify the track resumes cleanly.
6. **Foreground-service test** (especially for Item 3): background the
   app for 60 s mid-recording, verify the timer catches up correctly
   on foreground.

---

## Suggested order

1. **Item 3** (collapse timing layers) — lowest risk, smallest change,
   removes the most cognitive load. Do this first.
2. **Item 1** (auto-pause state machine) — establishes the pattern for
   Item 4. Medium risk, high payoff.
3. **Item 4** (consolidate god-object) — mechanical once Item 1's
   pattern is proven.
4. **Item 2** (drop temp-file XML round-trip) — independent of 1/3/4,
   can be done in parallel. Highest risk because of the crash-recovery
   path.
5. **Item 5** (extract strings) — whenever. No dependencies.

Each item is independently shippable as its own PR. Don't bundle them.

---

## Open questions for the developer

- Is the no-Google-Play-Services constraint still a hard requirement?
  (Affects whether FusedLocationProviderClient is ever on the table —
  see the rejected alternative in the original code review.)
- Is localization ever a goal? (Affects Item 5 priority.)
- Is there a preferred Android device/emulator for testing? (Affects
  how the crash-recovery tests in Item 2 are run.)
- The `L*` / `U*` / `Task N` tags are still in the codebase (268
  occurrences). Should they be left as historical documentation, or
  removed once the corresponding invariants are structurally enforced
  by the new state machine? (My recommendation: leave them. They're
  inert once the code is correct, and they document the "why" for
  future readers.)
