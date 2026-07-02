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
  type GpsLocationEvent,
  type GpsStateEvent,
  type GpsSavedEvent,
  type GpsFullState,
  type GpsFixType,
} from '../NativeGpsRecorder';
import type { RecordingState } from '../styles';

// Sliding window of the most recent GPS speeds (m/s) seen during the current
// recording. Used to compute a smoothed "current pace" instead of relying on
// the raw instantaneous GPS speed, which jumps around a lot at 1 Hz. The
// window is cleared on stop / save so a fresh recording starts with no
// history.
//
// ~5 seconds at 1 Hz — short enough to be responsive, long enough to smooth
// out single-fix outliers.
const SPEED_WINDOW = 5;

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
  const syncStateFromNative = useCallback(async () => {
    try {
      const state: GpsFullState = await GpsRecorder.getState();
      if (state.isRecording) {
        // U18: update recordingStateRef synchronously alongside the state
        // setter so the 'gnss' / 'location' handlers read the right value.
        setRecordingState((prev) => {
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
        setRecordingState((prev) => {
          const next = prev === 'stopping' ? prev : 'idle';
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
  useEffect(() => {
    const subs = [
      subscribe('location', (ev: GpsLocationEvent) => {
        // Recording-time updates from the service.
        if (typeof ev.distance === 'number') setDistance(ev.distance);
        if (ev.fixType) setFixType(ev.fixType);
        if (ev.accuracy != null) setAccuracy(ev.accuracy);
        // U10: don't update currentSpeed while auto-paused — the service
        // still emits location events (with the paused fix), but the
        // underlying state shouldn't change. Read isAutoPaused from a ref
        // to avoid stale-closure issues.
        if (ev.speed != null && !isAutoPausedRef.current) {
          setCurrentSpeed(ev.speed);
          // Push into the smoothing window. We accept every fix here (even
          // slow / zero ones) so the window correctly reflects "user is
          // standing still" — the smoothed pace helper returns null when
          // the window average is below the standing-still threshold.
          const w = recentSpeedsRef.current;
          w.push(ev.speed);
          if (w.length > SPEED_WINDOW) w.shift();
          // U4: force a re-render so the smoothed pace display updates
          // immediately. The push above mutated the ref's array in-place,
          // which React doesn't see — without this the rendered pace would
          // be stale until the next setState.
          forceRerender();
        }
        setHasFix(ev.fixType !== 'no fix');
        // Phase 1/3/4: live auto-pause / signal-lost / moving-time.
        if (typeof ev.isAutoPaused === 'boolean') setIsAutoPaused(ev.isAutoPaused);
        if (typeof ev.signalLost === 'boolean') setSignalLost(ev.signalLost);
        if (typeof ev.movingMs === 'number') setMovingMs(ev.movingMs);
      }),
      subscribe('duration', (ev) => {
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
        if (typeof ev.seq === 'number' && ev.seq <= lastDurationSeqRef.current) {
          return;
        }
        if (typeof ev.seq === 'number') {
          lastDurationSeqRef.current = ev.seq;
        }
        setElapsedMs(ev.elapsedMs);
        // L8 fix: prefer the duration event's movingMs over the (stale)
        // location event's movingMs. The duration tick fires every second,
        // so the displayed avg pace no longer oscillates between the live
        // duration tick and the much-less-frequent location event.
        if (typeof ev.movingMs === 'number') {
          setMovingMs(ev.movingMs);
        }
      }),
      subscribe('state', (ev: GpsStateEvent) => {
        if (ev.isRecording) {
          // U18: update ref synchronously.
          recordingStateRef.current = 'recording';
          setRecordingState('recording');
          setElapsedMs(ev.elapsedMs);
          // Phase 1/3/4: sync live pause / signal / moving-time on state
          // transitions (e.g. when the watchdog fires or auto-pause toggles).
          if (typeof ev.isAutoPaused === 'boolean') setIsAutoPaused(ev.isAutoPaused);
          if (typeof ev.signalLost === 'boolean') setSignalLost(ev.signalLost);
          if (typeof ev.movingMs === 'number') setMovingMs(ev.movingMs);
        } else {
          // U18: update ref synchronously.
          recordingStateRef.current = 'idle';
          setRecordingState('idle');
          setElapsedMs(0);
          setDistance(0);
          setCurrentSpeed(null);
          // resetGnss() clears fixType / hasFix / accuracy when recording
          // stops.
          resetGnss();
          // Phase 1/3/4: reset live state when recording stops.
          setIsAutoPaused(false);
          setSignalLost(false);
          setMovingMs(0);
          // Clear the pace-smoothing window so a fresh recording starts
          // with no stale speeds from the previous run.
          recentSpeedsRef.current = [];
        }
      }),
      subscribe('saved', (ev: GpsSavedEvent) => {
        // U16: cancel the 1 s fallback syncStateFromNative() that handleStop
        // scheduled — the 'saved' event has arrived, so we don't need the
        // fallback and don't want it to fire after we've already transitioned
        // to 'idle' (would cause a brief flicker back to 'stopping').
        if (stopTimeoutRef.current != null) {
          clearTimeout(stopTimeoutRef.current);
          stopTimeoutRef.current = null;
        }
        // Snapshot the live timing values BEFORE we reset them, so the
        // saved card can show the post-save average pace over the final
        // distance / moving time. We read from refs because this closure
        // is set up once at mount and would otherwise capture stale values.
        setLastSavedMovingMs(movingMsRef.current);
        setLastSavedElapsedMs(elapsedMsRef.current);
        // U3: snapshot the toggle state at save time so the saved card's
        // pace computation is stable — the user can flip auto-pause / gap
        // detection / show-moving-time AFTER the save (in preparation for
        // the next run) and the just-saved card must not recompute its
        // pace under the new toggle state.
        setLastSavedSettings({
          autoPauseEnabled: autoPauseEnabledRef.current,
          gapDetectionEnabled: gapDetectionEnabledRef.current,
          showMovingTime: showMovingTimeRef.current,
        });
        setLastSavedPath(ev.filePath);
        // The native side sends the post-save distance (recomputed from the
        // saved GPX file, post-smoothing) so the UI shows the true track
        // length. Negative means "not available" — keep the live distance.
        const fd = ev.finalDistanceM;
        setLastSavedDistance(typeof fd === 'number' && fd >= 0 ? fd : null);
        setElapsedMs(0);
        setDistance(0);
        setCurrentSpeed(null);
        setFixType('no fix');
        setHasFix(false);
        // U18: update ref synchronously.
        recordingStateRef.current = 'idle';
        setRecordingState('idle');
        // Phase 1/3/4: clear live pause / signal / moving-time after save.
        setIsAutoPaused(false);
        setSignalLost(false);
        setMovingMs(0);
        // Clear the pace-smoothing window for the next recording.
        recentSpeedsRef.current = [];
      }),
      subscribe('error', (ev) => {
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
        setErrorMsg(ev.message);
        if (ev.fatal) {
          // U18: update ref synchronously.
          recordingStateRef.current = 'idle';
          setRecordingState('idle');
        }
      }),
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
  // Needs: setWaitingForPermissions, cancelPermissionWaitRef,
  // hasAskedBatteryOptRef, setBatteryOptDenied, setErrorMsg, startMonitor,
  // setHasPermissions, setRecordingState, recordingStateRef,
  // syncStateFromNative. Calls GpsRecorder.start().
  const handleStart = useCallback(async () => {
    setErrorMsg(null);
    try {
      let granted = await GpsRecorder.hasPermissions();
      if (!granted) {
        // U1: show a spinner overlay with a Cancel button while the system
        // permission dialog is on screen. requestPermissions() resolves
        // only after the user taps Allow or Deny (L9 fix), so we just await
        // it — no 30-second polling loop, no JS thread blocking. The cancel
        // button lets the user bail out without waiting for the dialog.
        cancelPermissionWaitRef.current = false;
        setWaitingForPermissions(true);
        try {
          granted = await GpsRecorder.requestPermissions();
        } finally {
          setWaitingForPermissions(false);
        }
        // If the user pressed "Отмена" while the dialog was up, bail out
        // without proceeding to startRecording — return to idle silently.
        if (cancelPermissionWaitRef.current) {
          return;
        }
        setHasPermissions(granted);
        if (granted) {
          try { await startMonitor(); } catch { /* ignore */ }
        }
      }

      if (!granted) {
        setErrorMsg(
          'Location and notification permissions are required. Please grant them in Android Settings.'
        );
        return;
      }

      // U12: only show the battery-optimization system dialog ONCE per app
      // session. If the user denied it, a warning banner is shown above
      // the START button (rendered in App.tsx) with a tap action that re-
      // opens the dialog manually.
      if (!hasAskedBatteryOptRef.current) {
        hasAskedBatteryOptRef.current = true;
        try {
          const batteryGranted = await GpsRecorder.requestIgnoreBatteryOptimizations();
          setBatteryOptDenied(!batteryGranted);
        } catch {
          setBatteryOptDenied(true);
        }
      }

      setElapsedMs(0);
      setDistance(0);
      setCurrentSpeed(null);
      setLastSavedPath(null);
      // U3: clear the save-time settings snapshot so the next recording's
      // saved card gets a fresh snapshot (not the previous run's toggles).
      setLastSavedSettings(null);
      // Clear the pace-smoothing window for the fresh recording.
      recentSpeedsRef.current = [];

      await GpsRecorder.start();
      // U18: update recordingStateRef SYNCHRONOUSLY before setRecordingState
      // so the 'gnss' event handler (which reads the ref) sees 'recording'
      // immediately. Otherwise the ref would lag behind state by one render
      // and a 'gnss' event arriving in that window could override
      // currentSpeed despite us just having started recording.
      recordingStateRef.current = 'recording';
      setRecordingState('recording');
      syncStateFromNative();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      recordingStateRef.current = 'idle';
      setRecordingState('idle');
    }
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
  ]);

  // ---- handleStop ----
  // Calls GpsRecorder.stop() and schedules a 1 s fallback
  // syncStateFromNative() (U16). The 'saved' event cancels the fallback.
  const handleStop = useCallback(async () => {
    setErrorMsg(null);
    // U18: update recordingStateRef SYNCHRONOUSLY before setRecordingState.
    recordingStateRef.current = 'stopping';
    setRecordingState('stopping');
    try {
      await GpsRecorder.stop();
      // U16: track the timeout so the 'saved' event handler can cancel it.
      // Without this, a delayed syncStateFromNative() can fire AFTER the
      // 'saved' event has already transitioned the UI to 'idle' + shown
      // the saved card — causing a brief flicker back to 'stopping'.
      stopTimeoutRef.current = setTimeout(() => {
        stopTimeoutRef.current = null;
        syncStateFromNative();
      }, 1000) as unknown as number;
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      // Revert to 'recording' so the user can try STOP again.
      recordingStateRef.current = 'recording';
      setRecordingState('recording');
    }
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
