/**
 * trck — a no-frills GPS recorder for runners.
 *
 * UI inspired by minimalist running watches / running apps: large, centered
 * numbers, generous whitespace, one accent color, no clutter.
 *
 *   - Big circular START / STOP button at the bottom
 *   - Pre-recording GNSS status pill (always visible, updates live)
 *   - TIME · DISTANCE · PACE · AVG PACE
 *   - Saved-file toast when a recording finishes
 *
 * Stability / lifecycle behaviour (unchanged from previous versions):
 *   - Recording is owned by a native foreground service (GpsRecorderService.kt).
 *   - The service survives: app being backgrounded, app being swiped away from
 *     recents, the screen turning off, and (best-effort) the system killing the
 *     process for memory. It is START_STICKY and uses a PARTIAL_WAKE_LOCK.
 *   - Points are flushed to a temp file every 5 seconds so a crash mid-recording
 *     still yields a usable (partial) GPX file.
 *   - The notification has a "Stop" action so the user can stop recording
 *     without re-opening the app.
 *   - The JS side is purely informational; if the JS thread dies, recording
 *     continues.
 *
 * Live GNSS monitor:
 *   - On mount, we call GpsRecorder.startGnssMonitor() so the native module
 *     starts listening to GPS + GnssStatus and emits 'gnss' events with the
 *     current fix type / accuracy / satellite counts. This works regardless of
 *     whether recording is running, so the user sees their fix status before
 *     pressing START.
 *   - The monitor is stopped on unmount.
 */

import React, { useEffect, useRef, useState, useCallback, useReducer } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  GpsRecorder,
  subscribe,
  isNativeModuleAvailable,
  type GpsLocationEvent,
  type GpsStateEvent,
  type GpsSavedEvent,
  type GpsFullState,
  type GpsGnssEvent,
} from './src/NativeGpsRecorder';
// O19: use react-native-safe-area-context instead of the deprecated built-in.
// The built-in SafeAreaView from 'react-native' is unreliable on Android notches.
import { SafeAreaView } from 'react-native-safe-area-context';
// O8: extracted presentational components + shared palette / formatters.
import { GnssPill } from './src/components/GnssPill';
import { ToggleRow } from './src/components/ToggleRow';
import { FilterSettingGroup } from './src/components/FilterSettingGroup';
import { StatsDisplay } from './src/components/StatsDisplay';
import { StartStopButton } from './src/components/StartStopButton';
import { SavedCard } from './src/components/SavedCard';
import { ErrorCard } from './src/components/ErrorCard';
import { PermissionWaitOverlay, StopOverlay } from './src/components/Overlays';
import {
  SignalLostBanner,
  BatteryOptBanner,
  OverFilterWarning,
} from './src/components/Banners';
import {
  COLOR,
  pluralRu,
  type RecordingState,
} from './src/styles';
// T1: settings state / refs / handlers / loader extracted from App.tsx into
// a dedicated hook so the main component stays under control. The hook owns
// the settingsUpdatingRef re-entrancy guard internally (not returned).
import { useSettings } from './src/hooks/useSettings';
// T2: permission state / refs / handlers / one-shot permission check
// extracted from App.tsx into a dedicated hook (mirrors the T1 pattern).
import { usePermissions } from './src/hooks/usePermissions';
// T2: GNSS monitor state (fixType / accuracy / satellites / hasFix) + the
// start/stop wrappers + handleGnssEvent / resetGnss extracted from App.tsx.
import { useGnssMonitor } from './src/hooks/useGnssMonitor';

