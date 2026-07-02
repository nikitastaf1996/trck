/**
 * usePermissions — extracted from App.tsx (T2).
 *
 * Owns the location/notification permission state, the battery-optimization
 * exemption state, the permission-wait overlay state, and the three
 * permission-related handlers. App.tsx delegates to this hook so its own line
 * count stays manageable.
 *
 * Behavioural invariants preserved verbatim from the original inline code:
 *
 *   - U1: `waitingForPermissions` overlay is shown before requestPermissions()
 *     and cleared after the await resolves (whether granted or denied). The
 *     cancel button sets `cancelPermissionWaitRef.current = true` so handleStart
 *     (in App.tsx) can bail out instead of proceeding to startRecording.
 *   - U12: `hasAskedBatteryOptRef` ensures the battery-optimization system
 *     dialog only fires ONCE per app session. If the user denied it, a warning
 *     banner is shown; tapping it re-opens the dialog via `handleRetryBatteryOpt`
 *     (which does NOT reset `hasAskedBatteryOptRef`).
 *   - U23: `initialCheck` and `handleGrantPermissions` wait 800ms after
 *     `requestPermissions()` before re-checking, so the native side has time
 *     to settle the permission state.
 *   - `initialCheck` does NOT call `startGnssMonitor()` — the caller does that
 *     after `initialCheck` returns (per T2 spec, so the hook stays focused on
 *     permissions only). The caller uses the returned `granted` boolean to
 *     decide whether to start the monitor.
 *   - `handleGrantPermissions` DOES call `GpsRecorder.startGnssMonitor()`
 *     directly (preserving the original behaviour where the manual "grant
 *     permissions" button also starts the GNSS monitor once permissions are
 *     granted). It calls the raw `GpsRecorder.startGnssMonitor()` rather than
 *     `useGnssMonitor.startMonitor()` because this hook does not depend on
 *     `useGnssMonitor` — the two are independent. The underlying native call
 *     is identical.
 */

import { useCallback, useRef, useState } from 'react';
import { GpsRecorder } from '../NativeGpsRecorder';
import type { RecordingState } from '../styles';

export type UsePermissionsReturn = {
  // ---- 3 state vars ----
  hasPermissions: boolean;
  waitingForPermissions: boolean;
  batteryOptDenied: boolean;

  // ---- 2 refs ----
  cancelPermissionWaitRef: React.MutableRefObject<boolean>;
  hasAskedBatteryOptRef: React.MutableRefObject<boolean>;

  // ---- 3 setters (returned so App.tsx can call them from handleStart and
  //      the AppState listener — both of which stay in App.tsx). ----
  setHasPermissions: (g: boolean) => void;
  setWaitingForPermissions: (w: boolean) => void;
  setBatteryOptDenied: (d: boolean) => void;

  // ---- 3 handlers ----
  handleCancelPermissionWait: () => void;
  handleRetryBatteryOpt: () => Promise<void>;
  handleGrantPermissions: () => Promise<void>;

  // ---- one-shot permission check (replaces the mount effect's permission block) ----
  initialCheck: () => Promise<boolean>;
};

/**
 * @param _recordingStateRef  mirror of recordingState for use inside closures.
 *                             Currently unused inside this hook (the 'state'
 *                             event handler that resets hasFix/fixType stays
 *                             in App.tsx), but accepted per the T2 spec so the
 *                             hook signature matches the extraction plan and
 *                             future work can use it without changing the API.
 */
export function usePermissions(
  _recordingStateRef: React.MutableRefObject<RecordingState>,
): UsePermissionsReturn {
  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const [waitingForPermissions, setWaitingForPermissions] = useState<boolean>(false);
  const [batteryOptDenied, setBatteryOptDenied] = useState<boolean>(false);

  const cancelPermissionWaitRef = useRef<boolean>(false);
  const hasAskedBatteryOptRef = useRef<boolean>(false);

  // U1: cancel handler for the permission-wait overlay. Just sets a flag —
  // when requestPermissions() eventually resolves, handleStart (in App.tsx)
  // checks the flag and returns to idle without proceeding. (We can't actually
  // abort the native permission request, but we can ignore its result.)
  const handleCancelPermissionWait = useCallback(() => {
    cancelPermissionWaitRef.current = true;
    setWaitingForPermissions(false);
  }, []);

  // U12: manual retry for the battery-optimization exemption. Tapping the
  // warning banner re-opens the system dialog. We don't reset
  // hasAskedBatteryOptRef here — that would let a subsequent handleStart
  // auto-prompt again, which we explicitly don't want. This is purely a
  // manual retry path.
  const handleRetryBatteryOpt = useCallback(async () => {
    try {
      const granted = await GpsRecorder.requestIgnoreBatteryOptimizations();
      setBatteryOptDenied(!granted);
    } catch {
      setBatteryOptDenied(true);
    }
  }, []);

  // Manual "grant permissions" button handler (shown when hasPermissions is
  // false). Waits 800ms after requestPermissions() so the native side has
  // time to settle (U23), then re-checks. Also starts the GNSS monitor if
  // granted — preserving the original behaviour where pressing this button
  // both grants permissions AND kicks off the live GNSS status updates.
  const handleGrantPermissions = useCallback(async () => {
    await GpsRecorder.requestPermissions();
    // U23: wrap r in a 0-arg arrow so setTimeout's (...args: any[])=>void
    // type is satisfied under strict mode (r itself expects 1 arg).
    await new Promise<void>((r) => setTimeout(() => r(), 800));
    const granted = await GpsRecorder.hasPermissions();
    setHasPermissions(granted);
    if (granted) {
      try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
    }
  }, []);

  // One-shot permission check called from App.tsx's mount effect. Checks
  // hasPermissions(); if not granted, calls requestPermissions(), waits 800ms
  // (U23), and re-checks. Sets hasPermissions state. Returns the final
  // granted value so the caller can decide whether to start the GNSS monitor.
  //
  // Per T2 spec: does NOT call startGnssMonitor() — the caller does that
  // after this returns, so this hook stays focused on permissions only.
  //
  // Note: the original mount effect had a `mounted` guard between the
  // permission check and the setHasPermissions call. Since setHasPermissions
  // is now inside this hook (and the hook has no `mounted` flag), a
  // setState-after-unmount would only produce a dev-mode console warning
  // (not a crash), consistent with the T1 useSettings.loadSettings pattern.
  const initialCheck = useCallback(async (): Promise<boolean> => {
    let granted = await GpsRecorder.hasPermissions();
    if (!granted) {
      await GpsRecorder.requestPermissions();
      // U23: wrap r in a 0-arg arrow so setTimeout's (...args: any[])=>void
      // type is satisfied under strict mode (r itself expects 1 arg).
      await new Promise<void>((r) => setTimeout(() => r(), 800));
      granted = await GpsRecorder.hasPermissions();
    }
    setHasPermissions(granted);
    return granted;
  }, []);

  return {
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
  };
}
