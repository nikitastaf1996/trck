/**
 * Tests for Overlays — Overlay (generic), PermissionWaitOverlay, StopOverlay.
 *
 * Verifies:
 *   - Overlay returns null when visible=false.
 *   - Overlay renders the text + spinner when visible=true.
 *   - Overlay renders the cancel button only when onCancel is provided.
 *   - PermissionWaitOverlay uses COLOR.primary spinner color and "Ожидание разрешений…" default text.
 *   - StopOverlay uses COLOR.accentStop spinner color and "Сохранение GPX…" default text.
 *   - PermissionWaitOverlay's cancel button calls onCancel.
 */
import React from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { Overlay, PermissionWaitOverlay, StopOverlay } from '../../src/components/Overlays';
import { COLOR } from '../../src/styles';
import { render, press, allText, allPressables } from '../helpers/render';

describe('Overlay (generic)', () => {
  it('returns null when visible=false', () => {
    const root = render(
      <Overlay visible={false} spinnerColor="#000" text="hidden" />
    );
    // When the component returns null, react-test-renderer renders an
    // empty host tree — there are no children at all. Assert by checking
    // that no Text is present.
    expect(root.findAllByType(Text).length).toBe(0);
  });

  it('renders the text when visible=true', () => {
    const root = render(
      <Overlay visible={true} spinnerColor="#000" text="loading…" />
    );
    const texts = allText(root);
    expect(texts).toContain('loading…');
  });

  it('renders an ActivityIndicator when visible=true', () => {
    const root = render(
      <Overlay visible={true} spinnerColor="#FF0000" text="…" />
    );
    const indicators = root.findAllByType(ActivityIndicator);
    expect(indicators.length).toBe(1);
    expect(indicators[0].props.color).toBe('#FF0000');
  });

  it('does NOT render the cancel button when onCancel is not provided', () => {
    const root = render(
      <Overlay visible={true} spinnerColor="#000" text="…" />
    );
    expect(allPressables(root).length).toBe(0);
  });

  it('renders the cancel button with default label "Отмена" when onCancel is provided', () => {
    const root = render(
      <Overlay visible={true} spinnerColor="#000" text="…" onCancel={jest.fn()} />
    );
    const texts = allText(root);
    expect(texts).toContain('Отмена');
    expect(allPressables(root).length).toBe(1);
  });

  it('uses a custom cancel label when cancelLabel is provided', () => {
    const root = render(
      <Overlay
        visible={true}
        spinnerColor="#000"
        text="…"
        onCancel={jest.fn()}
        cancelLabel="Abort"
      />
    );
    const texts = allText(root);
    expect(texts).toContain('Abort');
  });

  it('fires onCancel when the cancel button is pressed', () => {
    const onCancel = jest.fn();
    const root = render(
      <Overlay visible={true} spinnerColor="#000" text="…" onCancel={onCancel} />
    );
    press(allPressables(root)[0]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('PermissionWaitOverlay', () => {
  it('returns null when visible=false', () => {
    const root = render(<PermissionWaitOverlay visible={false} onCancel={jest.fn()} />);
    expect(root.findAllByType(Text).length).toBe(0);
  });

  it('renders the default "Ожидание разрешений…" text when visible', () => {
    const root = render(<PermissionWaitOverlay visible={true} onCancel={jest.fn()} />);
    expect(allText(root)).toContain('Ожидание разрешений…');
  });

  it('uses a custom text when provided', () => {
    const root = render(
      <PermissionWaitOverlay visible={true} onCancel={jest.fn()} text="custom" />
    );
    expect(allText(root)).toContain('custom');
  });

  it('uses the COLOR.primary navy as the spinner color', () => {
    const root = render(<PermissionWaitOverlay visible={true} onCancel={jest.fn()} />);
    const indicator = root.findByType(ActivityIndicator);
    expect(indicator.props.color).toBe(COLOR.primary);
  });

  it('renders the cancel button when onCancel is provided', () => {
    const root = render(<PermissionWaitOverlay visible={true} onCancel={jest.fn()} />);
    expect(allPressables(root).length).toBe(1);
  });

  it('does NOT render the cancel button when onCancel is omitted', () => {
    const root = render(<PermissionWaitOverlay visible={true} />);
    expect(allPressables(root).length).toBe(0);
  });

  it('fires onCancel when the cancel button is pressed', () => {
    const onCancel = jest.fn();
    const root = render(<PermissionWaitOverlay visible={true} onCancel={onCancel} />);
    press(allPressables(root)[0]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('StopOverlay', () => {
  it('returns null when visible=false', () => {
    const root = render(<StopOverlay visible={false} />);
    expect(root.findAllByType(Text).length).toBe(0);
  });

  it('renders the default "Сохранение GPX…" text when visible', () => {
    const root = render(<StopOverlay visible={true} />);
    expect(allText(root)).toContain('Сохранение GPX…');
  });

  it('uses a custom text when provided', () => {
    const root = render(<StopOverlay visible={true} text="finalizing…" />);
    expect(allText(root)).toContain('finalizing…');
  });

  it('uses the COLOR.accentStop red as the spinner color', () => {
    const root = render(<StopOverlay visible={true} />);
    const indicator = root.findByType(ActivityIndicator);
    expect(indicator.props.color).toBe(COLOR.accentStop);
  });

  it('does NOT render a cancel button (no onCancel prop accepted)', () => {
    const root = render(<StopOverlay visible={true} />);
    expect(allPressables(root).length).toBe(0);
  });
});