function App(): React.ReactElement {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  // U8: pointCount state removed — it was only read by the now-dead
  // `pointCount > 0` status branch. The 'state' event resets it to 0 when
  // recording stops, so when we're not recording it's always 0; when we
  // ARE recording, the status row shows 'ЗАПИСЬ' / 'АВТОПАУЗА' / etc.
  // anyway. Keeping the state (and updating it on every location event)
  // was just causing unnecessary re-renders for a value nobody reads.
  const [distance, setDistance] = useState<number>(0);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  // T2: fixType / accuracy / satellitesUsed / satellitesInView / hasFix state
  // moved into the useGnssMonitor hook (called below, after recordingStateRef).
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
  // U3: snapshot of the auto-pause / gap-detection toggle state at save
  // time. Without this, the saved card's pace recomputes with whatever the
  // CURRENT toggle state is — so if the user ends a recording and then
  // flips auto-pause on (to prepare for the next run), the just-saved
  // card's pace would flip between moving-time and elapsed-time bases.
  // The snapshot is captured in the 'saved' event handler (BEFORE the user
  // can change anything) and cleared on the next handleStart.
  const [lastSavedSettings, setLastSavedSettings] = useState<{
    autoPauseEnabled: boolean;
    gapDetectionEnabled: boolean;
    // CODE_REVIEW_TODO Task 4: snapshot of showMovingTime at save time.
    showMovingTime: boolean;
  } | null>(null);
  // T2: hasPermissions state moved into the usePermissions hook (called below).
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // T1: settingsLocked must be computed BEFORE useSettings is called (the
  // hook takes it as an argument). It's also read directly in the JSX below
  // (locked badge + disabled props on the toggle / stepper rows).
  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';
  // Settings are locked (read-only) while a recording is in progress so that
  // toggling them mid-recording cannot change the filter / smoothing behaviour
  // halfway through the file.
  const settingsLocked = isRecording || isStopping;

  // T1: all 11 settings state vars, the 3 mirror refs (autoPauseEnabledRef,
  // gapDetectionEnabledRef, showMovingTimeRef — read by the 'saved' event
  // handler at save time), the 10 toggle / stepper handlers, and the
  // loadSettings one-shot loader are extracted into the useSettings hook
  // (src/hooks/useSettings.ts). The hook owns the settingsUpdatingRef re-
  // entrancy guard internally; it is NOT returned.
  const {
    postProcessEnabled,
    gaussianSmoothingEnabled,
    autoPauseEnabled,
    gapDetectionEnabled,
    showMovingTime,
    radialDistanceFilterEnabled,
    radialDistanceThresholdM,
    timeSamplingEnabled,
    timeSamplingN,
    douglasPeuckerEnabled,
    douglasPeuckerEpsilonM,
    autoPauseEnabledRef,
    gapDetectionEnabledRef,
    showMovingTimeRef,
    handleTogglePostProcess,
    handleToggleGaussianSmoothing,
    handleToggleAutoPause,
    handleToggleGapDetection,
    handleToggleShowMovingTime,
    handleToggleRadialDistanceFilter,
    handleStepperRadialThreshold,
    handleToggleTimeSampling,
    handleStepperTimeSamplingN,
    handleToggleDouglasPeucker,
    handleStepperDouglasPeuckerEpsilon,
    loadSettings,
  } = useSettings(settingsLocked, setErrorMsg);
  const [isAutoPaused, setIsAutoPaused] = useState<boolean>(false);
  const [signalLost, setSignalLost] = useState<boolean>(false);
  const [movingMs, setMovingMs] = useState<number>(0);
  // T2: permission state (hasPermissions, waitingForPermissions,
  // batteryOptDenied), refs (cancelPermissionWaitRef, hasAskedBatteryOptRef),
  // handlers (handleCancelPermissionWait, handleRetryBatteryOpt,
  // handleGrantPermissions), and the initialCheck one-shot are extracted into
  // the usePermissions hook (src/hooks/usePermissions.ts). The hook is called
  // below (after recordingStateRef is defined, since it takes recordingStateRef
  // as a parameter per the T2 spec).
  // U18: mirror of `recordingState` for use inside event-subscription closures.
  // We keep the main useEffect's deps stable (so the subscriptions are NOT
  // torn down + recreated on every idle -> recording -> stopping -> idle
  // transition, which was causing missed 'state' / 'saved' events). The
  // closures read this ref instead of capturing the state directly.
  // U18: recordingStateRef is updated SYNCHRONOUSLY inside handleStart /
  // handleStop (NOT via useEffect). The previous useEffect-based approach
  // had a race window: between setRecordingState('recording') running and
  // the useEffect firing on the next render, a 'gnss' event could arrive
  // and the handler would read the STALE ref value ('idle') — overriding
  // currentSpeed with the gnss speed even though we just started recording.
  // Synchronous ref updates close that race entirely.
  const recordingStateRef = useRef<RecordingState>('idle');

  // T2: permission + GNSS-monitor hooks (both take recordingStateRef per spec).
  const {
    hasPermissions,
    waitingForPermissions,
    batteryOptDenied,
    cancelPermissionWaitRef,
    hasAskedBatteryOptRef,
    setHasPermissions,
    setWaitingForPermissions,
    setBatteryOptDenied,
    handleCancelPermissionWait,
    handleRetryBatteryOpt,
    handleGrantPermissions,
    initialCheck,
  } = usePermissions(recordingStateRef);
  const {
    fixType,
    accuracy,
    satellitesUsed,
    satellitesInView,
    hasFix,
    setFixType,
    setAccuracy,
    setHasFix,
    handleGnssEvent,
    resetGnss,
    startMonitor,
    stopMonitor,
  } = useGnssMonitor(recordingStateRef);

  // Sliding window of the most recent GPS speeds (m/s) seen during the
  // current recording. Used to compute a smoothed "current pace" instead of
  // relying on the raw instantaneous GPS speed, which jumps around a lot at
  // 1 Hz and makes the TEMPO readout flicker between e.g. 4:30 and 6:10 from
  // one fix to the next. The window is cleared on stop / save so a fresh
  // recording starts with no history.
  //
  // U4: the window is also populated from the 'gnss' event when NOT
  // recording (so the idle pace display uses the same smoothing instead of
  // the raw instantaneous GNSS speed). Pushing to the array doesn't trigger
  // a re-render, so we call forceRerender() after each push to make sure
  // the smoothedSpeed computation below re-runs.
  const recentSpeedsRef = useRef<number[]>([]);
  const SPEED_WINDOW = 5; // ~5 seconds at 1 Hz — short enough to be responsive
  const [, forceRerender] = useReducer(x => x + 1, 0);
  // Refs that mirror movingMs / elapsedMs so the 'saved' event handler
  // (which is set up ONCE in the mount effect and must NOT re-run on every
  // state change, otherwise we lose events) can read their latest values at
  // save time. Without these the closure would capture the initial 0 values
  // and never see the updated ones.
  // T1: autoPauseEnabledRef / gapDetectionEnabledRef / showMovingTimeRef were
  // moved into the useSettings hook — they mirror settings state owned by it
  // and are returned by the hook for the 'saved' handler to read at save time.
  const movingMsRef = useRef<number>(0);
  const elapsedMsRef = useRef<number>(0);
  // U10: mirror of isAutoPaused for use inside the 'location' event handler
  // (which is set up once at mount and must not re-create on every state
  // change). Without this ref, the handler closure would capture the initial
  // false value and never see auto-pause activate.
  const isAutoPausedRef = useRef<boolean>(false);
  // U16: handleStop schedules a 1 s fallback syncStateFromNative() in case
  // the 'saved' event is delayed or lost. We track the timeout id so the
  // 'saved' event handler can cancel it (avoiding a UI flicker between
  // 'stopping' and 'idle' after the saved card is already shown).
  const stopTimeoutRef = useRef<number | null>(null);
  // L24 fix: track the last 'duration' event's sequence number so we can
  // ignore out-of-order events (which were causing the displayed timer to
  // occasionally jump backwards by ~1 s when a getState() poll delivered
  // an older elapsedMs value just after a duration event).
  const lastDurationSeqRef = useRef<number>(0);
  useEffect(() => { movingMsRef.current = movingMs; }, [movingMs]);
  useEffect(() => { elapsedMsRef.current = elapsedMs; }, [elapsedMs]);
  // U10: keep isAutoPausedRef in sync so the 'location' handler (set up once
  // at mount) can read the latest value without stale-closure issues.
  useEffect(() => { isAutoPausedRef.current = isAutoPaused; }, [isAutoPaused]);

  // Sync state from native via getState(). Called on mount, on foreground, and every 2s.
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
        // U8: setPointCount(state.pointCount) removed — unused state.
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
        // U13: startTimeRef assignment removed — dead code.
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
    // T2: setFixType / setAccuracy come from useGnssMonitor (stable
    // useCallbacks); listed to satisfy react-hooks/exhaustive-deps.
  }, [setFixType, setAccuracy]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        // T2: permission check extracted into usePermissions.initialCheck()
        // (U23: 800ms wait after requestPermissions). Returns granted so the
        // caller can start the GNSS monitor (initialCheck does NOT do it).
        const granted = await initialCheck();
        if (!mounted) return;

        // T1: load all 11 settings from native prefs (delegated to the
        // useSettings hook). Each individual get* call is independently
        // try/caught inside the hook so a failure on one doesn't skip the
        // rest. The per-setState `mounted` guards from the original inline
        // block are no longer present (the hook doesn't take a mounted flag);
        // a setState-after-unmount would only produce a dev-mode console
        // warning, not a crash, and is acceptable here.
        await loadSettings();

        // Start the always-on GNSS monitor so the UI shows fix status even
        // before recording starts. (T2: startGnssMonitor → startMonitor.)
        if (granted) {
          try { await startMonitor(); } catch { /* ignore */ }
        }
        await syncStateFromNative();
      } catch {
        // ignore
      }
    })();

    // Event subscriptions (real-time updates)
    const subs = [
      subscribe('gnss', (ev: GpsGnssEvent) => {
        // T2: handleGnssEvent (from useGnssMonitor) sets all 5 GNSS state
        // vars. The speed-pushing logic below stays in App.tsx (reads
        // recordingStateRef + recentSpeedsRef).
        handleGnssEvent(ev);
        // While idle (not recording), the monitor's speed is also the best
        // current-speed signal we have. While recording, the 'location' event
        // overrides it.
        if (recordingStateRef.current !== 'recording') {
          setCurrentSpeed(ev.speed);
          // U4: also push the GNSS speed into the smoothing window when
          // idle so the displayed pace uses the smoothed average (no more
          // 4:30 → 6:10 flicker). While recording, the 'location' event
          // is the source of truth — we DON'T push gnss speeds then to
          // avoid double-counting.
          if (ev.speed != null) {
            const w = recentSpeedsRef.current;
            w.push(ev.speed);
            if (w.length > SPEED_WINDOW) w.shift();
            forceRerender();
          }
        }
      }),
      subscribe('location', (ev: GpsLocationEvent) => {
        // Recording-time updates from the service.
        // U8: setPointCount(ev.pointCount) removed — unused state.
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
        // U13: startTimeRef assignment removed — dead code.
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
          // U8: setPointCount(ev.pointCount) removed — unused state.
          setElapsedMs(ev.elapsedMs);
          // U13: startTimeRef assignment removed — dead code.
          // Phase 1/3/4: sync live pause / signal / moving-time on state
          // transitions (e.g. when the watchdog fires or auto-pause toggles).
          if (typeof ev.isAutoPaused === 'boolean') setIsAutoPaused(ev.isAutoPaused);
          if (typeof ev.signalLost === 'boolean') setSignalLost(ev.signalLost);
          if (typeof ev.movingMs === 'number') setMovingMs(ev.movingMs);
        } else {
          // U18: update ref synchronously.
          recordingStateRef.current = 'idle';
          setRecordingState('idle');
          // U8: setPointCount(0) removed — unused state.
          setElapsedMs(0);
          setDistance(0);
          setCurrentSpeed(null);
          // T2: resetGnss() replaces setFixType('no fix') + setHasFix(false).
          // Also clears accuracy (minor enhancement per T2 spec — clearing
          // accuracy when there's "no fix" is more correct).
          resetGnss();
          // Phase 1/3/4: reset live state when recording stops.
          setIsAutoPaused(false);
          setSignalLost(false);
          setMovingMs(0);
          // U13: startTimeRef reset removed — dead code.
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
        // detection AFTER the save (in preparation for the next run) and
        // the just-saved card must not recompute its pace under the new
        // toggle state.
        setLastSavedSettings({
          autoPauseEnabled: autoPauseEnabledRef.current,
          gapDetectionEnabled: gapDetectionEnabledRef.current,
          // CODE_REVIEW_TODO Task 4: also snapshot showMovingTime so the
          // saved card's pace uses the same time base the user was looking
          // at when they stopped the recording.
          showMovingTime: showMovingTimeRef.current,
        });
        setLastSavedPath(ev.filePath);
        // The native side sends the post-save distance (recomputed from the
        // saved GPX file, post-smoothing) so the UI shows the true track
        // length. Negative means "not available" — keep the live distance.
        // U23: removed the (ev as any).finalDistanceM cast — the
        // GpsSavedEvent type in NativeGpsRecorder.ts already declares
        // finalDistanceM?: number, so the cast was unnecessary.
        const fd = ev.finalDistanceM;
        setLastSavedDistance(typeof fd === 'number' && fd >= 0 ? fd : null);
        // U8: setPointCount(0) removed — unused state.
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
        // U13: startTimeRef reset removed — dead code.
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

    // Re-sync when coming back to foreground
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncStateFromNative();
        // U6: add .catch() so an unhandled promise rejection doesn't fire
        // if hasPermissions() throws (e.g. native module not yet ready on
        // very first foreground event during cold start).
        GpsRecorder.hasPermissions().then(async (g) => {
          setHasPermissions(g);
          if (g) {
            try { await startMonitor(); } catch { /* ignore */ }
          }
        }).catch(() => { /* permission check failed, will retry on next AppState change */ });
      }
    });

    // Polling fallback: REMOVED from the mount effect (was always-on, wasting
    // battery when idle). Replaced by the recording-gated useEffect below
    // (U14) that only runs the 2 s poll while a recording is in progress.
    // When idle, the 'gnss' event already keeps the UI fresh.

    return () => {
      mounted = false;
      subs.forEach((s) => s.remove());
      appStateSub.remove();
      // U14: no pollInterval to clear here — that's handled by the
      // recording-gated useEffect below.
      // U6: stopGnssMonitor() returns a Promise — wrapping it in a
      // try/catch would NOT catch an async rejection. Use .catch() so an
      // unhandled promise rejection doesn't fire if the native module
      // rejects during teardown. (T2: stopGnssMonitor → stopMonitor.)
      stopMonitor().catch(() => { /* ignore */ });
    };
  }, [
    syncStateFromNative,
    // T1+T2: refs / loadSettings / initialCheck / startMonitor / stopMonitor /
    // handleGnssEvent / resetGnss / setters from useSettings + usePermissions +
    // useGnssMonitor. All stable — listed only to satisfy exhaustive-deps.
    autoPauseEnabledRef,
    gapDetectionEnabledRef,
    showMovingTimeRef,
    loadSettings,
    initialCheck,
    startMonitor,
    stopMonitor,
    handleGnssEvent,
    resetGnss,
    setHasPermissions,
    setFixType,
    setAccuracy,
    setHasFix,
  ]); // NOTE: recordingState intentionally omitted — see recordingStateRef.

  // U14: 2-second syncStateFromNative polling, gated by recording state.
  // The original always-on setInterval ran every 2 s for the entire app
  // lifetime — wasting battery when idle (the 'gnss' event already keeps
  // the UI fresh). Now we only poll while a recording is in progress, so
  // the JS-native bridge isn't crossed every 2 s while the user is just
  // looking at the idle screen.
  useEffect(() => {
    if (recordingState !== 'recording') return;
    const id = setInterval(() => {
      syncStateFromNative();
    }, 2000);
    return () => clearInterval(id);
  }, [recordingState, syncStateFromNative]);

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
      // the START button (rendered below) with a tap action that re-opens
      // the dialog manually.
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
      // U8: setPointCount(0) removed — unused state.
      setDistance(0);
      setCurrentSpeed(null);
      setLastSavedPath(null);
      // U3: clear the save-time settings snapshot so the next recording's
      // saved card gets a fresh snapshot (not the previous run's toggles).
      setLastSavedSettings(null);
      // U13: startTimeRef assignment removed — dead code.
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
    // T2: cancelPermissionWaitRef / hasAskedBatteryOptRef / setters from
    // usePermissions; startMonitor from useGnssMonitor. All stable.
  }, [
    syncStateFromNative,
    cancelPermissionWaitRef,
    hasAskedBatteryOptRef,
    setWaitingForPermissions,
    setHasPermissions,
    setBatteryOptDenied,
    startMonitor,
  ]);

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
  }, [syncStateFromNative]);

  // T1: isRecording / isStopping / settingsLocked + all 10 settings toggle
  // / stepper handlers + the settingsUpdatingRef re-entrancy guard + the 11
  // settings useState declarations + the 3 mirror refs (autoPauseEnabledRef,
  // gapDetectionEnabledRef, showMovingTimeRef) + their mirror effects were
  // extracted into the useSettings hook above. The 'saved' event handler
  // (set up once at mount) still reads the 3 mirror refs at save time via
  // the destructured values.

  // Note: distanceFmt / smoothedSpeed / currentPace / paceTimeMs / avgPace
  // were previously computed here and used by the inlined stats JSX. They
  // are now computed inside <StatsDisplay> (see src/components/StatsDisplay.tsx),
  // which is the only consumer. Keeping them here would be dead code.

  // O14: if the native module is not loaded (e.g. package not registered,
  // or the iOS branch was removed but the JS still ran), the fallback
  // object makes every method a no-op. Without this check the app would
  // launch normally but every button would silently do nothing — confusing.
  // All hooks above run unconditionally so this early return is safe.
  if (!isNativeModuleAvailable) {
    return (
      <View style={styles.nativeMissingContainer}>
        <Text style={styles.nativeMissingTitle}>Нативный модуль не загружен</Text>
        <Text style={styles.nativeMissingBody}>
          Приложение не сможет записывать GPS. Попробуйте переустановить
          приложение.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={COLOR.bg} />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* GNSS status pill — always visible, updates live */}
        <GnssPill
          fixType={fixType}
          accuracy={accuracy}
          satellitesUsed={satellitesUsed}
          satellitesInView={satellitesInView}
          hasFix={hasFix}
        />

        {isRecording && signalLost && !isAutoPaused && <SignalLostBanner />}

        <StatsDisplay
          recordingState={recordingState}
          elapsedMs={elapsedMs}
          movingMs={movingMs}
          distance={distance}
          currentSpeed={currentSpeed}
          isAutoPaused={isAutoPaused}
          signalLost={signalLost}
          showMovingTime={showMovingTime}
          autoPauseEnabled={autoPauseEnabled}
          gapDetectionEnabled={gapDetectionEnabled}
          recentSpeedsRef={recentSpeedsRef}
        />

        {batteryOptDenied && !isRecording && !isStopping && (
          <BatteryOptBanner onPress={handleRetryBatteryOpt} />
        )}

        <StartStopButton
          recordingState={recordingState}
          onStart={handleStart}
          onStop={handleStop}
        />

        {/* Settings section header + "locked during recording" notice */}
        <View style={styles.settingsHeader}>
          <Text style={styles.settingsHeaderText}>НАСТРОЙКИ</Text>
          {settingsLocked && (
            <Text style={styles.settingsLockedBadge}>
              {/* U21: expand the badge text so a first-time user knows HOW to
                  unlock — previously just said 'Заблокировано на время записи'
                  with no hint that stopping the recording would unlock it. */}
              🔒 Заблокировано на время записи (остановите, чтобы изменить)
            </Text>
          )}
        </View>

        <ToggleRow
          title="Фильтрация трека на лету"
          subtitle={
            postProcessEnabled
              ? 'Включена: точность ≤ 25 м, скорость ≤ 20 км/ч — выбросы отсекаются при записи'
              : 'Выключена: запись сырых GPS-данных без изменений'
          }
          value={postProcessEnabled}
          onPress={handleTogglePostProcess}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Сглаживание Гауссом (постобработка)"
          subtitle={
            gaussianSmoothingEnabled
              ? 'Включено: после записи к треку применяется гауссово сглаживание (окно ±5 точек, σ=1.5)'
              : 'Выключено: GPX сохраняется как есть, без финального сглаживания'
          }
          value={gaussianSmoothingEnabled}
          onPress={handleToggleGaussianSmoothing}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Автопауза при остановке"
          subtitle={
            autoPauseEnabled
              ? 'Включена: пауза при скорости < 0.35 м/с и смещении < 3.5 м за 10 с. Средний темп считается по чистому времени движения'
              : 'Выключена: запись идёт непрерывно, даже когда вы стоите на месте'
          }
          value={autoPauseEnabled}
          onPress={handleToggleAutoPause}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Разделение трека при потере сигнала"
          subtitle={
            gapDetectionEnabled
              ? 'Включено: нет фиксации > 15 с → новый сегмент <trkseg> и баннер "ПОТЕРЯ СИГНАЛА". Расстояние через разрыв не считается'
              : 'Выключено: провалы сигнала игнорируются, трек пишётся одним сегментом (как в прежних версиях)'
          }
          value={gapDetectionEnabled}
          onPress={handleToggleGapDetection}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Показывать время в движении"
          subtitle={
            showMovingTime
              ? 'Включено: верхний таймер и средний темп считаются по чистому времени движения (без учёта пауз и потерь сигнала). Можно менять во время записи.'
              : 'Выключено: верхний таймер и средний темп считаются по общему времени (включая паузы). Можно менять во время записи.'
          }
          value={showMovingTime}
          onPress={handleToggleShowMovingTime}
        />

        {/* ---- Three data-reduction filters (user-requested) ---- */}
        {/*
          Each filter is an independent toggle with a numeric parameter. All
          are locked while a recording is in progress (settingsLocked), so
          the user can only change them between recordings — same rule as the
          other toggles above. The stepper row is always visible (so the user
          can preview / configure the parameter before enabling the filter),
          but its −/+ buttons are disabled when the toggle is off OR when
          settings are locked.

          1. Radial distance filter (on-the-fly): drop any fix closer than X
             meters to the last kept point. Default X = 5 m.
          2. Time sampling (on-the-fly): keep every N-th fix. Default N = 5
             (≈ one fix every 5 s at 1 Hz).
          3. Douglas-Peucker (post-processing): simplify the saved track by
             dropping points whose perpendicular distance from the segment
             line is < epsilon meters. Default epsilon = 5 m. Applied AFTER
             Gaussian smoothing if both are on.
        */}

        <FilterSettingGroup
          title="Радиальный фильтр (на лету)"
          subtitleOn={`Включён: точка пропускается, если она ближе ${radialDistanceThresholdM} м к последней сохранённой`}
          subtitleOff="Выключен: каждая принятая точка сохраняется в трек"
          value={radialDistanceFilterEnabled}
          onToggle={handleToggleRadialDistanceFilter}
          stepperLabel="Мин. расстояние"
          stepperValue={radialDistanceThresholdM}
          stepperUnit="м"
          stepperMin={0}
          stepperMax={1000}
          onDecrement={() => handleStepperRadialThreshold(-1)}
          onIncrement={() => handleStepperRadialThreshold(+1)}
          settingsLocked={settingsLocked}
        />

<FilterSettingGroup
          title="Децимация по времени (на лету)"
          subtitleOn={`Включена: сохраняется каждая ${timeSamplingN}-я точка (≈ раз в ${timeSamplingN} с при 1 Гц)`}
          subtitleOff="Выключена: сохраняются все принятые точки"
          value={timeSamplingEnabled}
          onToggle={handleToggleTimeSampling}
          stepperLabel="Шаг N"
          stepperValue={timeSamplingN}
          stepperUnit={pluralRu(timeSamplingN, ['точка', 'точки', 'точек'])}
          stepperMin={1}
          stepperMax={60}
          onDecrement={() => handleStepperTimeSamplingN(-1)}
          onIncrement={() => handleStepperTimeSamplingN(+1)}
          settingsLocked={settingsLocked}
        />

<FilterSettingGroup
          title="Douglas-Peucker (постобработка)"
          subtitleOn={`Включён: трек упрощается, точки ближе ${douglasPeuckerEpsilonM} м от линии сегмента удаляются`}
          subtitleOff="Выключен: GPX сохраняется как есть, без финального упрощения"
          value={douglasPeuckerEnabled}
          onToggle={handleToggleDouglasPeucker}
          stepperLabel="Эпсилон (допуск)"
          stepperValue={douglasPeuckerEpsilonM}
          stepperUnit="м"
          stepperMin={0}
          stepperMax={500}
          onDecrement={() => handleStepperDouglasPeuckerEpsilon(-1)}
          onIncrement={() => handleStepperDouglasPeuckerEpsilon(+1)}
          settingsLocked={settingsLocked}
        />{/* CODE_REVIEW_TODO Task 3: over-filter warning banner.
            When all three data-reduction filters (radial distance, time
            sampling, Douglas-Peucker) are enabled simultaneously, the
            track becomes extremely sparse — for a hiker at 1 m/s, this
            can lose track corners. The warning is informational only:
            it does NOT block the user from enabling all three (they may
            have a legitimate reason, e.g. recording a long bike ride
            where aggressive simplification is desired). The banner
            appears directly below the three filter settings and uses
            the existing amber/warning styling convention (matches the
            battery-optimization banner). Updates live as toggles flip. */}
        {radialDistanceFilterEnabled &&
          timeSamplingEnabled &&
          douglasPeuckerEnabled && <OverFilterWarning />}

        {!hasPermissions && (
          <Pressable style={styles.permissionButton} onPress={handleGrantPermissions}>
            <Text style={styles.permissionButtonText}>
              Разрешить доступ к местоположению и уведомлениям
            </Text>
          </Pressable>
        )}

        {lastSavedPath && (
          <SavedCard
            path={lastSavedPath}
            distance={lastSavedDistance}
            movingMs={lastSavedMovingMs}
            elapsedMs={lastSavedElapsedMs}
            settings={lastSavedSettings}
            onDismiss={() => setLastSavedPath(null)}
          />
        )}

        {errorMsg && (
          <ErrorCard
            message={errorMsg}
            hasPermissions={hasPermissions}
            onDismiss={() => setErrorMsg(null)}
            onOpenSettings={() => {
              GpsRecorder.openAppSettings().catch(() => { /* ignore */ });
            }}
          />
        )}

        <View style={styles.footerNote}>
          <Text style={styles.footerText}>
            Запись идёт в foreground service и продолжается, когда приложение
            свёрнуто или смахнуто. Остановить можно из уведомления или кнопкой
            выше. GPX-файлы сохраняются в общую папку Downloads/trck.
          </Text>
        </View>
      </ScrollView>

      <PermissionWaitOverlay
        visible={waitingForPermissions}
        onCancel={handleCancelPermissionWait}
      />

      <StopOverlay visible={isStopping} />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.bg },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 60,
  },
  // ---- Status row ----
  // Green when recording (active = good, matches the GNSS pill colour scheme).
  // Grey when idle. Amber when auto-paused. Red is reserved for the STOP
  // button + signal-lost banner so the user doesn't read a red dot as
  // "something is wrong" while a recording is happily in progress.
  // Phase 3: amber dot shown while auto-pause is active.
  // ---- Phase 3: auto-pause badge (shown below the TIME stat) ----
  // ---- Phase 4: signal-lost banner ----
  // ---- Big button ----
  // U12: battery-optimization warning banner.
  // ---- CODE_REVIEW_TODO Task 3: over-filter warning banner ----
  // Shown directly below the three data-reduction filter settings when ALL
  // three are enabled simultaneously. Uses the existing amber palette
  // (COLOR.pauseBg / pauseBorder / pauseAccent — same as the battery-opt
  // banner above) for visual consistency with the project's "warning"
  // convention. The left-border accent + title/body layout mirrors the
  // signal-lost banner (red variant) for a familiar look.
  // ---- Post-processing toggle ----
  // Variant for toggle rows that are the TOP half of a settingGroup (toggle
  // + stepper card). Removes the bottom margin and rounds only the top
  // corners so the stepper row below visually attaches to it.
  // Visual "locked" state — used when recording is in progress so the toggles
  // are visibly disabled. We deliberately keep the row's on/off color so the
  // user can still tell which settings are active; we only dim the whole row
  // (opacity) and override the background to a neutral grey so the row looks
  // "frozen" rather than "off".
  // NOTE: we intentionally do NOT override the switch color when locked.
  // The row-level `opacity: 0.55` already conveys "disabled"; forcing the
  // switch to grey made enabled-but-locked toggles look "off" mid-recording,
  // which was one of the wonky-UI complaints.
  // ---- Setting group (toggle + stepper card) ----
  // Wraps a toggle row + stepper row so they read as one "card". The
  // marginBottom here replaces the per-row marginBottom (which is removed
  // by toggleRowGrouped on the top row, and absent on StepperRow).
  // ---- Settings section header + locked badge ----
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 4,
    flexWrap: 'wrap',
    gap: 8,
  },
  settingsHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.secondary,
    letterSpacing: 2,
  },
  settingsLockedBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: COLOR.accentStop,
    backgroundColor: '#FEF2F2',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  // ---- Permission button ----
  permissionButton: {
    backgroundColor: '#F3F4F6', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: COLOR.divider,
  },
  permissionButtonText: { color: COLOR.primary, fontSize: 14, fontWeight: '600' },
  // ---- Saved / error cards ----
  // U19: shared row layout for the saved/error card title + dismiss button.
  // U19: shared dismiss (✕) button used by both the saved card and the
  // error card. Small, neutral-coloured, top-right of the card.
  // Final distance + pace line shown on the saved card. Slightly larger and
  // bolder than the path so the user notices it.
  // U2: "Открыть настройки" button shown inside the error card when the user
  // is missing permissions. Tapping it calls GpsRecorder.openAppSettings(),
  // which opens the Android system app-details page (where the user can
  // grant location / notification permissions manually).
  // ---- Footer ----
  footerNote: { marginTop: 8 },
  footerText: {
    color: '#9CA3AF', fontSize: 12, lineHeight: 18, textAlign: 'center',
  },
  // ---- U1: permission-wait overlay ----
  // Full-screen semi-transparent overlay so the user can't tap anything else
  // while waiting for the system permission dialog. Centers a card with a
  // spinner, an explanatory line, and a Cancel button.
  // O14: full-screen "native module not loaded" fallback.
  nativeMissingContainer: {
    flex: 1,
    backgroundColor: COLOR.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  nativeMissingTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLOR.errorText,
    marginBottom: 16,
    textAlign: 'center',
  },
  nativeMissingBody: {
    fontSize: 14,
    color: COLOR.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});

export default App;
