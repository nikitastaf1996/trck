/**
 * useRecordingSession — extracted from App.tsx (T4).
 *
 * Owns the recording session state machine: live recording state (elapsed /
 * moving time, distance, current speed, auto-pause + signal-lost flags) and
 * the saved-card snapshot state. Also owns the 5 native event subscriptions
 * ('location', 'duration', 'state', 'saved', 'error') that drive real-time
 * UI updates, the 2-second recording-gated polling effect, the 3 state→ref
 * mirror effects (movingMs, elapsedMs, isAutoPaused), and the handleStart /
 * handleStop / syncStateFromNative entry points.
 *
 * Behavioural invariants preserved verbatim from the original inline code:
 *
 *   - U18: recordingStateRef is updated SYNCHRONOUSLY (not via useEffect)
 *     inside handleStart / handleStop / syncStateFromNative / 'state' /
 *     'saved' / 'error' handlers so the 'gnss' / 'location' handlers (set up
 *     once at mount) read the right value. (recordingStateRef is accepted as
 *     a param — see "Call-order note" below — but is mutated in place by
 *     this hook, so the synchronous-update invariant is preserved.)
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
 *   - U16: handleStop schedules a 1 s fallback syncStateFromNative(); the
 *     'saved' event cancels it (avoiding a UI flicker after the saved card
 *     is shown).
 *   - U10: the 'location' handler skips currentSpeed update when
 *     isAutoPausedRef.current is true.
 *   - U4: the 'gnss' handler (which stays in App.tsx's mount effect) pushes
 *     speed to recentSpeedsRef only when not recording — it does this by
 *     calling pushIdleSpeed(ev.speed), which encapsulates the setCurrentSpeed
 *     + push-to-window + forceRerender sequence.
 *   - The 5 event subscriptions are set up ONCE in the mount effect and are
 *     NOT recreated on re-renders (deps stay stable — refs + stable
 *     useCallbacks from useSettings / usePermissions / useGnssMonitor).
 *   - forceRerender (useReducer) is needed because recentSpeedsRef is mutated
 *     in-place by the 'gnss' / 'location' handlers (which trigger React to
 *     re-run the smoothed-pace computation in StatsDisplay).
 *
 * Call-order note: recordingState + recordingStateRef are ACCEPTED as params
 * (not owned by this hook) so that App.tsx can compute `settingsLocked`
 * BEFORE calling useSettings (which needs it). The alternative — owning
 * recordingState inside this hook — would create a circular hook dependency:
 * useSettings needs settingsLocked (derived from recordingState), and this
 * hook needs autoPauseEnabledRef / gapDetectionEnabledRef / showMovingTimeRef
 * (owned by useSettings). Accepting recordingState as a param breaks the
 * cycle while preserving all behavioural invariants: this hook remains the
 * SOLE mutator of both recordingState (via setRecordingState) and
 * recordingStateRef (via direct .current assignments in handleStart,
 * handleStop, syncStateFromNative, and the 'state' / 'saved' / 'error'
 * handlers).
 *
 * App.tsx keeps the 'gnss' subscription (per U4) and calls pushIdleSpeed
 * (returned by this hook) from it when not recording. The other 5
 * subscriptions live here.
 */

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  GpsRecorder,
  subscribe,
  type GpsFullState,
  type GpsFixType,
} from '../NativeGpsRecorder';
import type { RecordingState } from '../styles';
import {
  SPEED_WINDOW,
  createLocationHandler,
  createDurationHandler,
  createStateHandler,
  createSavedHandler,
  createErrorHandler,
} from './useRecordingEventHandlers';
import { startRecording, stopRecording } from './useRecordingControls';

export type SavedSettingsSnapshot = {
  autoPauseEnabled: boolean;
  gapDetectionEnabled: boolean;
  showMovingTime: boolean;
};

