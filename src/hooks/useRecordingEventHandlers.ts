/**
 * useRecordingEventHandlers — pure factory functions for the 5 native event
 * subscriptions ('location', 'duration', 'state', 'saved', 'error') that are
 * set up ONCE in useRecordingSession's mount effect.
 *
 * Why factories instead of inline arrow functions: extracting the handler
 * bodies into named factory functions lets useRecordingSession.ts stay under
 * 500 lines without changing any behaviour. Each factory captures the state
 * setters and refs it needs via a params object; the returned handler closes
 * over those captured values exactly as the original inline arrows did.
 *
 * Behavioural invariants preserved verbatim from the original inline code
 * (see useRecordingSession.ts header for the full list):
 *
 *   - U18: recordingStateRef is updated SYNCHRONOUSLY (not via useEffect)
 *     inside the 'state' / 'saved' / 'error' handlers so the 'gnss' /
 *     'location' handlers (set up once at mount) read the right value.
 *   - L24: out-of-order 'duration' events are dropped via lastDurationSeqRef
 *     (a monotonically increasing sequence number).
 *   - L8: the 'duration' event's movingMs is preferred over the 'location'
 *     event's movingMs (it fires every 1 Hz vs the much less frequent
 *     location event).
 *   - L10 / U17: the 'error' event with fatal=false does NOT reset to idle
 *     (the recording may still be running); fatal=true DOES reset.
 *   - U3 / Task 4: the 'saved' event snapshots movingMs / elapsedMs / settings
 *     from refs BEFORE resetting them (the once-set-up closure would
 *     otherwise capture stale values).
 *   - U16: the 'saved' event cancels the 1 s fallback syncStateFromNative()
 *     that handleStop scheduled.
 *   - U10: the 'location' handler skips currentSpeed update when
 *     isAutoPausedRef.current is true.
 *   - U4: forceRerender is needed because recentSpeedsRef is mutated in-place
 *     by the 'location' handler (which triggers React to re-run the smoothed-
 *     pace computation in StatsDisplay).
 *
 * The factory functions are pure (no React imports beyond the type-only
 * MutableRefObject import) and have no side effects beyond those captured in
 * their params. They are called from useRecordingSession's mount effect.
 */

import type React from 'react';
import {
  type GpsLocationEvent,
  type GpsDurationEvent,
  type GpsStateEvent,
  type GpsSavedEvent,
  type GpsErrorEvent,
  type GpsFixType,
} from '../NativeGpsRecorder';
import type { RecordingState } from '../styles';
import type { SavedSettingsSnapshot } from './useRecordingSession';

// Sliding window of the most recent GPS speeds (m/s) seen during the current
// recording. Used to compute a smoothed "current pace" instead of relying on
// the raw instantaneous GPS speed, which jumps around a lot at 1 Hz. The
// window is cleared on stop / save so a fresh recording starts with no
// history.
//
// ~5 seconds at 1 Hz — short enough to be responsive, long enough to smooth
// out single-fix outliers.
//
// Exported so useRecordingSession's pushIdleSpeed helper (used by App.tsx's
// 'gnss' handler) can reuse the same window length.
export const SPEED_WINDOW = 5;

// ---------------------------------------------------------------------------
// 'location' handler
// ---------------------------------------------------------------------------

export type LocationHandlerParams = {
  setDistance: (v: number) => void;
  setCurrentSpeed: (v: number | null) => void;
  setFixType: (v: GpsFixType) => void;
  setAccuracy: (v: number | null) => void;
  setHasFix: (v: boolean) => void;
  setIsAutoPaused: (v: boolean) => void;
  setSignalLost: (v: boolean) => void;
  setMovingMs: (v: number) => void;
  isAutoPausedRef: React.MutableRefObject<boolean>;
  recentSpeedsRef: React.MutableRefObject<number[]>;
  forceRerender: () => void;
};

export function createLocationHandler(p: LocationHandlerParams) {
  return (ev: GpsLocationEvent) => {
    // Recording-time updates from the service.
    if (typeof ev.distance === 'number') p.setDistance(ev.distance);
    if (ev.fixType) p.setFixType(ev.fixType);
    if (ev.accuracy != null) p.setAccuracy(ev.accuracy);
    // U10: don't update currentSpeed while auto-paused — the service
    // still emits location events (with the paused fix), but the
    // underlying state shouldn't change. Read isAutoPaused from a ref
    // to avoid stale-closure issues.
    if (ev.speed != null && !p.isAutoPausedRef.current) {
      p.setCurrentSpeed(ev.speed);
      // Push into the smoothing window. We accept every fix here (even
      // slow / zero ones) so the window correctly reflects "user is
      // standing still" — the smoothed pace helper returns null when
      // the window average is below the standing-still threshold.
      const w = p.recentSpeedsRef.current;
      w.push(ev.speed);
      if (w.length > SPEED_WINDOW) w.shift();
      // U4: force a re-render so the smoothed pace display updates
      // immediately. The push above mutated the ref's array in-place,
      // which React doesn't see — without this the rendered pace would
      // be stale until the next setState.
      p.forceRerender();
    }
    p.setHasFix(ev.fixType !== 'no fix');
    // Phase 1/3/4: live auto-pause / signal-lost / moving-time.
    if (typeof ev.isAutoPaused === 'boolean') p.setIsAutoPaused(ev.isAutoPaused);
    if (typeof ev.signalLost === 'boolean') p.setSignalLost(ev.signalLost);
    if (typeof ev.movingMs === 'number') p.setMovingMs(ev.movingMs);
  };
}

