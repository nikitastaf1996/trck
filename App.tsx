/**
 * trck — a no-frills GPS recorder for runners.
 *
 * UI: large centered numbers, generous whitespace, one accent color.
 *   - Big circular START / STOP button at the bottom
 *   - Pre-recording GNSS status pill (always visible, updates live)
 *   - TIME · DISTANCE · PACE · AVG PACE
 *   - Saved-file card when a recording finishes
 *
 * Stability / lifecycle: recording is owned by a native foreground service
 * (GpsRecorderService.kt) that survives backgrounding, swipe-away, screen-
 * off, and (best effort) memory kills. START_STICKY + PARTIAL_WAKE_LOCK.
 * Points are flushed to a temp file every 5 s. The JS side is reactive
 * over the recording store — events drive the store, selectors drive the
 * UI.
 *
 * Architecture (v1.4.0): all JS-side state lives in two Zustand stores
 * (src/store/). App.tsx is purely wiring:
 *   - mount effect: initial permission check, load settings, start the
 *     GNSS monitor, sync state from native, subscribe to all 6 native
 *     events, AppState listener for foreground re-sync, 2 s recording-
 *     gated poll.
 *   - JSX: selectors feed the presentational components.
 * There are no hooks, no mirror refs, no forceRerender, no 19-param
 * factory functions. The store is the single source of truth — event
 * handlers read `useRecordingStore.getState()` at call time, which is
 * always fresh.
 */

import React, { useEffect } from 'react';
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
  isNativeModuleAvailable,
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
} from './src/styles';
import { appStyles as styles } from './src/styles/appStyles';
import {
  useRecordingStore,
  subscribeAllNativeEvents,
} from './src/store/recordingStore';
import {
  useSettingsStore,
  useSettingsLocked,
} from './src/store/settingsStore';

