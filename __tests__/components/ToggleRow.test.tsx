/**
 * Tests for ToggleRow.
 */
import React from 'react';
import { ToggleRow } from '../../src/components/ToggleRow';
import { render, press, allText, firstPressable } from '../helpers/render';

type Root = ReturnType<typeof render>;

function findPressable(root: Root) {
  return firstPressable(root);
}

describe('ToggleRow', () => {
  it('renders the title and subtitle text', () => {
    const root = render(
      <ToggleRow title="Test Toggle" subtitle="A subtitle" value={false} onPress={jest.fn()} />
    );
    const texts = allText(root);
    expect(texts).toContain('Test Toggle');
    expect(texts).toContain('A subtitle');
  });

  it('calls onPress when pressed and not disabled', () => {
    const onPress = jest.fn();
    const root = render(
      <ToggleRow title="t" subtitle="s" value={false} onPress={onPress} />
    );
    press(findPressable(root));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('passes disabled=true through to the Pressable when disabled', () => {
    const onPress = jest.fn();
    const root = render(
      <ToggleRow title="t" subtitle="s" value={false} onPress={onPress} disabled />
    );
    expect(findPressable(root).props.disabled).toBe(true);
  });

  it('renders without crashing for both value=false and value=true', () => {
    for (const value of [false, true]) {
      const root = render(
        <ToggleRow title="t" subtitle="s" value={value} onPress={jest.fn()} />
      );
      expect(findPressable(root)).toBeDefined();
      expect(allText(root)).toContain('t');
    }
  });

  it('passes the `grouped` prop through to the ToggleRow style (no crash)', () => {
    const root = render(
      <ToggleRow title="t" subtitle="s" value={false} onPress={jest.fn()} grouped />
    );
    expect(findPressable(root)).toBeDefined();
  });
});
