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
 * Returns null if speed is missing or zero.
 */
function computeCurrentPace(speedMps: number | null | undefined): string | null {
  if (speedMps == null || speedMps <= 0.3) return null;  // ignore < 1 km/h (standing still)
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
  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const startTimeRef = useRef<number | null>(null);

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
        if (recordingState !== 'recording') {
          setCurrentSpeed(ev.speed);
        }
      }),
      subscribe('location', (ev: GpsLocationEvent) => {
        // Recording-time updates from the service.
        setPointCount(ev.pointCount);
        if (typeof ev.distance === 'number') setDistance(ev.distance);
        if (ev.fixType) setFixType(ev.fixType);
        if (ev.accuracy != null) setAccuracy(ev.accuracy);
        if (ev.speed != null) setCurrentSpeed(ev.speed);
        setHasFix(ev.fixType !== 'no fix');
      }),
      subscribe('duration', (ev) => {
        setElapsedMs(ev.elapsedMs);
        if (startTimeRef.current == null) {
          startTimeRef.current = Date.now() - ev.elapsedMs;
        }
      }),
      subscribe('state', (ev: GpsStateEvent) => {
        if (ev.isRecording) {
          setRecordingState('recording');
          setPointCount(ev.pointCount);
          setElapsedMs(ev.elapsedMs);
          startTimeRef.current = Date.now() - ev.elapsedMs;
        } else {
          setRecordingState('idle');
          setPointCount(0);
          setElapsedMs(0);
          setDistance(0);
          setCurrentSpeed(null);
          setFixType('no fix');
          setHasFix(false);
          startTimeRef.current = null;
        }
      }),
      subscribe('saved', (ev: GpsSavedEvent) => {
        setLastSavedPath(ev.filePath);
        setPointCount(0);
        setElapsedMs(0);
        setDistance(0);
        setCurrentSpeed(null);
        setFixType('no fix');
        setHasFix(false);
        setRecordingState('idle');
        startTimeRef.current = null;
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
  }, [syncStateFromNative, recordingState]);

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

  const distanceFmt = formatDistance(distance);
  const currentPace = computeCurrentPace(currentSpeed);
  const avgPace = computeAvgPace(elapsedMs, distance);

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

        {/* Primary stats: TIME, DISTANCE, PACE, AVG PACE */}
        <BigStat label="ВРЕМЯ" value={formatDuration(elapsedMs)} />
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
          <View style={[styles.statusDot, isRecording ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.statusText}>
            {isRecording ? 'ЗАПИСЬ' : isStopping ? 'ОСТАНОВКА…' : pointCount > 0 ? `${pointCount} ТОЧЕК` : 'ОЖИДАНИЕ'}
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
 */
function BigStat({
  label,
  value,
  unit,
  compact,
}: {
  label: string;
  value: string;
  unit?: string;
  compact?: boolean;
}): React.ReactElement {
  return (
    <View style={[styles.statBlock, compact ? styles.statBlockCompact : null]}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={styles.statValueRow}>
        <Text style={[styles.statValue, compact ? styles.statValueCompact : null]}>
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
  dotOn: { backgroundColor: COLOR.accentStop },
  dotOff: { backgroundColor: COLOR.gnssGray },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.secondary,
    letterSpacing: 1.5,
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
