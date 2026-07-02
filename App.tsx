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
 * Stability / lifecycle: recording is owned by a native foreground service
 * (GpsRecorderService.kt) that survives backgrounding, swipe-away, screen-off,
 * and (best effort) memory kills. START_STICKY + PARTIAL_WAKE_LOCK. Points are
 * flushed to a temp file every 5 s. The JS side is purely informational.
 *
 * Architecture (T1 / T2 / T4): the original monolithic App.tsx (~1100 lines)
 * is split into four focused hooks (useSettings, usePermissions,
 * useGnssMonitor, useRecordingSession). App.tsx owns only: recordingState +
 * recordingStateRef (lifted out of useRecordingSession so settingsLocked can be
 * computed BEFORE useSettings — see the "Call-order note" in
 * useRecordingSession), errorMsg, the mount effect ('gnss' subscription +
 * AppState listener), and the JSX. The other 5 event subscriptions and the
 * 2-second polling effect live inside useRecordingSession.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  View,
} from 'react-native';
import {
  GpsRecorder,
  subscribe,
  isNativeModuleAvailable,
  type GpsGnssEvent,
} from './src/NativeGpsRecorder';
// O19: react-native-safe-area-context (the built-in SafeAreaView is
// unreliable on Android notches).
import { SafeAreaView } from 'react-native-safe-area-context';
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
import { appStyles as styles } from './src/styles/appStyles';
// T1/T2/T4: four focused hooks own disjoint slices of the original monolithic
// App.tsx state machine. See individual hook files for what each owns.
import { useSettings } from './src/hooks/useSettings';
import { usePermissions } from './src/hooks/usePermissions';
import { useGnssMonitor } from './src/hooks/useGnssMonitor';
import { useRecordingSession } from './src/hooks/useRecordingSession';

function App(): React.ReactElement {
  // recordingState + recordingStateRef are owned by App.tsx (NOT
  // useRecordingSession) so settingsLocked can be computed BEFORE useSettings
  // — see useRecordingSession's "Call-order note". U18: the ref is updated
  // SYNCHRONOUSLY by useRecordingSession so the 'gnss' subscription below
  // reads the right value.
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const recordingStateRef = useRef<RecordingState>('idle');

  // errorMsg stays in App.tsx — shared by useSettings, useRecordingSession,
  // and ErrorCard.
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';
  // Locked (read-only) while recording so toggling them mid-recording can't
  // change the filter / smoothing behaviour halfway through.
  const settingsLocked = isRecording || isStopping;

  // useSettings: 11 settings + 3 mirror refs + 10 handlers + loadSettings.
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

  // usePermissions: 3 state + 2 refs + 3 setters + 3 handlers + initialCheck.
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

  // useGnssMonitor: 5 GNSS state + 3 setters + 4 methods.
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

  // useRecordingSession: recording state machine + 5 subscriptions + 2-second
  // polling + handleStart / handleStop / syncStateFromNative + pushIdleSpeed
  // (called by App.tsx's 'gnss' subscription when not recording).
  const {
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
  } = useRecordingSession({
    recordingState,
    setRecordingState,
    recordingStateRef,
    hasPermissions,
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
  });

  // Mount effect: 'gnss' subscription + AppState listener. The other 5
  // subscriptions and the 2-second polling are owned by useRecordingSession.
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const granted = await initialCheck(); // T2: + 800ms wait (U23)
        if (!mounted) return;
        await loadSettings(); // T1: load all 11 settings from native prefs.
        // Start the always-on GNSS monitor so the UI shows fix status even
        // before recording starts.
        if (granted) {
          try { await startMonitor(); } catch { /* ignore */ }
        }
        await syncStateFromNative();
      } catch {
        // ignore
      }
    })();

    const subs = [
      subscribe('gnss', (ev: GpsGnssEvent) => {
        handleGnssEvent(ev);
        // U4: while NOT recording, push the GNSS speed into the smoothing
        // window (so the pace display is smoothed). While recording, the
        // 'location' event is the source of truth — we DON'T push gnss
        // speeds then to avoid double-counting.
        if (recordingStateRef.current !== 'recording') {
          pushIdleSpeed(ev.speed);
        }
      }),
    ];

    // Re-sync when coming back to foreground.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncStateFromNative();
        // U6: .catch() so an unhandled promise rejection doesn't fire if
        // hasPermissions() throws during cold start.
        GpsRecorder.hasPermissions().then(async (g) => {
          setHasPermissions(g);
          if (g) {
            try { await startMonitor(); } catch { /* ignore */ }
          }
        }).catch(() => { /* will retry on next AppState change */ });
      }
    });

    return () => {
      mounted = false;
      subs.forEach((s) => s.remove());
      appStateSub.remove();
      // U6: stopMonitor() returns a Promise — use .catch() (try/catch won't
      // catch async rejections).
      stopMonitor().catch(() => { /* ignore */ });
    };
  }, [
    syncStateFromNative,
    pushIdleSpeed,
    // T1+T2+T4: all stable — listed only to satisfy exhaustive-deps.
    loadSettings,
    initialCheck,
    startMonitor,
    stopMonitor,
    handleGnssEvent,
    setHasPermissions,
    recordingStateRef,
    recentSpeedsRef,
  ]); // NOTE: recordingState intentionally omitted — see recordingStateRef.

  // O14: if the native module is not loaded, the fallback object makes every
  // method a no-op. All hooks above run unconditionally so this is safe.
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

        {/* Settings section header + "locked" notice */}
        <View style={styles.settingsHeader}>
          <Text style={styles.settingsHeaderText}>НАСТРОЙКИ</Text>
          {settingsLocked && (
            <Text style={styles.settingsLockedBadge}>
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

        {/* ---- Three data-reduction filters (user-requested) ----
            Each has an enabled toggle + numeric param, all locked while
            recording (settingsLocked). Steppers are disabled when the toggle
            is off OR settings are locked. */}

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
        />
        {/* CODE_REVIEW_TODO Task 3: over-filter warning — informational only,
            does NOT block enabling all three. */}
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

export default App;
