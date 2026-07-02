/**
 * useGnssMonitor — extracted from App.tsx (T2).
 *
 * Owns the 5 GNSS status state vars (fixType, accuracy, satellitesUsed,
 * satellitesInView, hasFix) and the start/stop wrappers for the native
 * GnssMonitor. App.tsx delegates to this hook so its own line count stays
 * manageable.
 *
 * Behavioural invariants preserved verbatim from the original inline code:
 *
 *   - The 5 state vars are updated together from 'gnss' events via
 *     `handleGnssEvent(ev)` (which sets all 5 in one call).
 *   - `resetGnss()` clears fixType / hasFix / accuracy when recording stops
 *     (called from App.tsx's 'state' event handler when
 *     ev.isRecording === false). Note: this also clears accuracy, which the
 *     original 'state' handler did NOT do — clearing accuracy when there's
 *     "no fix" is more correct and matches the T2 spec for resetGnss.
 *   - `startMonitor()` / `stopMonitor()` are thin wrappers around
 *     GpsRecorder.startGnssMonitor() / stopGnssMonitor(). They're stable
 *     useCallbacks so they can be listed in effect deps without causing
 *     re-runs.
 *   - The individual setters (setFixType, setAccuracy, setHasFix) are also
 *     returned so App.tsx's 'location' event handler, 'saved' event handler,
 *     and syncStateFromNative() can update individual fields without going
 *     through handleGnssEvent (which expects a full GpsGnssEvent and sets
 *     ALL 5 fields, including satellitesUsed / satellitesInView which the
 *     'location' / 'saved' / syncStateFromNative paths must NOT touch).
 */

import { useCallback, useState } from 'react';
import {
  GpsRecorder,
  type GpsFixType,
  type GpsGnssEvent,
} from '../NativeGpsRecorder';
import type { RecordingState } from '../styles';

export type UseGnssMonitorReturn = {
  // ---- 5 state vars ----
  fixType: GpsFixType;
  accuracy: number | null;
  satellitesUsed: number;
  satellitesInView: number;
  hasFix: boolean;

  // ---- 3 individual setters ----
  // Returned so App.tsx's 'location' handler, 'saved' handler, and
  // syncStateFromNative() can update individual GNSS fields. The 'gnss'
  // event handler uses handleGnssEvent (which sets all 5 at once); the
  // 'state' event handler uses resetGnss (which resets 3). But the
  // 'location' / 'saved' / syncStateFromNative paths only update a SUBSET
  // of the fields, so they need the individual setters.
  setFixType: (f: GpsFixType) => void;
  setAccuracy: (a: number | null) => void;
  setHasFix: (h: boolean) => void;

  // ---- 4 methods ----
  handleGnssEvent: (ev: GpsGnssEvent) => void;
  resetGnss: () => void;
  startMonitor: () => Promise<boolean>;
  stopMonitor: () => Promise<boolean>;
};

/**
 * @param _recordingStateRef  mirror of recordingState for use inside closures.
 *                             Currently unused inside this hook (the 'gnss'
 *                             event handler's recording-gated speed-pushing
 *                             logic stays in App.tsx because it reads
 *                             recordingStateRef + recentSpeedsRef), but
 *                             accepted per the T2 spec so the hook signature
 *                             matches the extraction plan.
 */
export function useGnssMonitor(
  _recordingStateRef: React.MutableRefObject<RecordingState>,
): UseGnssMonitorReturn {
  const [fixType, setFixType] = useState<GpsFixType>('no fix');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [satellitesUsed, setSatellitesUsed] = useState<number>(0);
  const [satellitesInView, setSatellitesInView] = useState<number>(0);
  const [hasFix, setHasFix] = useState<boolean>(false);

  // Processes a 'gnss' event by updating all 5 state vars together. Called
  // from App.tsx's mount-effect 'gnss' subscription. The speed-pushing logic
  // (U4: push GNSS speed into the smoothing window only when NOT recording)
  // stays in App.tsx because it reads recordingStateRef + recentSpeedsRef.
  const handleGnssEvent = useCallback((ev: GpsGnssEvent) => {
    setFixType(ev.fixType);
    setAccuracy(ev.accuracy);
    setSatellitesUsed(ev.satellitesUsed);
    setSatellitesInView(ev.satellitesInView);
    setHasFix(ev.hasFix);
  }, []);

  // Resets fixType / hasFix / accuracy when recording stops. Called from
  // App.tsx's 'state' event handler (when ev.isRecording === false).
  // Note: this also clears accuracy, which the original 'state' handler did
  // NOT do (it only cleared fixType + hasFix). Clearing accuracy when there's
  // "no fix" is more correct and matches the T2 spec for resetGnss.
  const resetGnss = useCallback(() => {
    setFixType('no fix');
    setHasFix(false);
    setAccuracy(null);
  }, []);

  // Thin wrappers around the native start/stop calls. Stable useCallbacks
  // so they can be listed in effect deps without causing re-runs.
  const startMonitor = useCallback(() => GpsRecorder.startGnssMonitor(), []);
  const stopMonitor = useCallback(() => GpsRecorder.stopGnssMonitor(), []);

  return {
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
  };
}
