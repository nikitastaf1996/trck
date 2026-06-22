/**
 * GPS Recorder
 *
 * A no-frills GPS recording app:
 *   - Big Start / Stop button
 *   - Duration of recording
 *   - Live GPS fix info (lat / lon / accuracy / speed)
 *   - Number of points recorded
 *   - Path to the saved GPX file
 *
 * Stability / lifecycle behaviour:
 *   - Recording is owned by a native foreground service (GpsRecorderService.kt).
 *   - The service survives: app being backgrounded, app being swiped away from recents,
 *     the screen turning off, and (best-effort) the system killing the process for memory.
 *   - The service is START_STICKY so the system will restart it if it has to kill it.
 *   - A partial wake lock keeps the CPU awake so we keep getting GPS fixes while the
 *     screen is off.
 *   - Points are flushed to a temp file every 5 seconds, so a crash mid-recording still
 *     yields a usable (partial) GPX file.
 *   - The notification has a "Stop" action so the user can stop recording without ever
 *     opening the app again.
 *   - The JS side is purely informational; if the JS thread dies, recording continues.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Alert,
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
} from './src/NativeGpsRecorder';

type RecordingState = 'idle' | 'recording' | 'stopping';

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function App(): React.ReactElement {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [pointCount, setPointCount] = useState<number>(0);
  const [lastFix, setLastFix] = useState<GpsLocationEvent | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const startTimeRef = useRef<number | null>(null);

  // On mount: check permissions + sync UI with whatever the service is doing
  // (in case the app was killed and reopened while recording was still active).
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const granted = await GpsRecorder.hasPermissions();
        if (!mounted) return;
        setHasPermissions(granted);

        const isRec = await GpsRecorder.isRecording();
        if (!mounted) return;
        if (isRec) {
          setRecordingState('recording');
        }
      } catch (e) {
        // ignore
      }
    })();

    // Subscriptions
    const subs = [
      subscribe('location', (ev: GpsLocationEvent) => {
        setLastFix(ev);
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
          startTimeRef.current = null;
        }
      }),
      subscribe('saved', (ev: GpsSavedEvent) => {
        setLastSavedPath(ev.filePath);
        setPointCount(0);
        setElapsedMs(0);
        setRecordingState('idle');
        startTimeRef.current = null;
      }),
      subscribe('error', (ev) => {
        setErrorMsg(ev.message);
        // An error during recording usually means the service stopped itself.
        setRecordingState('idle');
      }),
    ];

    // If the app is launched fresh while a recording is in progress, our local
    // 'elapsedMs' state will be stale until the next duration tick (1s). Listen for
    // AppState changes and re-sync if we come back to the foreground.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        GpsRecorder.isRecording().then((rec) => {
          if (rec) setRecordingState('recording');
        });
        GpsRecorder.hasPermissions().then(setHasPermissions);
      }
    });

    return () => {
      mounted = false;
      subs.forEach((s) => s.remove());
      sub.remove();
    };
  }, []);

  const handleStart = useCallback(async () => {
    setErrorMsg(null);
    try {
      let granted = await GpsRecorder.hasPermissions();
      if (!granted) {
        granted = await GpsRecorder.requestPermissions();
        // requestPermissions returns whether permissions are already granted; the actual
        // dialog is async. We'll re-check in a moment.
        setTimeout(async () => {
          const ok = await GpsRecorder.hasPermissions();
          setHasPermissions(ok);
        }, 500);
      }
      setHasPermissions(granted);
      if (!granted) {
        // Still let the user try; the service will emit an 'error' event if it can't start.
        // This way they see a clear error message.
      }

      // Best-effort: ask the user to disable battery optimizations. If they decline,
      // recording still works, it's just less reliable on some devices during Doze.
      try {
        await GpsRecorder.requestIgnoreBatteryOptimizations();
      } catch {
        // ignore
      }

      setElapsedMs(0);
      setPointCount(0);
      setLastFix(null);
      setLastSavedPath(null);
      startTimeRef.current = Date.now();

      await GpsRecorder.start();
      setRecordingState('recording');
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setRecordingState('idle');
    }
  }, []);

  const handleStop = useCallback(async () => {
    setErrorMsg(null);
    setRecordingState('stopping');
    try {
      await GpsRecorder.stop();
      // The 'saved' event will set recordingState back to 'idle' and update lastSavedPath.
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setRecordingState('recording');
    }
  }, []);

  const handleGrantPermissions = useCallback(async () => {
    await GpsRecorder.requestPermissions();
    setTimeout(async () => {
      setHasPermissions(await GpsRecorder.hasPermissions());
    }, 500);
  }, []);

  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#0F172A" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>GPS Recorder</Text>
          <Text style={styles.headerSubtitle}>
            Background GPX recorder · foreground service
          </Text>
        </View>

        <View style={styles.durationCard}>
          <Text style={styles.durationLabel}>DURATION</Text>
          <Text style={styles.durationValue}>{formatDuration(elapsedMs)}</Text>
          <View style={[styles.statusPill, isRecording ? styles.statusPillOn : styles.statusPillOff]}>
            <View style={[styles.statusDot, isRecording ? styles.dotOn : styles.dotOff]} />
            <Text style={styles.statusText}>
              {isRecording ? 'RECORDING' : isStopping ? 'STOPPING…' : 'IDLE'}
            </Text>
          </View>
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.bigButton,
            isRecording ? styles.bigButtonStop : styles.bigButtonStart,
            (pressed || isStopping) && styles.bigButtonPressed,
            isStopping && styles.bigButtonStopping,
          ]}
          onPress={isRecording ? handleStop : handleStart}
          disabled={isStopping}
          android_ripple={{ color: 'rgba(255,255,255,0.15)', radius: 200 }}
        >
          <Text style={styles.bigButtonText}>
            {isStopping ? 'STOPPING…' : isRecording ? 'STOP' : 'START'}
          </Text>
        </Pressable>

        {!hasPermissions && (
          <Pressable style={styles.permissionButton} onPress={handleGrantPermissions}>
            <Text style={styles.permissionButtonText}>
              Grant location &amp; notification permissions
            </Text>
          </Pressable>
        )}

        <View style={styles.statsGrid}>
          <StatCard label="POINTS" value={String(pointCount)} />
          <StatCard
            label="ACCURACY"
            value={lastFix?.accuracy != null ? `${lastFix.accuracy.toFixed(0)} m` : '—'}
          />
          <StatCard
            label="SPEED"
            value={
              lastFix?.speed != null
                ? `${(lastFix.speed * 3.6).toFixed(1)} km/h`
                : '—'
            }
          />
        </View>

        {lastFix && (
          <View style={styles.fixCard}>
            <Text style={styles.fixTitle}>LATEST FIX</Text>
            <Text style={styles.fixLine}>
              <Text style={styles.fixLabel}>Lat </Text>
              {lastFix.lat.toFixed(6)}
            </Text>
            <Text style={styles.fixLine}>
              <Text style={styles.fixLabel}>Lon </Text>
              {lastFix.lon.toFixed(6)}
            </Text>
            {lastFix.alt != null && (
              <Text style={styles.fixLine}>
                <Text style={styles.fixLabel}>Alt </Text>
                {lastFix.alt.toFixed(1)} m
              </Text>
            )}
            <Text style={styles.fixLine}>
              <Text style={styles.fixLabel}>Time </Text>
              {new Date(lastFix.timestamp).toLocaleTimeString()}
            </Text>
          </View>
        )}

        {lastSavedPath && (
          <View style={styles.savedCard}>
            <Text style={styles.savedTitle}>GPX SAVED</Text>
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
            Recording runs in a foreground service and keeps going when the app is
            backgrounded or swiped away. Stop it from the notification or this button.
            GPX files are written to the public Downloads/GpsRecorder folder.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 60,
  },
  header: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 24,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#F8FAFC',
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#94A3B8',
    marginTop: 4,
  },
  durationCard: {
    alignItems: 'center',
    marginBottom: 24,
  },
  durationLabel: {
    fontSize: 12,
    color: '#64748B',
    letterSpacing: 2,
    fontWeight: '600',
  },
  durationValue: {
    fontSize: 64,
    color: '#F8FAFC',
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
    marginVertical: 4,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginTop: 8,
  },
  statusPillOn: {
    backgroundColor: 'rgba(34, 197, 94, 0.18)',
  },
  statusPillOff: {
    backgroundColor: 'rgba(148, 163, 184, 0.15)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  dotOn: {
    backgroundColor: '#22C55E',
  },
  dotOff: {
    backgroundColor: '#64748B',
  },
  statusText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  bigButton: {
    height: 220,
    borderRadius: 110,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 16,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  bigButtonStart: {
    backgroundColor: '#22C55E',
  },
  bigButtonStop: {
    backgroundColor: '#EF4444',
  },
  bigButtonPressed: {
    transform: [{ scale: 0.98 }],
  },
  bigButtonStopping: {
    backgroundColor: '#64748B',
  },
  bigButtonText: {
    color: '#FFFFFF',
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: 4,
  },
  permissionButton: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  permissionButtonText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '600',
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 10,
    color: '#64748B',
    letterSpacing: 1.5,
    fontWeight: '600',
  },
  statValue: {
    fontSize: 20,
    color: '#F8FAFC',
    fontWeight: '600',
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  fixCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  fixTitle: {
    fontSize: 11,
    color: '#64748B',
    letterSpacing: 1.5,
    fontWeight: '700',
    marginBottom: 8,
  },
  fixLine: {
    fontSize: 14,
    color: '#E2E8F0',
    marginVertical: 2,
    fontVariant: ['tabular-nums'],
  },
  fixLabel: {
    color: '#64748B',
    fontWeight: '600',
  },
  savedCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  savedTitle: {
    fontSize: 11,
    color: '#22C55E',
    letterSpacing: 1.5,
    fontWeight: '700',
    marginBottom: 6,
  },
  savedPath: {
    fontSize: 13,
    color: '#E2E8F0',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  errorCard: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: 13,
  },
  footerNote: {
    marginTop: 8,
  },
  footerText: {
    color: '#475569',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});

export default App;
