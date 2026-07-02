/**
 * FilterSettingGroup — a ToggleRow + StepperRow combined into a single
 * "card" group. Extracted from App.tsx (3 inlined copies → 1 reusable
 * component).
 *
 * O7 / O24 refactor: used for the three data-reduction filters:
 *   1. Radial distance filter (toggle + threshold meters stepper)
 *   2. Time sampling filter (toggle + N stepper)
 *   3. Douglas-Peucker post-processing (toggle + epsilon stepper)
 *
 * All three filters are locked while a recording is in progress
 * (settingsLocked === true). The stepper is also disabled when the
 * toggle is off (so the user can't change the parameter of a disabled
 * filter).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ToggleRow } from './ToggleRow';
import { StepperRow } from './StepperRow';

export interface FilterSettingGroupProps {
  // Toggle props
  title: string;
  subtitleOn: string;
  subtitleOff: string;
  value: boolean;
  onToggle: () => void;
  // Stepper props
  stepperLabel: string;
  stepperValue: number;
  stepperUnit: string;
  stepperMin: number;
  stepperMax: number;
  onDecrement: () => void;
  onIncrement: () => void;
  // Lock state — when true, both toggle and stepper are disabled.
  settingsLocked: boolean;
}

export function FilterSettingGroup({
  title,
  subtitleOn,
  subtitleOff,
  value,
  onToggle,
  stepperLabel,
  stepperValue,
  stepperUnit,
  stepperMin,
  stepperMax,
  onDecrement,
  onIncrement,
  settingsLocked,
}: FilterSettingGroupProps): React.ReactElement {
  return (
    <View style={styles.settingGroup}>
      <ToggleRow
        title={title}
        subtitle={value ? subtitleOn : subtitleOff}
        value={value}
        onPress={onToggle}
        disabled={settingsLocked}
        grouped
      />
      <StepperRow
        label={stepperLabel}
        value={stepperValue}
        unit={stepperUnit}
        min={stepperMin}
        max={stepperMax}
        disabled={settingsLocked}
        onDecrement={onDecrement}
        onIncrement={onIncrement}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  settingGroup: {
    marginVertical: 4,
  },
});
