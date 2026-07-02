/**
 * SavedCard — the "GPX СОХРАНЁН" card shown after a recording finishes.
 * Extracted from App.tsx.
 *
 * O7 / O24 refactor: this component replaces the inline IIFE in the
 * original App.tsx that computed the final-distance + pace display. The
 * pace-time-base logic (`selectPaceTimeMs`) is now testable in isolation.
 *
 * The card shows:
 *   - Title: "GPX СОХРАНЁН"
 *   - Dismiss ✕ button (top-right)
 *   - Saved file path
 *   - Final distance + pace line (using the save-time snapshot of the
 *     auto-pause / gap-detection / show-moving-time toggles, per U3/Task 4)
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Platform } from 'react-native';
import { COLOR, formatDistance, computeAvgPace } from '../styles';

export interface SavedCardSettingsSnapshot {
  autoPauseEnabled: boolean;
  gapDetectionEnabled: boolean;
  showMovingTime: boolean;
}

export interface SavedCardProps {
  path: string;
  /** Final distance in meters, computed from the SAVED GPX (post-smoothing). */
  distance: number | null;
  /** Moving time at save time (ms). */
  movingMs: number;
  /** Elapsed time at save time (ms). */
  elapsedMs: number;
  /** Snapshot of the toggle state at save time (U3/Task 4). */
  settings: SavedCardSettingsSnapshot | null;
  onDismiss: () => void;
}

/**
 * Selects which time base to use for the pace display, mirroring the logic
 * in App.tsx for the live pace. When showMovingTime is on, OR auto-pause is
 * on, OR gap detection is on, we use movingMs (excludes paused / lost-signal
 * intervals). Otherwise we use elapsedMs.
 *
 * Extracted as a standalone exported function so it can be unit-tested.
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

export function SavedCard({
  path,
  distance,
  movingMs,
  elapsedMs,
  settings,
  onDismiss,
}: SavedCardProps): React.ReactElement | null {
  return (
    <View style={styles.savedCard}>
      <View style={styles.cardRow}>
        <Text style={styles.savedTitle}>GPX СОХРАНЁН</Text>
        {/* U19: dismiss button so the user can clear the saved card
            without starting a new recording. */}
        <Pressable
          style={styles.cardDismissBtn}
          onPress={onDismiss}
          hitSlop={8}
          accessibilityLabel="Скрыть карточку сохранения"
        >
          <Text style={styles.cardDismissText}>✕</Text>
        </Pressable>
      </View>
      <Text style={styles.savedPath}>{path}</Text>
      {distance != null && (() => {
        const fmt = formatDistance(distance);
        // U3: use the save-time snapshot of the toggle state, NOT the
        // current toggle state. After a recording ends, the settings
        // unlock and the user can flip auto-pause / gap detection to
        // prepare for the next run — without the snapshot, the saved
        // card's pace would silently recompute under the new state.
        const ap = settings?.autoPauseEnabled ?? false;
        const gd = settings?.gapDetectionEnabled ?? true;
        // CODE_REVIEW_TODO Task 4: also use the save-time snapshot of
        // showMovingTime so the saved card's pace uses the same time
        // base the user was looking at when they stopped the recording.
        const smt = settings?.showMovingTime ?? false;
        const tMs = selectPaceTimeMs(smt, ap, gd, movingMs, elapsedMs);
        const pace = computeAvgPace(tMs, distance);
        return (
          <Text style={styles.savedDistance}>
            Финальная дистанция: {fmt.value} {fmt.unit}
            {pace ? `  ·  ${pace} /км` : ''}
          </Text>
        );
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  savedCard: {
    backgroundColor: COLOR.savedBg,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLOR.savedBorder,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardDismissBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  cardDismissText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLOR.secondary,
    lineHeight: 14,
  },
  savedTitle: {
    fontSize: 11,
    color: COLOR.savedText,
    letterSpacing: 1.5,
    fontWeight: '700',
    marginBottom: 6,
  },
  savedPath: {
    fontSize: 13,
    color: COLOR.savedText,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  savedDistance: {
    fontSize: 14,
    fontWeight: '700',
    color: COLOR.savedText,
    marginTop: 8,
    fontVariant: ['tabular-nums'],
  },
});
