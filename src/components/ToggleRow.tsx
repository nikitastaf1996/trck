/**
 * ToggleRow — a reusable settings toggle row with label, subtitle, and
 * iOS-style switch + knob. Extracted from App.tsx (8 inlined copies → 1
 * reusable component).
 *
 * O7 / O24 refactor: this component is purely presentational. The parent
 * owns the `value` state and the `onPress` handler (which typically does
 * an optimistic update + native persist + revert-on-error).
 *
 * The `disabled` prop SHOULD be `true` whenever settings are locked
 * (recordingState === 'recording' || 'stopping'), EXCEPT for the
 * show-moving-time toggle which is intentionally unlocked during recording
 * per Task 4 spec.
 *
 * The `grouped` prop adds the `toggleRowGrouped` style (used when the
 * toggle is the first child of a `settingGroup` View, to remove the
 * bottom border separation between the toggle and the stepper below).
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLOR } from '../styles';

export interface ToggleRowProps {
  title: string;
  /** Subtitle text shown below the title. Typically a function of `value`. */
  subtitle: string;
  /** Current toggle value (controls switch + knob position). */
  value: boolean;
  /** Called when the user taps the row. */
  onPress: () => void;
  /** When true, the row is greyed out and taps are ignored. */
  disabled?: boolean;
  /** When true, applies the `toggleRowGrouped` style (no bottom border). */
  grouped?: boolean;
}

export function ToggleRow({
  title,
  subtitle,
  value,
  onPress,
  disabled = false,
  grouped = false,
}: ToggleRowProps): React.ReactElement {
  return (
    <Pressable
      style={[
        styles.toggleRow,
        value ? styles.toggleRowOn : styles.toggleRowOff,
        disabled && styles.toggleRowLocked,
        grouped && styles.toggleRowGrouped,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={styles.toggleLabelWrap}>
        <Text style={styles.toggleTitle}>{title}</Text>
        <Text style={styles.toggleSubtitle}>{subtitle}</Text>
      </View>
      <View
        style={[
          styles.toggleSwitch,
          value ? styles.toggleSwitchOn : styles.toggleSwitchOff,
        ]}
      >
        <View
          style={[
            styles.toggleKnob,
            value ? styles.toggleKnobOn : styles.toggleKnobOff,
          ]}
        />
      </View>
    </Pressable>
  );
}

// ------------------------------------------------------------------
// Styles — copied verbatim from App.tsx to preserve the exact look.
// These are duplicated here so ToggleRow is self-contained; the parent
// doesn't need to pass styles in. If the design system changes, update
// both this file and App.tsx.
// ------------------------------------------------------------------

const styles = StyleSheet.create({
  // These styles mirror App.tsx's toggle styles verbatim so the
  // extracted component is visually identical to the original inlined
  // version. If the design changes, update both files.
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
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
  },
  toggleKnobOn: { alignSelf: 'flex-end' },
  toggleKnobOff: { alignSelf: 'flex-start' },
});
