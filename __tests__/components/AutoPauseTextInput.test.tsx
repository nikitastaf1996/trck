/**
 * Tests for AutoPauseTextInput — the blankable free-form number input used
 * for the three auto-pause variables.
 *
 * Focus:
 *   - renders label / unit and the value (honouring `displayValue`).
 *   - typing calls `onChange` with the parsed number, and blanking sends ''.
 *   - the local text re-syncs when the `value` prop changes from OUTSIDE
 *     (loadAll / revert-on-error) — the behaviour the sync useEffect adds.
 *   - a non-finite (NaN) value does NOT rewrite the field (a "1.2.3" typo
 *     keeps showing what the user typed, not the string "NaN").
 *   - `disabled` makes the field non-editable.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { AutoPauseTextInput } from '../../src/components/AutoPauseTextInput';

type Root = TestRenderer.ReactTestInstance;
type Renderer = TestRenderer.ReactTestRenderer;

function findInput(root: Root): Root {
  const found = root.findAllByType(TextInput);
  if (found.length === 0) throw new Error('findInput() — no TextInput in tree');
  return found[0];
}

function inputText(root: Root): string {
  return (findInput(root).props as { value: string }).value;
}

function typeText(root: Root, text: string): void {
  act(() => {
    (findInput(root).props as { onChangeText: (t: string) => void }).onChangeText(text);
  });
}

describe('AutoPauseTextInput', () => {
  it('renders label, the value (via displayValue), and the unit', () => {
    let r: Renderer | undefined;
    act(() => {
      r = TestRenderer.create(
        <AutoPauseTextInput
          label="Окно времени (с)"
          value={10000}
          unit="с"
          displayValue={(v) => String(v / 1000)}
          onChange={() => {}}
        />,
      );
    });
    const root = r!.root;
    expect(inputText(root)).toBe('10'); // 10000 ms -> "10" s
    const texts = root
      .findAllByType(Text)
      .map((t) => (t.props as { children?: unknown }).children);
    expect(texts).toContain('Окно времени (с)');
    expect(texts).toContain('с');
  });

  it('renders the raw value as a string when no displayValue is given', () => {
    let r: Renderer | undefined;
    act(() => {
      r = TestRenderer.create(
        <AutoPauseTextInput label="L" value={0.35} unit="м/с" onChange={() => {}} />,
      );
    });
    expect(inputText(r!.root)).toBe('0.35');
  });

  it('calls onChange with the parsed number while typing, and blanking sends ""', () => {
    const onChange = jest.fn();
    let r: Renderer | undefined;
    act(() => {
      r = TestRenderer.create(
        <AutoPauseTextInput label="L" value={5} unit="м/с" onChange={onChange} />,
      );
    });
    typeText(r!.root, '0');
    expect(onChange).toHaveBeenLastCalledWith(0);
    typeText(r!.root, '1.2');
    expect(onChange).toHaveBeenLastCalledWith(1.2);
    typeText(r!.root, '');
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('re-syncs local text when the value changes from outside (loadAll / revert)', () => {
    let r: Renderer | undefined;
    act(() => {
      r = TestRenderer.create(
        <AutoPauseTextInput label="L" value={3.5} unit="м" onChange={() => {}} />,
      );
    });
    expect(inputText(r!.root)).toBe('3.5');
    // Simulate loadAll() / a revert: the store value changes to 9.9 from outside.
    act(() => {
      r!.update(<AutoPauseTextInput label="L" value={9.9} unit="м" onChange={() => {}} />);
    });
    expect(inputText(r!.root)).toBe('9.9');
  });

  it('does NOT rewrite the field when the value is NaN (a "1.2.3" typo)', () => {
    let r: Renderer | undefined;
    act(() => {
      r = TestRenderer.create(
        <AutoPauseTextInput label="L" value={3.5} unit="м" onChange={() => {}} />,
      );
    });
    // User types "1.2.3" -> onChange(NaN); the field shows what they typed.
    typeText(r!.root, '1.2.3');
    expect(inputText(r!.root)).toBe('1.2.3');
    // Parent round-trips NaN back into the value prop — the effect must skip
    // it, not replace the user's text with the string "NaN".
    act(() => {
      r!.update(<AutoPauseTextInput label="L" value={Number.NaN} unit="м" onChange={() => {}} />);
    });
    expect(inputText(r!.root)).toBe('1.2.3');
  });

  it('honours disabled (field is not editable)', () => {
    let r: Renderer | undefined;
    act(() => {
      r = TestRenderer.create(
        <AutoPauseTextInput label="L" value={5} unit="м" disabled onChange={() => {}} />,
      );
    });
    expect((findInput(r!.root).props as { editable: boolean }).editable).toBe(false);
  });
});