function App(): React.ReactElement {
  // ---- Recording store selectors ----
  const recordingState = useRecordingStore((s) => s.recordingState);
  const elapsedMs = useRecordingStore((s) => s.elapsedMs);
  const distance = useRecordingStore((s) => s.distance);
  const currentSpeed = useRecordingStore((s) => s.currentSpeed);
  const isAutoPaused = useRecordingStore((s) => s.isAutoPaused);
  const signalLost = useRecordingStore((s) => s.signalLost);
  const movingMs = useRecordingStore((s) => s.movingMs);
  const recentSpeeds = useRecordingStore((s) => s.recentSpeeds);

  const fixType = useRecordingStore((s) => s.fixType);
  const accuracy = useRecordingStore((s) => s.accuracy);
  const satellitesUsed = useRecordingStore((s) => s.satellitesUsed);
  const satellitesInView = useRecordingStore((s) => s.satellitesInView);
  const hasFix = useRecordingStore((s) => s.hasFix);

  const hasPermissions = useRecordingStore((s) => s.hasPermissions);
  const waitingForPermissions = useRecordingStore((s) => s.waitingForPermissions);
  const batteryOptDenied = useRecordingStore((s) => s.batteryOptDenied);

  const lastSavedPath = useRecordingStore((s) => s.lastSavedPath);
  const lastSavedDistance = useRecordingStore((s) => s.lastSavedDistance);
  const lastSavedMovingMs = useRecordingStore((s) => s.lastSavedMovingMs);
  const lastSavedElapsedMs = useRecordingStore((s) => s.lastSavedElapsedMs);
  const lastSavedSettings = useRecordingStore((s) => s.lastSavedSettings);

  const errorMsg = useRecordingStore((s) => s.errorMsg);

  // ---- Settings store selectors ----
  const postProcessEnabled = useSettingsStore((s) => s.postProcessEnabled);
  const gaussianSmoothingEnabled = useSettingsStore((s) => s.gaussianSmoothingEnabled);
  const autoPauseEnabled = useSettingsStore((s) => s.autoPauseEnabled);
  const gapDetectionEnabled = useSettingsStore((s) => s.gapDetectionEnabled);
  const showMovingTime = useSettingsStore((s) => s.showMovingTime);
  const radialDistanceFilterEnabled = useSettingsStore((s) => s.radialDistanceFilterEnabled);
  const radialDistanceThresholdM = useSettingsStore((s) => s.radialDistanceThresholdM);
  const timeSamplingEnabled = useSettingsStore((s) => s.timeSamplingEnabled);
  const timeSamplingN = useSettingsStore((s) => s.timeSamplingN);
  const douglasPeuckerEnabled = useSettingsStore((s) => s.douglasPeuckerEnabled);
  const douglasPeuckerEpsilonM = useSettingsStore((s) => s.douglasPeuckerEpsilonM);

  // Derived.
  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';
  const settingsLocked = useSettingsLocked();

  // ---- Mount effect: subscribe to events, sync state, AppState listener ----
  // Subscriptions are set up ONCE; handlers read fresh state from the store
  // via getState(), so they don't need to be torn down and recreated when
  // state changes. (The previous design's mirror refs existed precisely to
  // work around this — they're gone now.)
  useEffect(() => {
    let mounted = true;
    const recordingStore = useRecordingStore;
    const settingsStore = useSettingsStore;

    (async () => {
      try {
        const granted = await recordingStore.getState().initialPermissionCheck();
        if (!mounted) return;
        await settingsStore.getState().loadAll();
        if (granted) {
          try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
        }
        // Initial sync from native (covers the START_STICKY recovery case
        // where the service is already recording when JS launches).
        try {
          const state = await GpsRecorder.getState();
          recordingStore.getState().syncFromNative(state);
        } catch { /* ignore */ }
      } catch {
        // ignore
      }
    })();

    // Subscribe to all 6 native events once. Each handler dispatches into
    // the recording store.
    const subs = subscribeAllNativeEvents();

    // Re-sync when coming back to foreground.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        GpsRecorder.getState()
          .then((s) => recordingStore.getState().syncFromNative(s))
          .catch(() => { /* will retry on next AppState change */ });
        GpsRecorder.hasPermissions()
          .then((g) => {
            recordingStore.getState().setHasPermissions(g);
            if (g) {
              GpsRecorder.startGnssMonitor().catch(() => { /* ignore */ });
            }
          })
          .catch(() => { /* will retry on next AppState change */ });
      }
    });

    return () => {
      mounted = false;
      subs.remove();
      appStateSub.remove();
      GpsRecorder.stopGnssMonitor().catch(() => { /* ignore */ });
    };
  }, []);

  // ---- 2-second recording-gated polling ----
  // Fallback for when events are dropped (JS backgrounded, bridge stalled).
  // Only polls while a recording is in progress — no need to cross the
  // bridge every 2 s while the user is just looking at the idle screen.
  useEffect(() => {
    if (recordingState !== 'recording') return;
    const id = setInterval(() => {
      GpsRecorder.getState()
        .then((s) => useRecordingStore.getState().syncFromNative(s))
        .catch(() => { /* ignore — will retry next tick */ });
    }, 2000);
    return () => clearInterval(id);
  }, [recordingState]);

  // ---- Native-module-missing fallback ----
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
          recentSpeeds={recentSpeeds}
        />

        {batteryOptDenied && !isRecording && !isStopping && (
          <BatteryOptBanner
            onPress={() => {
              useRecordingStore.getState().handleRetryBatteryOpt();
            }}
          />
        )}

        <StartStopButton
          recordingState={recordingState}
          onStart={() => {
            useRecordingStore.getState().handleStart().then(({ granted }) => {
              if (granted) {
                GpsRecorder.startGnssMonitor().catch(() => { /* ignore */ });
              }
            });
          }}
          onStop={() => {
            useRecordingStore.getState().handleStop();
          }}
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
          onPress={() => useSettingsStore.getState().toggle('postProcessEnabled')}
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
          onPress={() => useSettingsStore.getState().toggle('gaussianSmoothingEnabled')}
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
          onPress={() => useSettingsStore.getState().toggle('autoPauseEnabled')}
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
          onPress={() => useSettingsStore.getState().toggle('gapDetectionEnabled')}
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
          onPress={() => useSettingsStore.getState().toggle('showMovingTime')}
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
          onToggle={() => useSettingsStore.getState().toggle('radialDistanceFilterEnabled')}
          stepperLabel="Мин. расстояние"
          stepperValue={radialDistanceThresholdM}
          stepperUnit="м"
          stepperMin={0}
          stepperMax={1000}
          onDecrement={() => useSettingsStore.getState().step('radialDistanceThresholdM', -1)}
          onIncrement={() => useSettingsStore.getState().step('radialDistanceThresholdM', +1)}
          settingsLocked={settingsLocked}
        />

        <FilterSettingGroup
          title="Децимация по времени (на лету)"
          subtitleOn={`Включена: сохраняется каждая ${timeSamplingN}-я точка (≈ раз в ${timeSamplingN} с при 1 Гц)`}
          subtitleOff="Выключена: сохраняются все принятые точки"
          value={timeSamplingEnabled}
          onToggle={() => useSettingsStore.getState().toggle('timeSamplingEnabled')}
          stepperLabel="Шаг N"
          stepperValue={timeSamplingN}
          stepperUnit={pluralRu(timeSamplingN, ['точка', 'точки', 'точек'])}
          stepperMin={1}
          stepperMax={60}
          onDecrement={() => useSettingsStore.getState().step('timeSamplingN', -1)}
          onIncrement={() => useSettingsStore.getState().step('timeSamplingN', +1)}
          settingsLocked={settingsLocked}
        />

        <FilterSettingGroup
          title="Douglas-Peucker (постобработка)"
          subtitleOn={`Включён: трек упрощается, точки ближе ${douglasPeuckerEpsilonM} м от линии сегмента удаляются`}
          subtitleOff="Выключен: GPX сохраняется как есть, без финального упрощения"
          value={douglasPeuckerEnabled}
          onToggle={() => useSettingsStore.getState().toggle('douglasPeuckerEnabled')}
          stepperLabel="Эпсилон (допуск)"
          stepperValue={douglasPeuckerEpsilonM}
          stepperUnit="м"
          stepperMin={0}
          stepperMax={500}
          onDecrement={() => useSettingsStore.getState().step('douglasPeuckerEpsilonM', -1)}
          onIncrement={() => useSettingsStore.getState().step('douglasPeuckerEpsilonM', +1)}
          settingsLocked={settingsLocked}
        />
        {/* Over-filter warning — informational only, does NOT block
            enabling all three. */}
        {radialDistanceFilterEnabled &&
          timeSamplingEnabled &&
          douglasPeuckerEnabled && <OverFilterWarning />}

        {!hasPermissions && (
          <Pressable
            style={styles.permissionButton}
            onPress={() => {
              useRecordingStore.getState().handleGrantPermissions();
            }}
          >
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
            onDismiss={() => useRecordingStore.getState().dismissSavedCard()}
          />
        )}

        {errorMsg && (
          <ErrorCard
            message={errorMsg}
            hasPermissions={hasPermissions}
            onDismiss={() => useRecordingStore.getState().dismissError()}
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
        onCancel={() => useRecordingStore.getState().handleCancelPermissionWait()}
      />

      <StopOverlay visible={isStopping} />
    </SafeAreaView>
  );
}

export default App;