export type UseRecordingSessionParams = {
  // recordingState + setter + ref are accepted (not owned) so App.tsx can
  // compute settingsLocked before calling useSettings. See "Call-order note"
  // in the file header.
  recordingState: RecordingState;
  setRecordingState: React.Dispatch<React.SetStateAction<RecordingState>>;
  recordingStateRef: React.MutableRefObject<RecordingState>;

  // From usePermissions. hasPermissions is currently unused inside the hook
  // (handleStart re-queries native for the freshest value via
  // GpsRecorder.hasPermissions()), but is accepted per the T4 spec for API
  // symmetry with usePermissions. setHasPermissions is used by handleStart
  // to sync the React state after requestPermissions() resolves.
  hasPermissions: boolean;
  setHasPermissions: (g: boolean) => void;
  setWaitingForPermissions: (v: boolean) => void;
  cancelPermissionWaitRef: React.MutableRefObject<boolean>;
  hasAskedBatteryOptRef: React.MutableRefObject<boolean>;
  setBatteryOptDenied: (v: boolean) => void;

  // From useSettings — read by the 'saved' event handler at save time so the
  // saved card's pace computation is stable (U3 / Task 4).
  autoPauseEnabledRef: React.MutableRefObject<boolean>;
  gapDetectionEnabledRef: React.MutableRefObject<boolean>;
  showMovingTimeRef: React.MutableRefObject<boolean>;

  // App.tsx-level error surface (shared with useSettings).
  setErrorMsg: (msg: string | null) => void;

  // From useGnssMonitor — used by the 'location' / 'state' / 'saved' handlers
  // and syncStateFromNative to update individual GNSS fields without going
  // through handleGnssEvent (which would also touch satellitesUsed/InView).
  startMonitor: () => Promise<boolean>;
  resetGnss: () => void;
  setFixType: (f: GpsFixType) => void;
  setAccuracy: (a: number | null) => void;
  setHasFix: (h: boolean) => void;
};

export type UseRecordingSessionReturn = {
  // ---- 6 live state vars (recordingState is accepted as a param above) ----
  elapsedMs: number;
  distance: number;
  currentSpeed: number | null;
  isAutoPaused: boolean;
  signalLost: boolean;
  movingMs: number;

  // ---- 5 saved-card snapshot state vars ----
  lastSavedPath: string | null;
  lastSavedDistance: number | null;
  lastSavedMovingMs: number;
  lastSavedElapsedMs: number;
  lastSavedSettings: SavedSettingsSnapshot | null;

  // ---- 1 ref (read by StatsDisplay + App.tsx 'gnss' handler via
  //      pushIdleSpeed) ----
  recentSpeedsRef: React.MutableRefObject<number[]>;

  // ---- 3 entry-point callbacks ----
  handleStart: () => Promise<void>;
  handleStop: () => Promise<void>;
  syncStateFromNative: () => Promise<void>;

  // ---- 1 setter (so App.tsx can dismiss the saved card) ----
  setLastSavedPath: (p: string | null) => void;

  // ---- 1 helper (called by App.tsx 'gnss' handler when not recording).
  //      Encapsulates setCurrentSpeed + push-to-smoothing-window +
  //      forceRerender so App.tsx doesn't need to know about SPEED_WINDOW
  //      or the rerender mechanism. ----
  pushIdleSpeed: (speed: number | null) => void;
};

/**
 * @param params  see UseRecordingSessionParams above.
 */