// ---------------------------------------------------------------------------
// 'duration' handler
// ---------------------------------------------------------------------------

export type DurationHandlerParams = {
  setElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  setMovingMs: (v: number) => void;
  lastDurationSeqRef: React.MutableRefObject<number>;
};

export function createDurationHandler(p: DurationHandlerParams) {
  return (ev: GpsDurationEvent) => {
    // L24 fix: ignore out-of-order duration events using the
    // monotonically increasing sequence number. The state poll
    // (syncStateFromNative, every 2 s) also sets elapsedMs, and the
    // two paths can deliver values out of order — causing the
    // displayed timer to occasionally jump backwards by ~1 s.
    //
    // We track the last-processed seq in a ref; any event with a seq
    // <= the last one is silently dropped. The getState() poll is
    // also gated to not overwrite elapsedMs if its value is less than
    // the current value (see syncStateFromNative).
    if (typeof ev.seq === 'number' && ev.seq <= p.lastDurationSeqRef.current) {
      return;
    }
    if (typeof ev.seq === 'number') {
      p.lastDurationSeqRef.current = ev.seq;
    }
    p.setElapsedMs(ev.elapsedMs);
    // L8 fix: prefer the duration event's movingMs over the (stale)
    // location event's movingMs. The duration tick fires every second,
    // so the displayed avg pace no longer oscillates between the live
    // duration tick and the much-less-frequent location event.
    if (typeof ev.movingMs === 'number') {
      p.setMovingMs(ev.movingMs);
    }
  };
}

// ---------------------------------------------------------------------------
// 'state' handler
// ---------------------------------------------------------------------------

export type StateHandlerParams = {
  setRecordingState: React.Dispatch<React.SetStateAction<RecordingState>>;
  setElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  setDistance: (v: number) => void;
  setCurrentSpeed: (v: number | null) => void;
  setIsAutoPaused: (v: boolean) => void;
  setSignalLost: (v: boolean) => void;
  setMovingMs: (v: number) => void;
  recordingStateRef: React.MutableRefObject<RecordingState>;
  recentSpeedsRef: React.MutableRefObject<number[]>;
  resetGnss: () => void;
};

export function createStateHandler(p: StateHandlerParams) {
  return (ev: GpsStateEvent) => {
    if (ev.isRecording) {
      // U18: update ref synchronously.
      p.recordingStateRef.current = 'recording';
      p.setRecordingState('recording');
      p.setElapsedMs(ev.elapsedMs);
      // Phase 1/3/4: sync live pause / signal / moving-time on state
      // transitions (e.g. when the watchdog fires or auto-pause toggles).
      if (typeof ev.isAutoPaused === 'boolean') p.setIsAutoPaused(ev.isAutoPaused);
      if (typeof ev.signalLost === 'boolean') p.setSignalLost(ev.signalLost);
      if (typeof ev.movingMs === 'number') p.setMovingMs(ev.movingMs);
    } else {
      // U18: update ref synchronously.
      p.recordingStateRef.current = 'idle';
      p.setRecordingState('idle');
      p.setElapsedMs(0);
      p.setDistance(0);
      p.setCurrentSpeed(null);
      // resetGnss() clears fixType / hasFix / accuracy when recording
      // stops.
      p.resetGnss();
      // Phase 1/3/4: reset live state when recording stops.
      p.setIsAutoPaused(false);
      p.setSignalLost(false);
      p.setMovingMs(0);
      // Clear the pace-smoothing window so a fresh recording starts
      // with no stale speeds from the previous run.
      p.recentSpeedsRef.current = [];
    }
  };
}

// ---------------------------------------------------------------------------
// 'saved' handler
// ---------------------------------------------------------------------------

export type SavedHandlerParams = {
  setLastSavedMovingMs: (v: number) => void;
  setLastSavedElapsedMs: (v: number) => void;
  setLastSavedSettings: (v: SavedSettingsSnapshot | null) => void;
  setLastSavedPath: (v: string | null) => void;
  setLastSavedDistance: (v: number | null) => void;
  setElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  setDistance: (v: number) => void;
  setCurrentSpeed: (v: number | null) => void;
  setFixType: (v: GpsFixType) => void;
  setHasFix: (v: boolean) => void;
  setRecordingState: React.Dispatch<React.SetStateAction<RecordingState>>;
  setIsAutoPaused: (v: boolean) => void;
  setSignalLost: (v: boolean) => void;
  setMovingMs: (v: number) => void;
  stopTimeoutRef: React.MutableRefObject<number | null>;
  // H4 fix (Task 3): hard grace-period fallback ref. Cancelled alongside
  // stopTimeoutRef when the 'saved' event arrives — see stopRecording in
  // useRecordingControls.ts for the rationale.
  stopHardTimeoutRef: React.MutableRefObject<number | null>;
  movingMsRef: React.MutableRefObject<number>;
  elapsedMsRef: React.MutableRefObject<number>;
  autoPauseEnabledRef: React.MutableRefObject<boolean>;
  gapDetectionEnabledRef: React.MutableRefObject<boolean>;
  showMovingTimeRef: React.MutableRefObject<boolean>;
  recordingStateRef: React.MutableRefObject<RecordingState>;
  recentSpeedsRef: React.MutableRefObject<number[]>;
};

