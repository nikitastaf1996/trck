/**
 * Tests for StartStopButton.
 *
 * Verifies:
 *   - Renders without crashing in all three recording states.
 *   - The label text matches the state (СТАРТ / СТОП / …).
 *   - The onPress handler is wired to onStart for idle, onStop for recording.
 *   - The button is disabled when stopping.
 */
import React from 'react';
import { Text } from 'react-native';
import { StartStopButton } from '../../src/components/StartStopButton';
import type { RecordingState } from '../../src/styles';
import { render, press, firstPressable } from '../helpers/render';

type Root = ReturnType<typeof render>;

function findPressable(root: Root) {
  return firstPressable(root);
}

function findButtonText(root: ReturnType<typeof render>): string {
  const txt = root.findByType(Text);
  return txt.props.children as string;
}

describe('StartStopButton', () => {
  it('renders without crashing in the idle state', () => {
    const root = render(
      <StartStopButton recordingState="idle" onStart={jest.fn()} onStop={jest.fn()} />
    );
    expect(findButtonText(root)).toBe('СТАРТ');
  });

  it('renders without crashing in the recording state', () => {
    const root = render(
      <StartStopButton recordingState="recording" onStart={jest.fn()} onStop={jest.fn()} />
    );
    expect(findButtonText(root)).toBe('СТОП');
  });

  it('renders without crashing in the stopping state', () => {
    const root = render(
      <StartStopButton recordingState="stopping" onStart={jest.fn()} onStop={jest.fn()} />
    );
    expect(findButtonText(root)).toBe('…');
  });

  it('calls onStart when pressed in the idle state', () => {
    const onStart = jest.fn();
    const onStop = jest.fn();
    const root = render(
      <StartStopButton recordingState="idle" onStart={onStart} onStop={onStop} />
    );
    press(findPressable(root));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('calls onStop when pressed in the recording state', () => {
    const onStart = jest.fn();
    const onStop = jest.fn();
    const root = render(
      <StartStopButton recordingState="recording" onStart={onStart} onStop={onStop} />
    );
    press(findPressable(root));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('disables the Pressable when recordingState is "stopping"', () => {
    const root = render(
      <StartStopButton recordingState="stopping" onStart={jest.fn()} onStop={jest.fn()} />
    );
    expect(findPressable(root).props.disabled).toBe(true);
  });

  it('enables the Pressable in the idle and recording states', () => {
    for (const state of ['idle', 'recording'] as RecordingState[]) {
      const root = render(
        <StartStopButton recordingState={state} onStart={jest.fn()} onStop={jest.fn()} />
      );
      expect(findPressable(root).props.disabled).toBe(false);
    }
  });
});
