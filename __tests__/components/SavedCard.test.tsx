/**
 * Tests for SavedCard — the "GPX СОХРАНЁН" card shown after a recording finishes.
 *
 * Also tests the pure `selectPaceTimeMs` helper that decides whether the
 * card's pace display should use movingMs (excludes auto-pause / signal-
 * lost intervals) or elapsedMs (wall-clock).
 */
import React from 'react';
import { Text } from 'react-native';
import { SavedCard, selectPaceTimeMs } from '../../src/components/SavedCard';
import { render, press, allText, allPressables } from '../helpers/render';

describe('selectPaceTimeMs (pure helper)', () => {
  it('returns movingMs when showMovingTime is true', () => {
    expect(
      selectPaceTimeMs(true, false, false, /* movingMs */ 30_000, /* elapsedMs */ 60_000)
    ).toBe(30_000);
  });

  it('returns movingMs when autoPauseEnabled is true (regardless of showMovingTime)', () => {
    expect(
      selectPaceTimeMs(false, true, false, 30_000, 60_000)
    ).toBe(30_000);
  });

  it('returns movingMs when gapDetectionEnabled is true', () => {
    expect(
      selectPaceTimeMs(false, false, true, 30_000, 60_000)
    ).toBe(30_000);
  });

  it('returns elapsedMs when all three toggles are false', () => {
    expect(
      selectPaceTimeMs(false, false, false, 30_000, 60_000)
    ).toBe(60_000);
  });

  it('prefers movingMs over elapsedMs even when movingMs is 0 (auto-pause just entered)', () => {
    // Edge case: the toggle is on but movingMs is 0 (e.g. user toggled
    // auto-pause on but never moved). The helper should still return
    // movingMs (0), not elapsedMs — the caller is responsible for
    // deciding how to render a 0-value pace.
    expect(
      selectPaceTimeMs(true, false, false, 0, 5_000)
    ).toBe(0);
  });
});

describe('SavedCard component', () => {
  it('renders the "GPX СОХРАНЁН" title', () => {
    const root = render(
      <SavedCard
        path="/path/to/file.gpx"
        distance={1000}
        movingMs={0}
        elapsedMs={0}
        settings={null}
        onDismiss={jest.fn()}
      />
    );
    expect(allText(root)).toContain('GPX СОХРАНЁН');
  });

  it('renders the file path text', () => {
    const root = render(
      <SavedCard
        path="/storage/trck/run.gpx"
        distance={null}
        movingMs={0}
        elapsedMs={0}
        settings={null}
        onDismiss={jest.fn()}
      />
    );
    expect(allText(root)).toContain('/storage/trck/run.gpx');
  });

  it('renders the distance line when distance is provided', () => {
    const root = render(
      <SavedCard
        path="x"
        distance={1500}
        movingMs={0}
        elapsedMs={0}
        settings={null}
        onDismiss={jest.fn()}
      />
    );
    const texts = allText(root);
    // 1500 m → 1.50 km per formatDistance helper. Note: formatDistance
    // returns Latin "km" (not Cyrillic "км") as the unit string.
    expect(texts.some((t) => t.includes('1.50'))).toBe(true);
    expect(texts.some((t) => t.includes('km'))).toBe(true);
  });

  it('omits the distance line when distance is null', () => {
    const root = render(
      <SavedCard
        path="x"
        distance={null}
        movingMs={0}
        elapsedMs={0}
        settings={null}
        onDismiss={jest.fn()}
      />
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Финальная дистанция'))).toBe(false);
  });

  it('renders the ✕ dismiss button', () => {
    const root = render(
      <SavedCard
        path="x"
        distance={null}
        movingMs={0}
        elapsedMs={0}
        settings={null}
        onDismiss={jest.fn()}
      />
    );
    expect(allText(root)).toContain('✕');
  });

  it('fires onDismiss when the ✕ button is pressed', () => {
    const onDismiss = jest.fn();
    const root = render(
      <SavedCard
        path="x"
        distance={null}
        movingMs={0}
        elapsedMs={0}
        settings={null}
        onDismiss={onDismiss}
      />
    );
    press(allPressables(root)[0]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders the pace line when distance + a non-zero time are available', () => {
    const root = render(
      <SavedCard
        path="x"
        distance={1000}
        movingMs={300_000}  // 5 min
        elapsedMs={600_000} // 10 min
        settings={{ autoPauseEnabled: true, gapDetectionEnabled: false, showMovingTime: false }}
        onDismiss={jest.fn()}
      />
    );
    const texts = allText(root);
    // 5 min movingMs for 1 km → 5:00 /km.
    expect(texts.some((t) => t.includes('5:00'))).toBe(true);
    // Pace unit is rendered as "/км" (Cyrillic km) — see SavedCard.tsx.
    expect(texts.some((t) => t.includes('/км'))).toBe(true);
  });

  it('does NOT render the pace line when distance is 0 (no measurable distance)', () => {
    const root = render(
      <SavedCard
        path="x"
        distance={0}
        movingMs={300_000}
        elapsedMs={600_000}
        settings={{ autoPauseEnabled: true, gapDetectionEnabled: false, showMovingTime: false }}
        onDismiss={jest.fn()}
      />
    );
    const texts = allText(root);
    // No pace text should appear.
    expect(texts.some((t) => t.includes('/км'))).toBe(false);
  });
});
