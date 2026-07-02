/**
 * StartStopButton — the big circular START / STOP button at the bottom of
 * the screen. Extracted from App.tsx.
 *
 * O7 / O24 refactor: purely presentational. The parent owns
 * `recordingState` and the `onStart` / `onStop` handlers.
 *
 * Visual states:
 *   - idle       → green (COLOR.accent), label "СТАРТ"
 *   - recording  → red (COLOR.accentStop), label "СТОП"
 *   - stopping   → red dimmed, label "…", disabled
 *   - pressed    → opacity 0.85 (via Pressable's `pressed` state)
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLOR } from '../styles';
import type { RecordingState } from '../styles';

export interface StartStopButtonProps {
  recordingState: RecordingState;
  onStart: () => void;
  onStop: () => void;
}

export function StartStopButton({
  recordingState,
  onStart,
  onStop,
}: StartStopButtonProps): React.ReactElement {
  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';

  return (
    <View style={styles.buttonWrap}>
      <Pressable
        style={({ pressed }) => [
          styles.bigButton,
          isRecording ? styles.bigButtonStop : styles.bigButtonStart,
          (pressed || isStopping) && styles.bigButtonPressed,
          isStopping && styles.bigButtonStopping,
        ]}
        onPress={isRecording ? onStop : onStart}
        disabled={isStopping}
        android_ripple={{ color: 'rgba(255,255,255,0.18)', radius: 220 }}
      >
        <Text style={styles.bigButtonText}>
          {isStopping ? '…' : isRecording ? 'СТОП' : 'СТАРТ'}
        </Text>
      </Pressable>
    </View>
  );
}

const BIG_BUTTON_SIZE = 220;

const styles = StyleSheet.create({
  buttonWrap: {
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 16,
  },
  bigButton: {
    width: BIG_BUTTON_SIZE,
    height: BIG_BUTTON_SIZE,
    borderRadius: BIG_BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
  },
  bigButtonStart: { backgroundColor: COLOR.accentStart },
  bigButtonStop: { backgroundColor: COLOR.accentStop },
  bigButtonPressed: { transform: [{ scale: 0.98 }] },
  bigButtonStopping: { backgroundColor: COLOR.accentStopping },
  bigButtonText: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 4,
  },
});
