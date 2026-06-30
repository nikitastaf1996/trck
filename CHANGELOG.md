# Changelog

Historical record of bug fixes that were applied to the GPS recorder. The
"Bugfix:" narrative comments that previously littered `GpsRecorderService.kt`
have been removed from the live code (see TODO 4, O22) and preserved here so
the rationale for the tricky bits of the implementation is not lost.

The entries below are grouped by the area of code they affect. Each entry
includes a short explanation of the bug, why the previous behaviour was wrong,
and what the fix does.

---

## Auto-pause vs. gap-detection interaction

These fixes address a class of bugs where the gap-detection (signal-loss)
watchdog and the auto-pause (stationary) detector interfered with each other
and produced contradictory UI banners and spurious 1-point segments in the
final GPX file.

### Suppress the gap watchdog while auto-paused

When the user is stationary, Android throttles location updates (min-distance
= 1 m), so no fixes arrive even though the GPS hardware is fine. Treating
that as a signal loss is wrong — we already know the user is just standing
still — and it caused the "ПОТЕРЯ СИГНАЛА GPS" banner to appear on top of the
"АВТОПАУЗА" banner in the UI, which is contradictory and confusing.

**Fix:** the gap watchdog is now suppressed while `isAutoPaused` is true.
The watchdog only fires when the user is supposed to be moving (i.e. not
auto-paused) and fixes stop arriving.

### Clear `signalLost` on auto-pause entry

Same root cause as above. When the user becomes stationary we already know
why no fixes are arriving, so showing both banners at once is wrong.
`enterAutoPause()` now clears `signalLost = false` as part of the transition.

### Skip the gap-recovery block while auto-paused

When the user is stationary the gap-detection logic is irrelevant — the lack
of fresh fixes is expected (Android throttles updates when min-distance isn't
met), and we already finalized the current segment when auto-pause was
entered. Running `handleGapRecovery` here would create a spurious second
segment split and produce 1-point segments in the final GPX (the "5 segments,
one of them only 1 point" pattern observed in real walks).

**Fix:** the gap-recovery branch in `onLocationChanged` is now guarded by
`!isAutoPaused` so it is skipped while the user is stationary.

---

## Moving-time accounting

These fixes ensure the moving-time accumulator tracks the actual time the
user was moving, not the wall-clock time of the recording.

### Cap the stop-time delta at `lastFixTimeMs`

When the user stops recording, we add the time from the last resume up to the
last fix to `movingMs`. Previously the delta was capped at "now" (`System.
currentTimeMillis()`). If the user stopped walking 5 seconds before pressing
STOP (and the auto-pause hadn't triggered yet because the window hadn't
filled), those 5 seconds of standing-still were incorrectly counted as
moving time.

**Fix:** the delta is now capped at `lastFixTimeMs`. This makes the persisted
`movingMs` consistent with the `liveMovingMs` value the UI was showing right
before STOP.

### Resume the moving-time accumulator on gap recovery

While a gap was active the watchdog froze `movingMs` so the gap time was not
counted as moving time. Now that the user has a fix again we resume
accumulating from this instant — but only if the user is actually moving. If
they are stationary the auto-pause path further down in `onLocationChanged`
will immediately re-freeze `movingMs` via `enterAutoPause()`, so this is safe.

### Emit `liveMovingMs` in location events

Previously the location event emitted the frozen `movingMs` field. The
frozen value is only updated at auto-pause transitions, so between
transitions the displayed average pace was wildly off (e.g. `0:02/km` or
`6:20/km`). The fix emits `liveMovingMs(pt.timeMs)`, which adds the time
elapsed since the last resume so the value tracks the actual walk
second-by-second.

### Persist `liveMovingMs` in `saveLiveState()`

JS polls `getState()` every 2 seconds as a fallback when event delivery is
unreliable. Previously the polled `movingMs` was just as stale as the emitted
one — the same `0:02/km` or `6:20/km` bug surfaced through this path too.
The fix persists `liveMovingMs(lastFix.timeMs)` so the polled value is also
fresh.

---

## Distance accounting

### Stage `distanceToAdd` before the radial filter

`distanceToAdd` is now staged in a local and only committed to
`totalDistanceM` *after* the radial-filter check passes. The previous version
did `totalDistanceM += d` before the radial check, so a dropped (too-close)
fix would leak its step distance into the accumulator while `prevLat` /
`prevLon` stayed put — the next accepted fix then re-computed distance from
the same cursor, double-counting the dropped step.

**Fix:** the distance is only added to the accumulator when the fix survives
the radial filter, so the cursor and accumulator always advance together.
