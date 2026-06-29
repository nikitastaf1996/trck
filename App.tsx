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

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  GpsRecorder,
  subscribe,
  type GpsLocationEvent,
  type GpsStateEvent,
  type GpsSavedEvent,
  type GpsFullState,
  type GpsFixType,
  type GpsGnssEvent,
} from './src/NativeGpsRecorder';

type RecordingState = 'idle' | 'recording' | 'stopping';

// ---- Palette (light, minimalist, inspired by the reference screenshot) ----
const COLOR = {
  bg: '#FFFFFF',
  primary: '#0A2463',        // deep navy — for all numerals
  secondary: '#6B7280',      // medium gray — for labels
  divider: '#E5E7EB',        // very light gray — for dividers
  accentStart: '#0A2463',    // navy — START button
  accentStop: '#DC2626',     // red — STOP button
  accentStopping: '#9CA3AF', // gray — STOPPING state
  // Phase 6: auto-pause / signal-lost palette.
  pauseAccent: '#D97706',    // amber — auto-paused indicator
  pauseBg: '#FFFBEB',        // light amber background for pause banner
  pauseBorder: '#FDE68A',    // amber border for pause banner
  signalLostAccent: '#DC2626', // red — signal-lost banner
  signalLostBg: '#FEF2F2',     // light red background for signal-lost banner
  signalLostBorder: '#FECACA', // red border for signal-lost banner
  gnssGreen: '#16A34A',
  gnssAmber: '#D97706',
  gnssRed: '#DC2626',
  gnssGray: '#9CA3AF',
  errorBg: '#FEF2F2',
  errorBorder: '#FECACA',
  errorText: '#991B1B',
  savedBg: '#F0FDF4',
  savedBorder: '#BBF7D0',
  savedText: '#166534',
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

/**
 * Formats a distance in meters as a runner-friendly string with the unit
 * separated, so the UI can render the number largely and the unit small:
 *   - < 1000 m  -> { value: "123", unit: "m" }
 *   - >= 1000 m -> { value: "1.23", unit: "km" }
 */
function formatDistance(distanceM: number): { value: string; unit: string } {
  if (!distanceM || distanceM <= 0) return { value: '0', unit: 'm' };
  if (distanceM < 1000) return { value: String(Math.round(distanceM)), unit: 'm' };
  return { value: (distanceM / 1000).toFixed(2), unit: 'km' };
}

/**
 * Average pace from elapsed time and total distance, in "M:SS" per km.
 * Returns null if there is no measurable distance or elapsed time yet.
 *
 * Phase 6: when auto-pause is enabled, callers should pass the active moving
 * time (movingMs) instead of wall-clock elapsed time so paused intervals
 * don't inflate the displayed average pace.
 */
function computeAvgPace(elapsedMs: number, distanceM: number): string | null {
  if (!distanceM || distanceM < 1) return null;
  if (!elapsedMs || elapsedMs < 1000) return null;
  const minutesTotal = elapsedMs / 60000.0;
  const km = distanceM / 1000.0;
  const pace = minutesTotal / km;
  if (!isFinite(pace) || pace <= 0) return null;
  const wholeMin = Math.floor(pace);
  const sec = Math.round((pace - wholeMin) * 60);
  if (sec === 60) return `${wholeMin + 1}:00`;
  return `${wholeMin}:${pad2(sec)}`;
}

/**
 * Current (instantaneous) pace from GPS speed (m/s), in "M:SS" per km.
 * Returns null if speed is missing or below the standing-still threshold.
 *
 * The threshold is 0.5 m/s (~1.8 km/h) — a slow shuffle. Anything below
 * this is either genuinely standing still or GPS noise around a stationary
 * user, and showing a "33:00 /km" pace in those moments is more confusing
 * than just showing "—".
 */
function computeCurrentPace(speedMps: number | null | undefined): string | null {
  if (speedMps == null || speedMps <= 0.5) return null;  // ignore < 1.8 km/h (standing still / GPS noise)
  const paceSecPerKm = 1000 / speedMps;                  // seconds per km
  const wholeMin = Math.floor(paceSecPerKm / 60);
  const sec = Math.round(paceSecPerKm % 60);
  if (sec === 60) return `${wholeMin + 1}:00`;
  return `${wholeMin}:${pad2(sec)}`;
}

function App(): React.ReactElement {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [pointCount, setPointCount] = useState<number>(0);
  const [distance, setDistance] = useState<number>(0);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  const [fixType, setFixType] = useState<GpsFixType>('no fix');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [satellitesUsed, setSatellitesUsed] = useState<number>(0);
  const [satellitesInView, setSatellitesInView] = useState<number>(0);
  const [hasFix, setHasFix] = useState<boolean>(false);
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
  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [postProcessEnabled, setPostProcessEnabled] = useState<boolean>(false);
  const [gaussianSmoothingEnabled, setGaussianSmoothingEnabled] = useState<boolean>(false);
  // Phase 1/3/4: auto-pause setting + live pause / signal state + moving time.
  const [autoPauseEnabled, setAutoPauseEnabled] = useState<boolean>(false);
  // Phase 4 toggle: gap detection (signal-loss segment splits). Defaults to
  // true so existing users keep the behaviour from the previous APK.
  const [gapDetectionEnabled, setGapDetectionEnabled] = useState<boolean>(true);
  // Three independent data-reduction filters (user requested). Each has an
  // enabled toggle plus a numeric parameter, exposed via the new
  // setRadialDistanceFilter* / setTimeSampling* / setDouglasPeucker* bridge
  // methods. All are persisted in the separate settings prefs file so they
  // survive the per-recording state clear, and all are locked while a
  // recording is in progress (see settingsLocked).
  const [radialDistanceFilterEnabled, setRadialDistanceFilterEnabled] = useState<boolean>(false);
  const [radialDistanceThresholdM, setRadialDistanceThresholdM] = useState<number>(5);
  const [timeSamplingEnabled, setTimeSamplingEnabled] = useState<boolean>(false);
  const [timeSamplingN, setTimeSamplingN] = useState<number>(5);
  const [douglasPeuckerEnabled, setDouglasPeuckerEnabled] = useState<boolean>(false);
  const [douglasPeuckerEpsilonM, setDouglasPeuckerEpsilonM] = useState<number>(5);
  const [isAutoPaused, setIsAutoPaused] = useState<boolean>(false);
  const [signalLost, setSignalLost] = useState<boolean>(false);
  const [movingMs, setMovingMs] = useState<number>(0);
  const startTimeRef = useRef<number | null>(null);
  // Mirror of `recordingState` for use inside event-subscription closures.
  // We keep the main useEffect's deps stable (so the subscriptions are NOT
  // torn down + recreated on every idle -> recording -> stopping -> idle
  // transition, which was causing missed 'state' / 'saved' events). The
  // closures read this ref instead of capturing the state directly.
  const recordingStateRef = useRef<RecordingState>('idle');
  useEffect(() => {
    recordingStateRef.current = recordingState;
  }, [recordingState]);

  // Sliding window of the most recent GPS speeds (m/s) seen during the
  // current recording. Used to compute a smoothed "current pace" instead of
  // relying on the raw instantaneous GPS speed, which jumps around a lot at
  // 1 Hz and makes the TEMPO readout flicker between e.g. 4:30 and 6:10 from
  // one fix to the next. The window is cleared on stop / save so a fresh
  // recording starts with no history.
  const recentSpeedsRef = useRef<number[]>([]);
  const SPEED_WINDOW = 5; // ~5 seconds at 1 Hz — short enough to be responsive
  // Refs that mirror movingMs / elapsedMs / autoPauseEnabled so the
  // 'saved' event handler (which is set up ONCE in the mount effect and
  // must NOT re-run on every state change, otherwise we lose events) can
  // read their latest values at save time. Without these the closure would
  // capture the initial 0 values and never see the updated ones.
  const movingMsRef = useRef<number>(0);
  const elapsedMsRef = useRef<number>(0);
  const autoPauseEnabledRef = useRef<boolean>(false);
  // Bugfix: mirror gapDetectionEnabled too, so the saved-card pace logic
  // can read it from the (once-set-up) saved-event closure. See the
  // paceTimeMs comment above for why gap detection now also affects pace.
  const gapDetectionEnabledRef = useRef<boolean>(true);
  useEffect(() => { movingMsRef.current = movingMs; }, [movingMs]);
  useEffect(() => { elapsedMsRef.current = elapsedMs; }, [elapsedMs]);
  useEffect(() => { autoPauseEnabledRef.current = autoPauseEnabled; }, [autoPauseEnabled]);
  useEffect(() => { gapDetectionEnabledRef.current = gapDetectionEnabled; }, [gapDetectionEnabled]);

  // Sync state from native via getState(). Called on mount, on foreground, and every 2s.
  const syncStateFromNative = useCallback(async () => {
    try {
      const state: GpsFullState = await GpsRecorder.getState();
      if (state.isRecording) {
        setRecordingState((prev) => (prev === 'stopping' ? prev : 'recording'));
        setPointCount(state.pointCount);
        setElapsedMs(state.elapsedMs);
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
        if (startTimeRef.current == null) {
          startTimeRef.current = Date.now() - state.elapsedMs;
        }
      } else {
        setRecordingState((prev) => (prev === 'stopping' ? prev : 'idle'));
      }
    } catch {
      // ignore — will retry on next poll
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        // Auto-request permissions on first launch.
        let granted = await GpsRecorder.hasPermissions();
        if (!granted) {
          await GpsRecorder.requestPermissions();
          await new Promise((r) => setTimeout(r, 800));
          granted = await GpsRecorder.hasPermissions();
        }
        if (!mounted) return;
        setHasPermissions(granted);

        // Load the post-process setting from native prefs.
        try {
          const pp = await GpsRecorder.getPostProcessEnabled();
          if (mounted) setPostProcessEnabled(pp);
        } catch { /* ignore */ }

        // Load the Gaussian-smoothing setting from native prefs.
        try {
          const gs = await GpsRecorder.getGaussianSmoothingEnabled();
          if (mounted) setGaussianSmoothingEnabled(gs);
        } catch { /* ignore */ }

        // Phase 1: load the auto-pause setting from native prefs.
        try {
          const ap = await GpsRecorder.getAutoPauseEnabled();
          if (mounted) setAutoPauseEnabled(ap);
        } catch { /* ignore */ }

        // Phase 4: load the gap-detection setting from native prefs.
        // Default is true (the previous APK always ran gap detection), so if
        // the native side returns false here it's a real user choice.
        try {
          const gd = await GpsRecorder.getGapDetectionEnabled();
          if (mounted) setGapDetectionEnabled(gd);
        } catch { /* ignore */ }

        // Load the three data-reduction filter settings from native prefs.
        // Each has a boolean enabled flag + a numeric parameter.
        try {
          const rde = await GpsRecorder.getRadialDistanceFilterEnabled();
          if (mounted) setRadialDistanceFilterEnabled(rde);
          const rdt = await GpsRecorder.getRadialDistanceThresholdM();
          if (mounted) setRadialDistanceThresholdM(rdt);
        } catch { /* ignore */ }
        try {
          const tse = await GpsRecorder.getTimeSamplingEnabled();
          if (mounted) setTimeSamplingEnabled(tse);
          const tsn = await GpsRecorder.getTimeSamplingN();
          if (mounted) setTimeSamplingN(tsn);
        } catch { /* ignore */ }
        try {
          const dpe = await GpsRecorder.getDouglasPeuckerEnabled();
          if (mounted) setDouglasPeuckerEnabled(dpe);
          const dpeps = await GpsRecorder.getDouglasPeuckerEpsilonM();
          if (mounted) setDouglasPeuckerEpsilonM(dpeps);
        } catch { /* ignore */ }

        // Start the always-on GNSS monitor so the UI shows fix status even
        // before recording starts.
        if (granted) {
          try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
        }
        await syncStateFromNative();
      } catch {
        // ignore
      }
    })();

    // Event subscriptions (real-time updates)
    const subs = [
      subscribe('gnss', (ev: GpsGnssEvent) => {
        // The monitor's status is the source of truth for the GNSS pill.
        setFixType(ev.fixType);
        setAccuracy(ev.accuracy);
        setSatellitesUsed(ev.satellitesUsed);
        setSatellitesInView(ev.satellitesInView);
        setHasFix(ev.hasFix);
        // While idle (not recording), the monitor's speed is also the best
        // current-speed signal we have. While recording, the 'location' event
        // overrides it.
        if (recordingStateRef.current !== 'recording') {
          setCurrentSpeed(ev.speed);
        }
      }),
      subscribe('location', (ev: GpsLocationEvent) => {
        // Recording-time updates from the service.
        setPointCount(ev.pointCount);
        if (typeof ev.distance === 'number') setDistance(ev.distance);
        if (ev.fixType) setFixType(ev.fixType);
        if (ev.accuracy != null) setAccuracy(ev.accuracy);
        if (ev.speed != null) {
          setCurrentSpeed(ev.speed);
          // Push into the smoothing window. We accept every fix here (even
          // slow / zero ones) so the window correctly reflects "user is
          // standing still" — the smoothed pace helper returns null when
          // the window average is below the standing-still threshold.
          const w = recentSpeedsRef.current;
          w.push(ev.speed);
          if (w.length > SPEED_WINDOW) w.shift();
        }
        setHasFix(ev.fixType !== 'no fix');
        // Phase 1/3/4: live auto-pause / signal-lost / moving-time.
        if (typeof ev.isAutoPaused === 'boolean') setIsAutoPaused(ev.isAutoPaused);
        if (typeof ev.signalLost === 'boolean') setSignalLost(ev.signalLost);
        if (typeof ev.movingMs === 'number') setMovingMs(ev.movingMs);
      }),
      subscribe('duration', (ev) => {
        setElapsedMs(ev.elapsedMs);
        if (startTimeRef.current == null) {
          startTimeRef.current = Date.now() - ev.elapsedMs;
        }
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
          setRecordingState('recording');
          setPointCount(ev.pointCount);
          setElapsedMs(ev.elapsedMs);
          startTimeRef.current = Date.now() - ev.elapsedMs;
          // Phase 1/3/4: sync live pause / signal / moving-time on state
          // transitions (e.g. when the watchdog fires or auto-pause toggles).
          if (typeof ev.isAutoPaused === 'boolean') setIsAutoPaused(ev.isAutoPaused);
          if (typeof ev.signalLost === 'boolean') setSignalLost(ev.signalLost);
          if (typeof ev.movingMs === 'number') setMovingMs(ev.movingMs);
        } else {
          setRecordingState('idle');
          setPointCount(0);
          setElapsedMs(0);
          setDistance(0);
          setCurrentSpeed(null);
          setFixType('no fix');
          setHasFix(false);
          // Phase 1/3/4: reset live state when recording stops.
          setIsAutoPaused(false);
          setSignalLost(false);
          setMovingMs(0);
          startTimeRef.current = null;
          // Clear the pace-smoothing window so a fresh recording starts
          // with no stale speeds from the previous run.
          recentSpeedsRef.current = [];
        }
      }),
      subscribe('saved', (ev: GpsSavedEvent) => {
        // Snapshot the live timing values BEFORE we reset them, so the
        // saved card can show the post-save average pace over the final
        // distance / moving time. We read from refs because this closure
        // is set up once at mount and would otherwise capture stale values.
        setLastSavedMovingMs(movingMsRef.current);
        setLastSavedElapsedMs(elapsedMsRef.current);
        setLastSavedPath(ev.filePath);
        // The native side sends the post-save distance (recomputed from the
        // saved GPX file, post-smoothing) so the UI shows the true track
        // length. Negative means "not available" — keep the live distance.
        const fd = (ev as any).finalDistanceM;
        setLastSavedDistance(typeof fd === 'number' && fd >= 0 ? fd : null);
        setPointCount(0);
        setElapsedMs(0);
        setDistance(0);
        setCurrentSpeed(null);
        setFixType('no fix');
        setHasFix(false);
        setRecordingState('idle');
        // Phase 1/3/4: clear live pause / signal / moving-time after save.
        setIsAutoPaused(false);
        setSignalLost(false);
        setMovingMs(0);
        startTimeRef.current = null;
        // Clear the pace-smoothing window for the next recording.
        recentSpeedsRef.current = [];
      }),
      subscribe('error', (ev) => {
        setErrorMsg(ev.message);
        setRecordingState('idle');
      }),
    ];

    // Re-sync when coming back to foreground
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncStateFromNative();
        GpsRecorder.hasPermissions().then(async (g) => {
          setHasPermissions(g);
          if (g) {
            try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
          }
        });
      }
    });

    // Polling fallback: every 2 seconds, sync state from native.
    const pollInterval = setInterval(() => {
      syncStateFromNative();
    }, 2000);

    return () => {
      mounted = false;
      subs.forEach((s) => s.remove());
      appStateSub.remove();
      clearInterval(pollInterval);
      // Stop the GNSS monitor when the JS app unmounts.
      try { GpsRecorder.stopGnssMonitor(); } catch { /* ignore */ }
    };
  }, [syncStateFromNative]); // NOTE: recordingState intentionally omitted — see recordingStateRef.

  const handleStart = useCallback(async () => {
    setErrorMsg(null);
    try {
      let granted = await GpsRecorder.hasPermissions();
      if (!granted) {
        await GpsRecorder.requestPermissions();
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          granted = await GpsRecorder.hasPermissions();
          if (granted) break;
        }
        setHasPermissions(granted);
        if (granted) {
          try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
        }
      }

      if (!granted) {
        setErrorMsg(
          'Location and notification permissions are required. Please grant them in Android Settings.'
        );
        return;
      }

      try {
        await GpsRecorder.requestIgnoreBatteryOptimizations();
      } catch {
        // ignore
      }

      setElapsedMs(0);
      setPointCount(0);
      setDistance(0);
      setCurrentSpeed(null);
      setLastSavedPath(null);
      startTimeRef.current = Date.now();
      // Clear the pace-smoothing window for the fresh recording.
      recentSpeedsRef.current = [];

      await GpsRecorder.start();
      setRecordingState('recording');
      syncStateFromNative();
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setRecordingState('idle');
    }
  }, [syncStateFromNative]);

  const handleStop = useCallback(async () => {
    setErrorMsg(null);
    setRecordingState('stopping');
    try {
      await GpsRecorder.stop();
      setTimeout(() => syncStateFromNative(), 1000);
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setRecordingState('recording');
    }
  }, [syncStateFromNative]);

  const handleGrantPermissions = useCallback(async () => {
    await GpsRecorder.requestPermissions();
    await new Promise((r) => setTimeout(r, 800));
    const granted = await GpsRecorder.hasPermissions();
    setHasPermissions(granted);
    if (granted) {
      try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
    }
  }, []);

  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';
  // Settings are locked (read-only) while a recording is in progress so that
  // toggling them mid-recording cannot change the filter / smoothing behaviour
  // halfway through the file.
  const settingsLocked = isRecording || isStopping;

  const handleTogglePostProcess = useCallback(async () => {
    if (settingsLocked) return; // locked during recording
    const next = !postProcessEnabled;
    setPostProcessEnabled(next); // optimistic UI update
    try {
      const confirmed = await GpsRecorder.setPostProcessEnabled(next);
      setPostProcessEnabled(confirmed);
    } catch (e: any) {
      // revert on failure
      setPostProcessEnabled(!next);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [postProcessEnabled, settingsLocked]);

  const handleToggleGaussianSmoothing = useCallback(async () => {
    if (settingsLocked) return; // locked during recording
    const next = !gaussianSmoothingEnabled;
    setGaussianSmoothingEnabled(next); // optimistic UI update
    try {
      const confirmed = await GpsRecorder.setGaussianSmoothingEnabled(next);
      setGaussianSmoothingEnabled(confirmed);
    } catch (e: any) {
      // revert on failure
      setGaussianSmoothingEnabled(!next);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [gaussianSmoothingEnabled, settingsLocked]);

  // Phase 1: toggle the auto-pause setting. Persisted in the separate
  // settings prefs file so it survives the per-recording state clear. Like
  // the other two settings, it is locked during an active recording so
  // toggling it mid-recording can't change the stop-detection behaviour
  // halfway through the file.
  const handleToggleAutoPause = useCallback(async () => {
    if (settingsLocked) return;
    const next = !autoPauseEnabled;
    setAutoPauseEnabled(next);
    try {
      const confirmed = await GpsRecorder.setAutoPauseEnabled(next);
      setAutoPauseEnabled(confirmed);
    } catch (e: any) {
      setAutoPauseEnabled(!next);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [autoPauseEnabled, settingsLocked]);

  // Phase 4: toggle the gap-detection setting. Same persistence + lock-
  // during-recording semantics as the other toggles. Default is on; turning
  // it off restores the legacy pre-Phase-4 behaviour where signal outages
  // do NOT split the track and the signal-lost UI banner never appears.
  const handleToggleGapDetection = useCallback(async () => {
    if (settingsLocked) return;
    const next = !gapDetectionEnabled;
    setGapDetectionEnabled(next);
    try {
      const confirmed = await GpsRecorder.setGapDetectionEnabled(next);
      setGapDetectionEnabled(confirmed);
    } catch (e: any) {
      setGapDetectionEnabled(!next);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [gapDetectionEnabled, settingsLocked]);

  // ---- Three data-reduction filter toggles + steppers ----
  //
  // Each filter has an enabled toggle (persisted boolean) + a numeric
  // parameter (persisted int / double). The steppers clamp to the same
  // ranges as the native side (see GpsRecorderModule.kt) so the UI never
  // shows a value the native side will reject. All are locked while a
  // recording is in progress.

  const handleToggleRadialDistanceFilter = useCallback(async () => {
    if (settingsLocked) return;
    const next = !radialDistanceFilterEnabled;
    setRadialDistanceFilterEnabled(next);
    try {
      const confirmed = await GpsRecorder.setRadialDistanceFilterEnabled(next);
      setRadialDistanceFilterEnabled(confirmed);
    } catch (e: any) {
      setRadialDistanceFilterEnabled(!next);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [radialDistanceFilterEnabled, settingsLocked]);

  const handleStepperRadialThreshold = useCallback(async (delta: number) => {
    if (settingsLocked) return;
    const next = Math.max(0, Math.min(1000, radialDistanceThresholdM + delta));
    if (next === radialDistanceThresholdM) return;
    setRadialDistanceThresholdM(next); // optimistic
    try {
      const confirmed = await GpsRecorder.setRadialDistanceThresholdM(next);
      setRadialDistanceThresholdM(confirmed);
    } catch (e: any) {
      setRadialDistanceThresholdM(radialDistanceThresholdM); // revert
      setErrorMsg(e?.message ?? String(e));
    }
  }, [radialDistanceThresholdM, settingsLocked]);

  const handleToggleTimeSampling = useCallback(async () => {
    if (settingsLocked) return;
    const next = !timeSamplingEnabled;
    setTimeSamplingEnabled(next);
    try {
      const confirmed = await GpsRecorder.setTimeSamplingEnabled(next);
      setTimeSamplingEnabled(confirmed);
    } catch (e: any) {
      setTimeSamplingEnabled(!next);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [timeSamplingEnabled, settingsLocked]);

  const handleStepperTimeSamplingN = useCallback(async (delta: number) => {
    if (settingsLocked) return;
    const next = Math.max(1, Math.min(60, timeSamplingN + delta));
    if (next === timeSamplingN) return;
    setTimeSamplingN(next);
    try {
      const confirmed = await GpsRecorder.setTimeSamplingN(next);
      setTimeSamplingN(confirmed);
    } catch (e: any) {
      setTimeSamplingN(timeSamplingN);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [timeSamplingN, settingsLocked]);

  const handleToggleDouglasPeucker = useCallback(async () => {
    if (settingsLocked) return;
    const next = !douglasPeuckerEnabled;
    setDouglasPeuckerEnabled(next);
    try {
      const confirmed = await GpsRecorder.setDouglasPeuckerEnabled(next);
      setDouglasPeuckerEnabled(confirmed);
    } catch (e: any) {
      setDouglasPeuckerEnabled(!next);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [douglasPeuckerEnabled, settingsLocked]);

  const handleStepperDouglasPeuckerEpsilon = useCallback(async (delta: number) => {
    if (settingsLocked) return;
    const next = Math.max(0, Math.min(500, douglasPeuckerEpsilonM + delta));
    if (next === douglasPeuckerEpsilonM) return;
    setDouglasPeuckerEpsilonM(next);
    try {
      const confirmed = await GpsRecorder.setDouglasPeuckerEpsilonM(next);
      setDouglasPeuckerEpsilonM(confirmed);
    } catch (e: any) {
      setDouglasPeuckerEpsilonM(douglasPeuckerEpsilonM);
      setErrorMsg(e?.message ?? String(e));
    }
  }, [douglasPeuckerEpsilonM, settingsLocked]);

  const distanceFmt = formatDistance(distance);
  // Smoothed current pace: average of the last few GPS speeds. This is much
  // less jittery than the raw 1 Hz instantaneous speed, which can swing
  // between e.g. 2.8 m/s and 4.1 m/s on consecutive fixes just from GPS
  // noise. The window is short (5 fixes ≈ 5 s) so the pace still tracks
  // real changes in effort within a few seconds.
  //
  // While idle (no recording), we fall back to the GNSS monitor's speed.
  // While auto-paused, we suppress the pace (show "—") because the user is
  // stationary and any window average is meaningless.
  const smoothedSpeed = (() => {
    if (isAutoPaused) return null;
    const w = recentSpeedsRef.current;
    if (isRecording && w.length > 0) {
      const sum = w.reduce((a, b) => a + b, 0);
      return sum / w.length;
    }
    return currentSpeed;
  })();
  const currentPace = computeCurrentPace(smoothedSpeed);
  // Phase 6 + bugfix: when auto-pause is enabled, compute average pace using
  // the active moving time (which excludes paused intervals) instead of wall-
  // clock elapsed time. This keeps the displayed avg pace honest when the
  // user stands still for long stretches (e.g. at traffic lights).
  //
  // Bugfix: also use movingMs when gap detection is enabled but auto-pause
  // is off. In that case movingMs excludes signal-loss intervals (the
  // watchdog freezes it when signalLost fires, see GpsRecorderService), so
  // the avg pace stays honest across tunnels / indoor stretches where the
  // GPS drops out. Without this, a 5-minute tunnel would inflate the avg
  // pace from e.g. 5:30/km to 6:30/km because elapsedMs kept ticking
  // through the outage while distance did not.
  //
  // When BOTH settings are off, movingMs equals elapsedMs (no transitions
  // ever fire), so we use elapsedMs directly to avoid the small overhead
  // of the movingMs path.
  const paceTimeMs = (autoPauseEnabled || gapDetectionEnabled) ? movingMs : elapsedMs;
  const avgPace = computeAvgPace(paceTimeMs, distance);

  return (
    <SafeAreaView style={styles.container}>
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

        {/* Phase 4: signal-loss banner. Shown when the gap watchdog in the
            service has declared signal lost (no fix in 15+ seconds) while a
            recording is in progress. */}
        {isRecording && signalLost && (
          <View style={styles.signalLostBanner}>
            <Text style={styles.signalLostTitle}>ПОТЕРЯ СИГНАЛА GPS</Text>
            <Text style={styles.signalLostText}>
              Нет фиксации более 15 с. Запись продолжится; новый сегмент
              трека начнётся автоматически при восстановлении сигнала.
            </Text>
          </View>
        )}

        {/* Primary stats: TIME, DISTANCE, PACE, AVG PACE */}
        <BigStat
          label="ВРЕМЯ"
          value={formatDuration(elapsedMs)}
          // Phase 3: when auto-pause is active, render the TIME value in
          // amber and show a small "ПАУЗА" indicator above it so the user
          // knows the timer is wall-clock but recording is paused.
          valueColor={isAutoPaused ? COLOR.pauseAccent : undefined}
        />
        {isAutoPaused && (
          <View style={styles.pauseBadge}>
            <View style={styles.pauseDot} />
            <Text style={styles.pauseBadgeText}>
              АВТОПАУЗА · запись приостановлена
            </Text>
          </View>
        )}
        <Divider />

        <BigStat
          label="ДИСТАНЦИЯ"
          value={distanceFmt.value}
          unit={distanceFmt.unit}
        />
        <Divider />

        <View style={styles.twoCol}>
          <BigStat
            label="ТЕМП"
            value={currentPace ?? '—'}
            unit={currentPace ? '/км' : undefined}
            compact
          />
          <View style={styles.colDivider} />
          <BigStat
            label="СРЕД. ТЕМП"
            value={avgPace ?? '—'}
            unit={avgPace ? '/км' : undefined}
            compact
          />
        </View>

        {/* Status / recording indicator */}
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusDot,
              isAutoPaused
            ? styles.dotPaused
            : isRecording
            ? styles.dotOn
            : styles.dotOff,
            ]}
          />
          <Text style={styles.statusText}>
            {isAutoPaused
              ? 'АВТОПАУЗА'
              : signalLost
              ? 'НЕТ СИГНАЛА'
              : isRecording
              ? 'ЗАПИСЬ'
              : isStopping
              ? 'ОСТАНОВКА…'
              : pointCount > 0
              ? `${pointCount} ТОЧЕК`
              : 'ОЖИДАНИЕ'}
          </Text>
        </View>

        {/* Big circular START / STOP button */}
        <View style={styles.buttonWrap}>
          <Pressable
            style={({ pressed }) => [
              styles.bigButton,
              isRecording ? styles.bigButtonStop : styles.bigButtonStart,
              (pressed || isStopping) && styles.bigButtonPressed,
              isStopping && styles.bigButtonStopping,
            ]}
            onPress={isRecording ? handleStop : handleStart}
            disabled={isStopping}
            android_ripple={{ color: 'rgba(255,255,255,0.18)', radius: 220 }}
          >
            <Text style={styles.bigButtonText}>
              {isStopping ? '…' : isRecording ? 'СТОП' : 'СТАРТ'}
            </Text>
          </Pressable>
        </View>

        {/* Settings section header + "locked during recording" notice */}
        <View style={styles.settingsHeader}>
          <Text style={styles.settingsHeaderText}>НАСТРОЙКИ</Text>
          {settingsLocked && (
            <Text style={styles.settingsLockedBadge}>
              🔒 Заблокировано на время записи
            </Text>
          )}
        </View>

        {/* On-the-fly track filtering toggle (locked while recording) */}
        <Pressable
          style={[
            styles.toggleRow,
            postProcessEnabled ? styles.toggleRowOn : styles.toggleRowOff,
            settingsLocked && styles.toggleRowLocked,
          ]}
          onPress={handleTogglePostProcess}
          disabled={settingsLocked}
        >
          <View style={styles.toggleLabelWrap}>
            <Text style={styles.toggleTitle}>Фильтрация трека на лету</Text>
            <Text style={styles.toggleSubtitle}>
              {postProcessEnabled
                ? 'Включена: точность ≤ 25 м, скорость ≤ 20 км/ч — выбросы отсекаются при записи'
                : 'Выключена: запись сырых GPS-данных без изменений'}
            </Text>
          </View>
          <View
            style={[
              styles.toggleSwitch,
              postProcessEnabled ? styles.toggleSwitchOn : styles.toggleSwitchOff,
            ]}
          >
            <View
              style={[
                styles.toggleKnob,
                postProcessEnabled ? styles.toggleKnobOn : styles.toggleKnobOff,
              ]}
            />
          </View>
        </Pressable>

        {/* Gaussian / kernel smoothing toggle (locked while recording) */}
        <Pressable
          style={[
            styles.toggleRow,
            gaussianSmoothingEnabled ? styles.toggleRowOn : styles.toggleRowOff,
            settingsLocked && styles.toggleRowLocked,
          ]}
          onPress={handleToggleGaussianSmoothing}
          disabled={settingsLocked}
        >
          <View style={styles.toggleLabelWrap}>
            <Text style={styles.toggleTitle}>Сглаживание Гауссом (постобработка)</Text>
            <Text style={styles.toggleSubtitle}>
              {gaussianSmoothingEnabled
                ? 'Включено: после записи к треку применяется гауссово сглаживание (окно ±5 точек, σ=1.5)'
                : 'Выключено: GPX сохраняется как есть, без финального сглаживания'}
            </Text>
          </View>
          <View
            style={[
              styles.toggleSwitch,
              gaussianSmoothingEnabled ? styles.toggleSwitchOn : styles.toggleSwitchOff,
            ]}
          >
            <View
              style={[
                styles.toggleKnob,
                gaussianSmoothingEnabled ? styles.toggleKnobOn : styles.toggleKnobOff,
              ]}
            />
          </View>
        </Pressable>

        {/* Phase 1/3: Auto-pause toggle (locked while recording). When
            enabled, recording auto-pauses while the user is stationary
            (speed < 0.35 m/s + max displacement in 10 s window < 3.5 m) and
            auto-resumes when they start moving again. The track is split
            into separate <trkseg> blocks at each pause / resume so the GPX
            file has clean segment breaks. */}
        <Pressable
          style={[
            styles.toggleRow,
            autoPauseEnabled ? styles.toggleRowOn : styles.toggleRowOff,
            settingsLocked && styles.toggleRowLocked,
          ]}
          onPress={handleToggleAutoPause}
          disabled={settingsLocked}
        >
          <View style={styles.toggleLabelWrap}>
            <Text style={styles.toggleTitle}>Автопауза при остановке</Text>
            <Text style={styles.toggleSubtitle}>
              {autoPauseEnabled
                ? 'Включена: пауза при скорости < 0.35 м/с и смещении < 3.5 м за 10 с. Средний темп считается по чистому времени движения'
                : 'Выключена: запись идёт непрерывно, даже когда вы стоите на месте'}
            </Text>
          </View>
          <View
            style={[
              styles.toggleSwitch,
              autoPauseEnabled ? styles.toggleSwitchOn : styles.toggleSwitchOff,
            ]}
          >
            <View
              style={[
                styles.toggleKnob,
                autoPauseEnabled ? styles.toggleKnobOn : styles.toggleKnobOff,
              ]}
            />
          </View>
        </Pressable>

        {/* Phase 4: Gap-detection toggle (locked while recording). When
            enabled (DEFAULT), a watchdog in the service declares signal
            lost after 15 s without a fix, the UI shows a red "ПОТЕРЯ СИГНАЛА
            GPS" banner, and the next arriving fix starts a new <trkseg> so
            the track has a clean break at the outage. When disabled, signal
            outages do NOT split the track and the banner never appears —
            the legacy pre-Phase-4 behaviour. */}
        <Pressable
          style={[
            styles.toggleRow,
            gapDetectionEnabled ? styles.toggleRowOn : styles.toggleRowOff,
            settingsLocked && styles.toggleRowLocked,
          ]}
          onPress={handleToggleGapDetection}
          disabled={settingsLocked}
        >
          <View style={styles.toggleLabelWrap}>
            <Text style={styles.toggleTitle}>Разделение трека при потере сигнала</Text>
            <Text style={styles.toggleSubtitle}>
              {gapDetectionEnabled
                ? 'Включено: нет фиксации > 15 с → новый сегмент <trkseg> и баннер "ПОТЕРЯ СИГНАЛА". Расстояние через разрыв не считается'
                : 'Выключено: провалы сигнала игнорируются, трек пишётся одним сегментом (как в прежних версиях)'}
            </Text>
          </View>
          <View
            style={[
              styles.toggleSwitch,
              gapDetectionEnabled ? styles.toggleSwitchOn : styles.toggleSwitchOff,
            ]}
          >
            <View
              style={[
                styles.toggleKnob,
                gapDetectionEnabled ? styles.toggleKnobOn : styles.toggleKnobOff,
              ]}
            />
          </View>
        </Pressable>

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

        {/* 1. Radial distance filter toggle + stepper */}
        <View style={styles.settingGroup}>
          <Pressable
            style={[
              styles.toggleRow,
              styles.toggleRowGrouped,
              radialDistanceFilterEnabled ? styles.toggleRowOn : styles.toggleRowOff,
              settingsLocked && styles.toggleRowLocked,
            ]}
            onPress={handleToggleRadialDistanceFilter}
            disabled={settingsLocked}
          >
            <View style={styles.toggleLabelWrap}>
              <Text style={styles.toggleTitle}>Радиальный фильтр (на лету)</Text>
              <Text style={styles.toggleSubtitle}>
                {radialDistanceFilterEnabled
                  ? `Включён: точка пропускается, если она ближе ${radialDistanceThresholdM} м к последней сохранённой`
                  : 'Выключен: каждая принятая точка сохраняется в трек'}
              </Text>
            </View>
            <View
              style={[
                styles.toggleSwitch,
                radialDistanceFilterEnabled ? styles.toggleSwitchOn : styles.toggleSwitchOff,
              ]}
            >
              <View
                style={[
                  styles.toggleKnob,
                  radialDistanceFilterEnabled ? styles.toggleKnobOn : styles.toggleKnobOff,
                ]}
              />
            </View>
          </Pressable>
          <StepperRow
            label="Мин. расстояние"
            value={radialDistanceThresholdM}
            unit="м"
            min={0}
            max={1000}
            disabled={settingsLocked}
            onDecrement={() => handleStepperRadialThreshold(-1)}
            onIncrement={() => handleStepperRadialThreshold(+1)}
          />
        </View>

        {/* 2. Time sampling filter toggle + stepper */}
        <View style={styles.settingGroup}>
          <Pressable
            style={[
              styles.toggleRow,
              styles.toggleRowGrouped,
              timeSamplingEnabled ? styles.toggleRowOn : styles.toggleRowOff,
              settingsLocked && styles.toggleRowLocked,
            ]}
            onPress={handleToggleTimeSampling}
            disabled={settingsLocked}
          >
            <View style={styles.toggleLabelWrap}>
              <Text style={styles.toggleTitle}>Децимация по времени (на лету)</Text>
              <Text style={styles.toggleSubtitle}>
                {timeSamplingEnabled
                  ? `Включена: сохраняется каждая ${timeSamplingN}-я точка (≈ раз в ${timeSamplingN} с при 1 Гц)`
                  : 'Выключена: сохраняются все принятые точки'}
              </Text>
            </View>
            <View
              style={[
                styles.toggleSwitch,
                timeSamplingEnabled ? styles.toggleSwitchOn : styles.toggleSwitchOff,
              ]}
            >
              <View
                style={[
                  styles.toggleKnob,
                  timeSamplingEnabled ? styles.toggleKnobOn : styles.toggleKnobOff,
                ]}
              />
            </View>
          </Pressable>
          <StepperRow
            label="Шаг N"
            value={timeSamplingN}
            unit={timeSamplingN === 1 ? 'точка' : 'точек'}
            min={1}
            max={60}
            disabled={settingsLocked}
            onDecrement={() => handleStepperTimeSamplingN(-1)}
            onIncrement={() => handleStepperTimeSamplingN(+1)}
          />
        </View>

        {/* 3. Douglas-Peucker post-processing toggle + stepper */}
        <View style={styles.settingGroup}>
          <Pressable
            style={[
              styles.toggleRow,
              styles.toggleRowGrouped,
              douglasPeuckerEnabled ? styles.toggleRowOn : styles.toggleRowOff,
              settingsLocked && styles.toggleRowLocked,
            ]}
            onPress={handleToggleDouglasPeucker}
            disabled={settingsLocked}
          >
            <View style={styles.toggleLabelWrap}>
              <Text style={styles.toggleTitle}>Douglas-Peucker (постобработка)</Text>
              <Text style={styles.toggleSubtitle}>
                {douglasPeuckerEnabled
                  ? `Включён: трек упрощается, точки ближе ${douglasPeuckerEpsilonM} м от линии сегмента удаляются`
                  : 'Выключен: GPX сохраняется как есть, без финального упрощения'}
              </Text>
            </View>
            <View
              style={[
                styles.toggleSwitch,
                douglasPeuckerEnabled ? styles.toggleSwitchOn : styles.toggleSwitchOff,
              ]}
            >
              <View
                style={[
                  styles.toggleKnob,
                  douglasPeuckerEnabled ? styles.toggleKnobOn : styles.toggleKnobOff,
                ]}
              />
            </View>
          </Pressable>
          <StepperRow
            label="Эпсилон (допуск)"
            value={douglasPeuckerEpsilonM}
            unit="м"
            min={0}
            max={500}
            disabled={settingsLocked}
            onDecrement={() => handleStepperDouglasPeuckerEpsilon(-1)}
            onIncrement={() => handleStepperDouglasPeuckerEpsilon(+1)}
          />
        </View>

        {!hasPermissions && (
          <Pressable style={styles.permissionButton} onPress={handleGrantPermissions}>
            <Text style={styles.permissionButtonText}>
              Разрешить доступ к местоположению и уведомлениям
            </Text>
          </Pressable>
        )}

        {lastSavedPath && (
          <View style={styles.savedCard}>
            <Text style={styles.savedTitle}>GPX СОХРАНЁН</Text>
            <Text style={styles.savedPath}>{lastSavedPath}</Text>
            {lastSavedDistance != null && (() => {
              const fmt = formatDistance(lastSavedDistance);
              // Bugfix: keep the saved-card pace consistent with the live
              // pace logic — use movingMs whenever auto-pause OR gap
              // detection was enabled at save time.
              const tMs = (autoPauseEnabledRef.current || gapDetectionEnabledRef.current)
                ? lastSavedMovingMs
                : lastSavedElapsedMs;
              const pace = computeAvgPace(tMs, lastSavedDistance);
              return (
                <Text style={styles.savedDistance}>
                  Финальная дистанция: {fmt.value} {fmt.unit}
                  {pace ? `  ·  ${pace} /км` : ''}
                </Text>
              );
            })()}
          </View>
        )}

        {errorMsg && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        )}

        <View style={styles.footerNote}>
          <Text style={styles.footerText}>
            Запись идёт в foreground service и продолжается, когда приложение
            свёрнуто или смахнуто. Остановить можно из уведомления или кнопкой
            выше. GPX-файлы сохраняются в общую папку Downloads/trck.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Big-stat block: small uppercase label, then a huge numeral. Optional `unit`
 * is rendered small and to the right of the value (e.g. "km", "/km").
 * Phase 3: optional `valueColor` overrides the default navy when the value
 * needs to be visually de-emphasized (e.g. the TIME value turns amber while
 * auto-pause is active).
 */
function BigStat({
  label,
  value,
  unit,
  compact,
  valueColor,
}: {
  label: string;
  value: string;
  unit?: string;
  compact?: boolean;
  valueColor?: string;
}): React.ReactElement {
  return (
    <View style={[styles.statBlock, compact ? styles.statBlockCompact : null]}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={styles.statValueRow}>
        <Text
          style={[
            styles.statValue,
            compact ? styles.statValueCompact : null,
            valueColor != null ? { color: valueColor } : null,
          ]}
        >
          {value}
        </Text>
        {unit != null && <Text style={styles.statUnit}>{unit}</Text>}
      </View>
    </View>
  );
}

function Divider(): React.ReactElement {
  return <View style={styles.divider} />;
}

/**
 * Numeric stepper row: a small label, the current value with its unit, and
 * a minus / plus button pair. Used by the three data-reduction filter
 * settings (radial distance threshold, time sampling N, Douglas-Peucker
 * epsilon) to expose the user-tunable parameter.
 *
 * The row is always visible (even when the parent toggle is off) so the
 * user can preview / configure the parameter before enabling the filter.
 * The −/+ buttons are disabled when `disabled` is true (recording in
 * progress) OR when the value is at the min / max.
 *
 * Visually merges with the toggle row above it: shares the same horizontal
 * padding + border + background, has no top border-radius, and a slightly
 * smaller vertical padding so the two rows read as one "setting card".
 */
function StepperRow({
  label,
  value,
  unit,
  min,
  max,
  disabled,
  onDecrement,
  onIncrement,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  disabled: boolean;
  onDecrement: () => void;
  onIncrement: () => void;
}): React.ReactElement {
  const canDec = !disabled && value > min;
  const canInc = !disabled && value < max;
  return (
    <View style={[styles.stepperRow, disabled && styles.toggleRowLocked]}>
      <Pressable
        style={[styles.stepperBtn, !canDec && styles.stepperBtnDisabled]}
        onPress={onDecrement}
        disabled={!canDec}
        hitSlop={8}
      >
        <Text style={[styles.stepperBtnText, !canDec && styles.stepperBtnTextDisabled]}>−</Text>
      </Pressable>
      <View style={styles.stepperValueWrap}>
        <Text style={styles.stepperLabel}>{label}</Text>
        <Text style={styles.stepperValue}>
          {value}
          <Text style={styles.stepperUnit}> {unit}</Text>
        </Text>
      </View>
      <Pressable
        style={[styles.stepperBtn, !canInc && styles.stepperBtnDisabled]}
        onPress={onIncrement}
        disabled={!canInc}
        hitSlop={8}
      >
        <Text style={[styles.stepperBtnText, !canInc && styles.stepperBtnTextDisabled]}>+</Text>
      </Pressable>
    </View>
  );
}

/**
 * Pill-shaped GNSS status indicator. Always visible at the top of the screen.
 * Color-coded: green = 3D fix, amber = 2D fix, red/gray = no fix.
 */
function GnssPill({
  fixType,
  accuracy,
  satellitesUsed,
  satellitesInView,
  hasFix,
}: {
  fixType: GpsFixType;
  accuracy: number | null;
  satellitesUsed: number;
  satellitesInView: number;
  hasFix: boolean;
}): React.ReactElement {
  const color = hasFix
    ? (fixType === '3D fix' ? COLOR.gnssGreen : COLOR.gnssAmber)
    : COLOR.gnssRed;

  // Build the detail text: "3D · 4 m · 9 sats" or "no fix · 0/12 sats"
  let detail: string;
  if (hasFix) {
    const parts: string[] = [fixType.toUpperCase()];
    if (accuracy != null) parts.push(`${accuracy.toFixed(0)} м`);
    parts.push(`${satellitesUsed} СПУТ`);
    detail = parts.join(' · ');
  } else {
    detail = 'НЕТ СИГНАЛА' + (satellitesInView > 0 ? ` · ${satellitesUsed}/${satellitesInView}` : '');
  }

  return (
    <View style={styles.gnssPillWrap}>
      <View style={[styles.gnssPill, { borderColor: color }]}>
        <View style={[styles.gnssDot, { backgroundColor: color }]} />
        <Text style={styles.gnssText}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.bg },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 60,
  },
  // ---- GNSS pill ----
  gnssPillWrap: { alignItems: 'center', marginBottom: 24 },
  gnssPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    backgroundColor: '#FFFFFF',
  },
  gnssDot: {
    width: 8, height: 8, borderRadius: 4, marginRight: 8,
  },
  gnssText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLOR.primary,
    letterSpacing: 0.8,
    fontVariant: ['tabular-nums'],
  },
  // ---- Big stats ----
  statBlock: {
    alignItems: 'center',
    paddingVertical: 22,
  },
  statBlockCompact: {
    paddingVertical: 16,
    flex: 1,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLOR.secondary,
    letterSpacing: 2,
    marginBottom: 8,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  statValue: {
    fontSize: 64,
    fontWeight: '700',
    color: COLOR.primary,
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  statValueCompact: {
    fontSize: 36,
  },
  statUnit: {
    fontSize: 16,
    fontWeight: '500',
    color: COLOR.secondary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLOR.divider,
    marginVertical: 0,
  },
  twoCol: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  colDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: COLOR.divider,
    marginHorizontal: 0,
  },
  // ---- Status row ----
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    marginBottom: 8,
    gap: 8,
  },
  statusDot: {
    width: 8, height: 8, borderRadius: 4,
  },
  // Green when recording (active = good, matches the GNSS pill colour scheme).
  // Grey when idle. Amber when auto-paused. Red is reserved for the STOP
  // button + signal-lost banner so the user doesn't read a red dot as
  // "something is wrong" while a recording is happily in progress.
  dotOn: { backgroundColor: COLOR.gnssGreen },
  dotOff: { backgroundColor: COLOR.gnssGray },
  // Phase 3: amber dot shown while auto-pause is active.
  dotPaused: { backgroundColor: COLOR.pauseAccent },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.secondary,
    letterSpacing: 1.5,
  },
  // ---- Phase 3: auto-pause badge (shown below the TIME stat) ----
  pauseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: -8,
    marginBottom: 4,
  },
  pauseDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: COLOR.pauseAccent,
  },
  pauseBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.pauseAccent,
    letterSpacing: 1.5,
  },
  // ---- Phase 4: signal-lost banner ----
  signalLostBanner: {
    backgroundColor: COLOR.signalLostBg,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLOR.signalLostBorder,
  },
  signalLostTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: COLOR.signalLostAccent,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  signalLostText: {
    fontSize: 12,
    color: COLOR.signalLostAccent,
    lineHeight: 17,
  },
  // ---- Big button ----
  buttonWrap: { alignItems: 'center', marginTop: 24, marginBottom: 16 },
  bigButton: {
    width: 220, height: 220, borderRadius: 110,
    alignItems: 'center', justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18, shadowRadius: 12,
  },
  bigButtonStart: { backgroundColor: COLOR.accentStart },
  bigButtonStop: { backgroundColor: COLOR.accentStop },
  bigButtonPressed: { transform: [{ scale: 0.98 }] },
  bigButtonStopping: { backgroundColor: COLOR.accentStopping },
  bigButtonText: {
    color: '#FFFFFF', fontSize: 32, fontWeight: '800', letterSpacing: 4,
  },
  // ---- Post-processing toggle ----
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  // Variant for toggle rows that are the TOP half of a settingGroup (toggle
  // + stepper card). Removes the bottom margin and rounds only the top
  // corners so the stepper row below visually attaches to it.
  toggleRowGrouped: {
    marginBottom: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomWidth: 0,
  },
  toggleRowOn: {
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
  },
  toggleRowOff: {
    backgroundColor: '#F9FAFB',
    borderColor: COLOR.divider,
  },
  // Visual "locked" state — used when recording is in progress so the toggles
  // are visibly disabled. We deliberately keep the row's on/off color so the
  // user can still tell which settings are active; we only dim the whole row
  // (opacity) and override the background to a neutral grey so the row looks
  // "frozen" rather than "off".
  toggleRowLocked: {
    opacity: 0.55,
  },
  toggleLabelWrap: {
    flex: 1,
    paddingRight: 12,
  },
  toggleTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLOR.primary,
    marginBottom: 2,
  },
  toggleSubtitle: {
    fontSize: 11,
    color: COLOR.secondary,
    lineHeight: 15,
  },
  toggleSwitch: {
    width: 44,
    height: 24,
    borderRadius: 12,
    padding: 2,
    justifyContent: 'center',
  },
  toggleSwitchOn: { backgroundColor: COLOR.accentStart },
  toggleSwitchOff: { backgroundColor: '#D1D5DB' },
  // NOTE: we intentionally do NOT override the switch color when locked.
  // The row-level `opacity: 0.55` already conveys "disabled"; forcing the
  // switch to grey made enabled-but-locked toggles look "off" mid-recording,
  // which was one of the wonky-UI complaints.
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
  },
  toggleKnobOn: { alignSelf: 'flex-end' },
  toggleKnobOff: { alignSelf: 'flex-start' },
  // ---- Setting group (toggle + stepper card) ----
  // Wraps a toggle row + stepper row so they read as one "card". The
  // marginBottom here replaces the per-row marginBottom (which is removed
  // by toggleRowGrouped on the top row, and absent on StepperRow).
  settingGroup: {
    marginBottom: 16,
  },
  // ---- Stepper row (numeric parameter for the data-reduction filters) ----
  // Visually attaches to the toggle row above it: same horizontal padding,
  // same border, same background colour family (so when the toggle is on
  // the stepper inherits the light-blue tint), rounds only the BOTTOM
  // corners, no top border (the toggle row already drew it).
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderWidth: 1,
    borderTopWidth: 0,
    backgroundColor: '#F9FAFB',
    borderColor: COLOR.divider,
  },
  stepperBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: COLOR.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperBtnDisabled: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
  },
  stepperBtnText: {
    fontSize: 22,
    fontWeight: '700',
    color: COLOR.primary,
    lineHeight: 24,
    textAlign: 'center',
  },
  stepperBtnTextDisabled: {
    color: '#9CA3AF',
  },
  stepperValueWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  stepperLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: COLOR.secondary,
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  stepperValue: {
    fontSize: 22,
    fontWeight: '700',
    color: COLOR.primary,
    fontVariant: ['tabular-nums'],
  },
  stepperUnit: {
    fontSize: 13,
    fontWeight: '500',
    color: COLOR.secondary,
  },
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
  savedCard: {
    backgroundColor: COLOR.savedBg, borderRadius: 12, padding: 14,
    marginBottom: 16, borderWidth: 1, borderColor: COLOR.savedBorder,
  },
  savedTitle: {
    fontSize: 11, color: COLOR.savedText, letterSpacing: 1.5,
    fontWeight: '700', marginBottom: 6,
  },
  savedPath: {
    fontSize: 13, color: COLOR.savedText,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  // Final distance + pace line shown on the saved card. Slightly larger and
  // bolder than the path so the user notices it.
  savedDistance: {
    fontSize: 14,
    fontWeight: '700',
    color: COLOR.savedText,
    marginTop: 8,
    fontVariant: ['tabular-nums'],
  },
  errorCard: {
    backgroundColor: COLOR.errorBg, borderRadius: 12, padding: 14,
    marginBottom: 16, borderWidth: 1, borderColor: COLOR.errorBorder,
  },
  errorText: { color: COLOR.errorText, fontSize: 13 },
  // ---- Footer ----
  footerNote: { marginTop: 8 },
  footerText: {
    color: '#9CA3AF', fontSize: 12, lineHeight: 18, textAlign: 'center',
  },
});

export default App;
