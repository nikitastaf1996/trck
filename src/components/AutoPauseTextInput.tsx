/**
 * AutoPauseTextInput — blankable number/text input for autopause variables.
 * Keeps local text state so the user can delete freely; only updates the
 * store when text is non-empty. No clamp limits.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { COLOR } from '../styles';

export interface AutoPauseTextInputProps {
  label: string;
  value: number;
  unit: string;
  disabled?: boolean;
  displayValue?: (v: number) => string;
  onChange: (v: number | '') => void;
}

export function AutoPauseTextInput({
  label,
  value,
  unit,
  disabled = false,
  displayValue,
  onChange,
}: AutoPauseTextInputProps): React.ReactElement {
  const [text, setText] = useState(displayValue ? displayValue(value) : String(value));

  // Keep the local text in sync with the store value when it changes
  // OUTSIDE of a keystroke:
  //   - loadAll() replacing the spec default (the field's initial state)
  //     with the persisted value,
  //   - a failed native-set reverting to the previous value.
  // Without this the field would keep showing the spec default even after
  // loadAll filled the store with the real persisted value.
  //
  // While typing this is a no-op: set() deliberately does NOT clamp
  // (free-form text input — see the INTENTIONAL comment on
  // settingsStore.set), so the store value equals the parsed local text
  // and we keep `prev` untouched (cursor stays put). We also skip
  // non-finite values: a "1.2.3" typo briefly makes the store NaN, and
  // rewriting would replace the user's in-progress text with "NaN". The
  // field keeps showing what the user typed until they fix it; the value
  // self-heals to the default on the next loadAll.
  useEffect(() => {
    if (!Number.isFinite(value)) return; // NaN typo — keep the user's text
    setText((prev) => {
      const parsed = prev === '' ? NaN : Number(prev);
      return Number.isFinite(parsed) && parsed === value
        ? prev
        : displayValue
          ? displayValue(value)
          : String(value);
    });
  }, [value, displayValue]);

  return (
    <View style={[styles.row, disabled && styles.rowDisabled]}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputWrap}>
        <TextInput
          style={[styles.input, disabled && styles.inputDisabled]}
          value={text}
          onChangeText={(newText) => {
            setText(newText); // allow any text including empty/deletion freely
            if (newText === '') {
              onChange('');
              return;
            }
            // Pass any value directly — no parseFloat guard, no NaN filter
            onChange(Number(newText) as number);
          }}
          keyboardType="decimal-pad"
          editable={!disabled}
          selectTextOnFocus
        />
        <Text style={styles.unit}>{unit}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderTopWidth: 0,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: COLOR.divider,
  },
  rowDisabled: {
    opacity: 0.55,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: COLOR.secondary,
    flex: 1,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    fontSize: 18,
    fontWeight: '700',
    color: COLOR.primary,
    textAlign: 'right',
    minWidth: 60,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLOR.divider,
    backgroundColor: '#FFFFFF',
  },
  inputDisabled: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
    color: '#9CA3AF',
  },
  unit: {
    fontSize: 12,
    fontWeight: '500',
    color: COLOR.secondary,
    marginLeft: 4,
    minWidth: 30,
  },
});