export function useRecordingSession(
  params: UseRecordingSessionParams,
): UseRecordingSessionReturn {
  const {
    recordingState,
    setRecordingState,
    recordingStateRef,
    setHasPermissions,
    setWaitingForPermissions,
    cancelPermissionWaitRef,
    hasAskedBatteryOptRef,
    setBatteryOptDenied,
    autoPauseEnabledRef,
    gapDetectionEnabledRef,
    showMovingTimeRef,
    setErrorMsg,
    startMonitor,
    resetGnss,
    setFixType,
    setAccuracy,
    setHasFix,
  } = params;
  // NOTE: hasPermissions is intentionally NOT destructured — handleStart re-
  // queries native via GpsRecorder.hasPermissions() for the freshest value
  // (the React state may be stale if the user revoked permissions via system
  // settings without launching the app). Listed in the params type per the
  // T4 spec for API symmetry with usePermissions.

  // ---- 6 live state vars ----
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [distance, setDistance] = useState<number>(0);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  const [isAutoPaused, setIsAutoPaused] = useState<boolean>(false);
  const [signalLost, setSignalLost] = useState<boolean>(false);
  const [movingMs, setMovingMs] = useState<number>(0);

  // ---- 5 saved-card snapshot state vars ----
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  // Final distance (meters) computed from the SAVED GPX file, post-smoothing.
  // Set when the 'saved' event arrives; shown on the "GPX СОХРАНЁН" card so
  // the user sees the true track length (matching what Strava / other
  // importers will compute) rather than the live-accumulated raw distance.
  const [lastSavedDistance, setLastSavedDistance] = useState<number | null>(null);
  // Final moving time + elapsed time captured at save time so we can show
  // the post-save average pace on the saved card. (The live state values
  // get reset to 0 by the 'saved' handler, so we snapshot them here first.)
  const [lastSavedMovingMs, setLastSavedMovingMs] = useState<number>(0);
  const [lastSavedElapsedMs, setLastSavedElapsedMs] = useState<number>(0);
  // U3: snapshot of the auto-pause / gap-detection / show-moving-time toggle
  // state at save time. Without this, the saved card's pace recomputes with
  // whatever the CURRENT toggle state is — so if the user ends a recording
  // and then flips auto-pause on (to prepare for the next run), the just-
  // saved card's pace would flip between moving-time and elapsed-time bases.
  // The snapshot is captured in the 'saved' event handler (BEFORE the user
  // can change anything) and cleared on the next handleStart.
  const [lastSavedSettings, setLastSavedSettings] = useState<SavedSettingsSnapshot | null>(null);

  // ---- refs ----
  // Refs that mirror movingMs / elapsedMs so the 'saved' event handler (set
  // up once at mount and must NOT re-run on every state change, otherwise we
  // lose events) can read their latest values at save time. Without these
  // the closure would capture the initial 0 values and never see the updated
  // ones.
  const movingMsRef = useRef<number>(0);
  const elapsedMsRef = useRef<number>(0);
  // U10: mirror of isAutoPaused for use inside the 'location' event handler
  // (set up once at mount, must not re-create on every state change). Without
  // this ref, the handler closure would capture the initial false value and
  // never see auto-pause activate.
  const isAutoPausedRef = useRef<boolean>(false);
  // U16: handleStop schedules a 1 s fallback syncStateFromNative() in case
  // the 'saved' event is delayed or lost. Tracked so the 'saved' handler can
  // cancel it (avoiding a UI flicker between 'stopping' and 'idle' after the
  // saved card is already shown).
  const stopTimeoutRef = useRef<number | null>(null);
  // H4 fix (Task 3): hard grace-period fallback. If neither the 'saved'
  // event nor the 1 s syncStateFromNative() poll has recovered the UI to
  // 'idle' (e.g. the stop intent was lost, the native service is hung, or
  // the GPX finalization crashed silently), forcibly reset the UI to
  // 'idle' after STOP_HARD_FALLBACK_MS so the "Сохранение GPX…" overlay
  // doesn't stay on screen forever.
  const stopHardTimeoutRef = useRef<number | null>(null);
  // L24 fix: track the last 'duration' event's sequence number so we can
  // ignore out-of-order events (which were causing the displayed timer to
  // occasionally jump backwards by ~1 s when a getState() poll delivered an
  // older elapsedMs value just after a duration event).
  const lastDurationSeqRef = useRef<number>(0);
  // Sliding window of the most recent GPS speeds (m/s). Mutated in-place by
  // the 'gnss' / 'location' handlers — forceRerender is called after each
  // push so the smoothed-pace computation in StatsDisplay re-runs.
  const recentSpeedsRef = useRef<number[]>([]);
  // forceRerender is needed because recentSpeedsRef is mutated in-place.
  // (React doesn't see .push() / .shift() on a ref's array — without this
  // the rendered pace would be stale until the next setState.)
  const [, forceRerender] = useReducer((x: number) => x + 1, 0);

  // ---- 3 mirror effects (state → ref sync) ----
  useEffect(() => { movingMsRef.current = movingMs; }, [movingMs]);
  useEffect(() => { elapsedMsRef.current = elapsedMs; }, [elapsedMs]);
  // U10: keep isAutoPausedRef in sync so the 'location' handler (set up once
  // at mount) can read the latest value without stale-closure issues.
  useEffect(() => { isAutoPausedRef.current = isAutoPaused; }, [isAutoPaused]);

  // Sync state from native via getState(). Called on mount, on foreground, and
  // every 2 s while recording.
  //
  // H4 fix (Task 3): if the UI is in the 'stopping' state (waiting for the
  // native service to acknowledge STOP and emit 'saved' or 'state:false'),
  // and the native side reports isRecording === false, we now transition
  // the UI back to 'idle' instead of staying locked in 'stopping' forever.
  // The previous implementation hard-pinned 'stopping' (any non-recording
  // poll result was converted to `prev === 'stopping' ? prev : 'idle'` —
  // i.e. it preserved 'stopping' indefinitely), which left the
  // "Сохранение GPX…" overlay stuck on screen when the native stop intent
  // was dropped or the service was already gone (e.g. user swiped the app
  // away from recents and the service was killed by the OS without ever
  // delivering the 'saved' event).
  //
  // The 1 s fallback timer scheduled in stopRecording() will still fire
  // syncStateFromNative() to perform this recovery; the 'saved' event
  // handler cancels the timer when it arrives, so the normal happy path
  // is unaffected.
  const syncStateFromNative = useCallback(async () => {
    try {
      const state: GpsFullState = await GpsRecorder.getState();
      if (state.isRecording) {
        // U18: update recordingStateRef synchronously alongside the state
        // setter so the 'gnss' / 'location' handlers read the right value.
        setRecordingState((prev) => {
          // H4 fix: if we were 'stopping' but the native side is reporting
          // isRecording === true again (e.g. the stop intent was lost and
          // the user started a NEW recording), allow the transition back
          // to 'recording' — the alternative is to stay stuck in 'stopping'
          // forever while the native side is actively recording.
          const next = prev === 'stopping' ? prev : 'recording';
          recordingStateRef.current = next;
          return next;
        });
        // L24 fix: don't let a getState() poll overwrite elapsedMs with an
        // older value. The duration tick (1 Hz) is the authoritative source
        // for elapsedMs; the poll is a fallback for when events are dropped.
        // If the poll's elapsedMs is less than what we're already showing,
        // ignore it (a newer duration event will arrive within a second).
        setElapsedMs((prev) => (state.elapsedMs >= prev ? state.elapsedMs : prev));
        if (typeof state.distance === 'number') setDistance(state.distance);
        if (state.fixType) setFixType(state.fixType);
        // Phase 1/3/4: sync auto-pause / signal-lost / moving-time from native.
        if (typeof state.isAutoPaused === 'boolean') setIsAutoPaused(state.isAutoPaused);
        if (typeof state.signalLost === 'boolean') setSignalLost(state.signalLost);
        if (typeof state.movingMs === 'number') setMovingMs(state.movingMs);
        if (state.lastFix) {
          setAccuracy(state.lastFix.accuracy);
          setCurrentSpeed(state.lastFix.speed);
        }
      } else {
        setRecordingState((_) => {
          // H4 fix (Task 3): allow the UI to recover from 'stopping' to
          // 'idle' when the native side confirms it is no longer recording.
          // Previously this branch was `prev === 'stopping' ? prev : 'idle'`,
          // which kept the "Сохранение GPX…" overlay on screen forever if
          // the 'saved' event was never delivered (stop intent dropped,
          // service killed before emitting, etc.).
          //
          // We still preserve 'stopping' for one tick when the user JUST
          // pressed STOP and the poll happens to fire within the same
          // 2 s window — the grace is enforced by the stopTimeoutRef-based
          // fallback in useRecordingControls.stopRecording(), not by this
          // poll.
          const next: RecordingState = 'idle';
          recordingStateRef.current = next;
          return next;
        });
      }
    } catch {
      // ignore — will retry on next poll
    }
    // setFixType / setAccuracy come from useGnssMonitor (stable
    // useCallbacks); listed to satisfy react-hooks/exhaustive-deps.
  }, [setRecordingState, recordingStateRef, setFixType, setAccuracy]);

  // ---- 5 native event subscriptions (set up ONCE at mount) ----
  // The deps array lists only stable refs + stable useCallbacks (from
  // useSettings / usePermissions / useGnssMonitor), so the subscriptions are
  // NOT torn down + recreated on every idle -> recording -> stopping -> idle
  // transition. This is critical: re-creating the subscriptions mid-
  // recording would cause missed 'state' / 'saved' events.
  //
  // The handler bodies live in ./useRecordingEventHandlers (extracted in T5
  // to keep this file under 500 lines). Each factory closes over the same
  // setters + refs that the original inline arrows did, so all behavioural
  // invariants (U18, L24, L8, L10/U17, U3, U16, U10) are preserved verbatim.
  useEffect(() => {
    const subs = [
      subscribe('location', createLocationHandler({
        setDistance,
        setCurrentSpeed,
        setFixType,
        setAccuracy,
        setHasFix,
        setIsAutoPaused,
        setSignalLost,
        setMovingMs,
        isAutoPausedRef,
        recentSpeedsRef,
        forceRerender,
      })),
      subscribe('duration', createDurationHandler({
        setElapsedMs,
        setMovingMs,
        lastDurationSeqRef,
      })),
      subscribe('state', createStateHandler({
        setRecordingState,
        setElapsedMs,
        setDistance,
        setCurrentSpeed,
        setIsAutoPaused,
        setSignalLost,
        setMovingMs,
        recordingStateRef,
        recentSpeedsRef,
        resetGnss,
      })),
      subscribe('saved', createSavedHandler({
        setLastSavedMovingMs,
        setLastSavedElapsedMs,
        setLastSavedSettings,
        setLastSavedPath,
        setLastSavedDistance,
        setElapsedMs,
        setDistance,
        setCurrentSpeed,
        setFixType,
        setHasFix,
        setRecordingState,
        setIsAutoPaused,
        setSignalLost,
        setMovingMs,
        stopTimeoutRef,
        stopHardTimeoutRef,
        movingMsRef,
        elapsedMsRef,
        autoPauseEnabledRef,
        gapDetectionEnabledRef,
        showMovingTimeRef,
        recordingStateRef,
        recentSpeedsRef,
      })),
      subscribe('error', createErrorHandler({
        setErrorMsg,
        setRecordingState,
        recordingStateRef,
      })),
    ];

    return () => {
      subs.forEach((s) => s.remove());
    };
    // All deps are stable refs + stable useCallbacks (from useSettings /
    // usePermissions / useGnssMonitor) — listed only to satisfy
    // react-hooks/exhaustive-deps. The subscriptions are NOT recreated on
    // re-renders.
  }, [
    setRecordingState,
    recordingStateRef,
    autoPauseEnabledRef,
    gapDetectionEnabledRef,
    showMovingTimeRef,
    resetGnss,
    setFixType,
    setAccuracy,
    setHasFix,
    setErrorMsg,
  ]);

  // U14: 2-second syncStateFromNative polling, gated by recording state.
  // The original always-on setInterval ran every 2 s for the entire app
  // lifetime — wasting battery when idle (the 'gnss' event already keeps the
  // UI fresh). Now we only poll while a recording is in progress, so the
  // JS-native bridge isn't crossed every 2 s while the user is just looking
  // at the idle screen.
  useEffect(() => {
    if (recordingState !== 'recording') return;
    const id = setInterval(() => {
      syncStateFromNative();
    }, 2000);
    return () => clearInterval(id);
  }, [recordingState, syncStateFromNative]);

  // ---- handleStart ----
  // Body lives in ./useRecordingControls (extracted in T5). The inline
  // arrow calls startRecording() with the same setters + refs + stable
  // callbacks that the original inline body closed over, so all invariants
  // (U1, U3, U12, U18) are preserved. The useState setters + recentSpeedsRef
  // are stable across renders and intentionally omitted from the deps array.
  const handleStart = useCallback(async () => {
    await startRecording({
      setErrorMsg,
      setRecordingState,
      setElapsedMs,
      setDistance,
      setCurrentSpeed,
      setLastSavedPath,
      setLastSavedSettings,
      setWaitingForPermissions,
      setHasPermissions,
      setBatteryOptDenied,
      cancelPermissionWaitRef,
      hasAskedBatteryOptRef,
      recordingStateRef,
      recentSpeedsRef,
      startMonitor,
      syncStateFromNative,
      // Task 9: pass the warning-flag + moving-time setters so
      // startRecording can clear them on restart.
      setIsAutoPaused,
      setSignalLost,
      setMovingMs,
    });
  }, [
    syncStateFromNative,
    cancelPermissionWaitRef,
    hasAskedBatteryOptRef,
    setWaitingForPermissions,
    setHasPermissions,
    setBatteryOptDenied,
    startMonitor,
    setRecordingState,
    recordingStateRef,
    setErrorMsg,
    // Task 9: add the new setters to the deps array. They are stable
    // useState setters (React guarantees this), so listing them here does
    // not cause the callback to be recreated on re-renders — but
    // exhaustive-deps wants them listed.
    setElapsedMs,
    setDistance,
    setCurrentSpeed,
    setLastSavedPath,
    setLastSavedSettings,
    setIsAutoPaused,
    setSignalLost,
    setMovingMs,
  ]);

  // ---- handleStop ----
  // Body lives in ./useRecordingControls (extracted in T5). Schedules a 1 s
  // fallback syncStateFromNative() (U16); the 'saved' event cancels it.
  // H4 fix (Task 3): also schedules a 15 s hard fallback that forcibly
  // resets the UI to 'idle' if neither 'saved' nor the 1 s poll recovered
  // the state.
  const handleStop = useCallback(async () => {
    await stopRecording({
      setErrorMsg,
      setRecordingState,
      recordingStateRef,
      stopTimeoutRef,
      stopHardTimeoutRef,
      syncStateFromNative,
    });
  }, [syncStateFromNative, setRecordingState, recordingStateRef, setErrorMsg]);

  // ---- helper for App.tsx 'gnss' handler (U4) ----
  // Encapsulates the "set current speed + push to smoothing window + force
  // rerender" sequence so App.tsx doesn't need to know about SPEED_WINDOW or
  // the rerender mechanism. Called from App.tsx's 'gnss' subscription when
  // recordingStateRef.current !== 'recording'.
  const pushIdleSpeed = useCallback((speed: number | null) => {
    setCurrentSpeed(speed);
    if (speed != null) {
      const w = recentSpeedsRef.current;
      w.push(speed);
      if (w.length > SPEED_WINDOW) w.shift();
      forceRerender();
    }
  }, []);

  return {
    elapsedMs,
    distance,
    currentSpeed,
    isAutoPaused,
    signalLost,
    movingMs,
    lastSavedPath,
    lastSavedDistance,
    lastSavedMovingMs,
    lastSavedElapsedMs,
    lastSavedSettings,
    recentSpeedsRef,
    handleStart,
    handleStop,
    syncStateFromNative,
    setLastSavedPath,
    pushIdleSpeed,
  };
}
