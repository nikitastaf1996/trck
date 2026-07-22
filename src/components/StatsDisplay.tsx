/**
 * StatsDisplay — the primary stats block (TIME / DISTANCE / TEMPO / AVG
// TEMPO) + status row. Extracted from App.tsx.
 *
 * O7 / O24 refactor: this is the most-stateful presentational cluster,
 * consuming ~10 props from the parent. The parent still owns all the
 * state (recordingState, elapsedMs, distance, currentSpeed, movingMs,
 * autoPauseEnabled, etc.) — this component just renders them.
 *
 * The smoothed-speed derivation (5-fix window average) lives here now
 * so the parent doesn't have to compute it. The `recentSpeedsRef` is
 * passed in as a Ref<number[]>; the parent mutates it in-place and
 * forces a re-render via useReducer when it changes.
 *
 * The status row text mapping (5-way ternary: АВТОПАУЗА / НЕТ СИГНАЛА /
 * ЗАПИСЬ / ОСТАНОВКА… / ОЖИДАНИЕ) is extracted as a standalone exported
 * function `getStatusText` so it can be unit-tested.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BigStat } from './BigStat';
import { Divider } from './Divider';
import { PauseBadge } from './Banners';
import {
  COLOR,
  formatDuration,
  formatDistance,
  computeAvgPace,
  computeCurrentPace,
  type RecordingState,
} from '../styles';

export interface StatsDisplayProps {
  recordingState: RecordingState;
  elapsedMs: number;
  movingMs: number;
  distance: number;
  currentSpeed: number | null;
  isAutoPaused: boolean;
  signalLost: boolean;
  showMovingTime: boolean;
  autoPauseEnabled: boolean;
  gapDetectionEnabled: boolean;
  /** Sliding window of recent GPS speeds for smoothed pace display. */
  recentSpeeds: number[];
}

/**
 * Returns the user-facing status row text given the current state.
 * Pure function — exported for unit testing.
 *
 * Priority order (highest first):
 *   1. isAutoPaused → 'АВТОПАУЗА'
 *   2. signalLost   → 'НЕТ СИГНАЛА'
 *   3. isRecording  → 'ЗАПИСЬ'
 *   4. isStopping   → 'ОСТАНОВКА…'
 *   5. else         → 'ОЖИДАНИЕ'
 */
export function getStatusText(
  isAutoPaused: boolean,
  signalLost: boolean,
  isRecording: boolean,
  isStopping: boolean,
): string {
  if (isAutoPaused) return 'АВТОПАУЗА';
  if (signalLost) return 'НЕТ СИГНАЛА';
  if (isRecording) return 'ЗАПИСЬ';
  if (isStopping) return 'ОСТАНОВКА…';
  return 'ОЖИДАНИЕ';
}

/**
 * Selects which time base to use for the avg pace computation.
 * Mirrors the logic in the original App.tsx (lines 1031-1033) and is
 * the same logic used by SavedCard.selectPaceTimeMs.
 */
export function selectPaceTimeMs(
  showMovingTime: boolean,
  autoPauseEnabled: boolean,
  gapDetectionEnabled: boolean,
  movingMs: number,
  elapsedMs: number,
): number {
  return (showMovingTime || autoPauseEnabled || gapDetectionEnabled)
    ? movingMs
    : elapsedMs;
}

export function StatsDisplay({
  recordingState,
  elapsedMs,
  movingMs,
  distance,
  currentSpeed,
  isAutoPaused,
  signalLost,
  showMovingTime,
  autoPauseEnabled,
  gapDetectionEnabled,
  recentSpeeds,
}: StatsDisplayProps): React.ReactElement {
  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';

  const distanceFmt = formatDistance(distance);

  // Smoothed current pace: average of the last few GPS speeds.
  // The window is owned by the recording store (replaced immutably on
  // each push), so this re-runs whenever it changes — no forceRerender
  // needed.
  const smoothedSpeed = (() => {
    if (isAutoPaused) return null;
    if (recentSpeeds.length > 0) {
      const sum = recentSpeeds.reduce((a, b) => a + b, 0);
      return sum / recentSpeeds.length;
    }
    return currentSpeed;
  })();
  const currentPace = computeCurrentPace(smoothedSpeed);

  const paceTimeMs = selectPaceTimeMs(
    showMovingTime, autoPauseEnabled, gapDetectionEnabled, movingMs, elapsedMs,
  );
  const avgPace = computeAvgPace(paceTimeMs, distance);

  const timeMs = showMovingTime ? movingMs : elapsedMs;
  const timeValue = isAutoPaused
    ? `⏸ ${formatDuration(timeMs)}`
    : formatDuration(timeMs);

  const statusText = getStatusText(isAutoPaused, signalLost, isRecording, isStopping);

  return (
    <>
      <BigStat
        label={showMovingTime ? 'ВРЕМЯ В ДВИЖЕНИИ' : 'ВРЕМЯ'}
        value={timeValue}
        valueColor={isAutoPaused ? COLOR.pauseAccent : undefined}
      />
      {isAutoPaused && <PauseBadge />}
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
        <Text style={styles.statusText}>{statusText}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  twoCol: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  colDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: COLOR.divider,
    marginHorizontal: 0,
  },
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
  dotOn: { backgroundColor: COLOR.gnssGreen },
  dotOff: { backgroundColor: COLOR.gnssGray },
  dotPaused: { backgroundColor: COLOR.pauseAccent },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.secondary,
    letterSpacing: 1.5,
  },
});