export function createSavedHandler(p: SavedHandlerParams) {
  return (ev: GpsSavedEvent) => {
    // U16: cancel the 1 s fallback syncStateFromNative() that handleStop
    // scheduled — the 'saved' event has arrived, so we don't need the
    // fallback and don't want it to fire after we've already transitioned
    // to 'idle' (would cause a brief flicker back to 'stopping').
    if (p.stopTimeoutRef.current != null) {
      clearTimeout(p.stopTimeoutRef.current);
      p.stopTimeoutRef.current = null;
    }
    // H4 fix (Task 3): also cancel the hard grace-period fallback — the
    // 'saved' event has arrived, so the UI is about to transition to
    // 'idle' via the code below. Letting the hard timer fire 15 s later
    // would be a no-op (recordingStateRef would already be 'idle') but
    // cancelling it is cleaner and makes the intent explicit.
    if (p.stopHardTimeoutRef.current != null) {
      clearTimeout(p.stopHardTimeoutRef.current);
      p.stopHardTimeoutRef.current = null;
    }
    // Snapshot the live timing values BEFORE we reset them, so the
    // saved card can show the post-save average pace over the final
    // distance / moving time. We read from refs because this closure
    // is set up once at mount and would otherwise capture stale values.
    p.setLastSavedMovingMs(p.movingMsRef.current);
    p.setLastSavedElapsedMs(p.elapsedMsRef.current);
    // U3: snapshot the toggle state at save time so the saved card's
    // pace computation is stable — the user can flip auto-pause / gap
    // detection / show-moving-time AFTER the save (in preparation for
    // the next run) and the just-saved card must not recompute its
    // pace under the new toggle state.
    p.setLastSavedSettings({
      autoPauseEnabled: p.autoPauseEnabledRef.current,
      gapDetectionEnabled: p.gapDetectionEnabledRef.current,
      showMovingTime: p.showMovingTimeRef.current,
    });
    p.setLastSavedPath(ev.filePath);
    // The native side sends the post-save distance (recomputed from the
    // saved GPX file, post-smoothing) so the UI shows the true track
    // length. Negative means "not available" — keep the live distance.
    const fd = ev.finalDistanceM;
    p.setLastSavedDistance(typeof fd === 'number' && fd >= 0 ? fd : null);
    p.setElapsedMs(0);
    p.setDistance(0);
    p.setCurrentSpeed(null);
    p.setFixType('no fix');
    p.setHasFix(false);
    // U18: update ref synchronously.
    p.recordingStateRef.current = 'idle';
    p.setRecordingState('idle');
    // Phase 1/3/4: clear live pause / signal / moving-time after save.
    p.setIsAutoPaused(false);
    p.setSignalLost(false);
    p.setMovingMs(0);
    // Clear the pace-smoothing window for the next recording.
    p.recentSpeedsRef.current = [];
  };
}

// ---------------------------------------------------------------------------
// 'error' handler
// ---------------------------------------------------------------------------

export type ErrorHandlerParams = {
  setErrorMsg: (msg: string | null) => void;
  setRecordingState: React.Dispatch<React.SetStateAction<RecordingState>>;
  recordingStateRef: React.MutableRefObject<RecordingState>;
};

export function createErrorHandler(p: ErrorHandlerParams) {
  return (ev: GpsErrorEvent) => {
    // L10 fix / U17: only reset the UI to idle on FATAL errors.
    // Non-fatal errors (e.g. distance recompute failed, or
    // finalizeGpxFile threw after the GPX was already written) are
    // informational — the recording may still be running OR may have
    // already completed normally. Resetting to idle on a non-fatal
    // error would either:
    //   (a) let the user press START while a recording is in progress,
    //       losing the in-progress track; or
    //   (b) skip showing the saved card (because we'd jump from
    //       'stopping' straight to 'idle' before the 'saved' event
    //       arrives).
    // If a non-fatal error occurs during finalize, the 'saved' event
    // still arrives (with the file path) and the saved card is shown
    // normally — the user sees the error message AND the saved card.
    p.setErrorMsg(ev.message);
    if (ev.fatal) {
      // U18: update ref synchronously.
      p.recordingStateRef.current = 'idle';
      p.setRecordingState('idle');
    }
  };
}
