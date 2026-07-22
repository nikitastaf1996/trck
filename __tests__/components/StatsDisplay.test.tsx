/**
 * Tests for StatsDisplay — the primary stats block.
 *
 * Also tests the pure helpers `getStatusText` and `selectPaceTimeMs`
 * exported from this module.
 */
import React from 'react';
import { Text } from 'react-native';
import {
  StatsDisplay,
  getStatusText,
  selectPaceTimeMs,
} from '../../src/components/StatsDisplay';
import { render, allText } from '../helpers/render';

describe('getStatusText (pure helper)', () => {
  it('returns "АВТОПАУЗА" when isAutoPaused is true (highest priority)', () => {
    expect(getStatusText(true, true, true, true)).toBe('АВТОПАУЗА');
  });

  it('returns "НЕТ СИГНАЛА" when signalLost is true and not auto-paused', () => {
    expect(getStatusText(false, true, true, true)).toBe('НЕТ СИГНАЛА');
  });

  it('returns "ЗАПИСЬ" when isRecording=true (and not paused/lost)', () => {
    expect(getStatusText(false, false, true, false)).toBe('ЗАПИСЬ');
  });

  it('returns "ОСТАНОВКА…" when isStopping=true (and not recording)', () => {
    expect(getStatusText(false, false, false, true)).toBe('ОСТАНОВКА…');
  });

  it('returns "ОЖИДАНИЕ" when no flag is true', () => {
    expect(getStatusText(false, false, false, false)).toBe('ОЖИДАНИЕ');
  });

  it('auto-pause takes priority over signal lost', () => {
    // When both are true, we show "АВТОПАУЗА" — see the priority comment
    // in StatsDisplay.tsx for why (stationary users legitimately have
    // no incoming fixes, so the signal-lost banner is contradictory).
    expect(getStatusText(true, true, false, false)).toBe('АВТОПАУЗА');
  });

  it('signal lost takes priority over recording / stopping', () => {
    expect(getStatusText(false, true, true, false)).toBe('НЕТ СИГНАЛА');
    expect(getStatusText(false, true, false, true)).toBe('НЕТ СИГНАЛА');
  });
});

describe('selectPaceTimeMs (pure helper)', () => {
  it('returns movingMs when showMovingTime is true', () => {
    expect(selectPaceTimeMs(true, false, false, 30_000, 60_000)).toBe(30_000);
  });

  it('returns movingMs when autoPauseEnabled is true', () => {
    expect(selectPaceTimeMs(false, true, false, 30_000, 60_000)).toBe(30_000);
  });

  it('returns movingMs when gapDetectionEnabled is true', () => {
    expect(selectPaceTimeMs(false, false, true, 30_000, 60_000)).toBe(30_000);
  });

  it('returns elapsedMs when all three toggles are false', () => {
    expect(selectPaceTimeMs(false, false, false, 30_000, 60_000)).toBe(60_000);
  });
});

describe('StatsDisplay component', () => {
  it('renders without crashing in the idle state', () => {
    const root = render(
      <StatsDisplay
        recordingState="idle"
        elapsedMs={0}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    expect(root).toBeDefined();
  });

  it('renders without crashing in the recording state', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={5_000}
        movingMs={4_000}
        distance={1500}
        currentSpeed={3.0}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[3.0, 3.1, 2.9]}
      />
    );
    expect(root).toBeDefined();
  });

  it('renders the "ОЖИДАНИЕ" status when idle', () => {
    const root = render(
      <StatsDisplay
        recordingState="idle"
        elapsedMs={0}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    expect(allText(root)).toContain('ОЖИДАНИЕ');
  });

  it('renders the "ЗАПИСЬ" status when recording', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={5_000}
        movingMs={5_000}
        distance={100}
        currentSpeed={3.0}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[3.0]}
      />
    );
    expect(allText(root)).toContain('ЗАПИСЬ');
  });

  it('renders the "АВТОПАУЗА" status when isAutoPaused', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={5_000}
        movingMs={0}
        distance={100}
        currentSpeed={null}
        isAutoPaused={true}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={true}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    expect(allText(root)).toContain('АВТОПАУЗА');
  });

  it('renders the "НЕТ СИГНАЛА" status when signalLost', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={5_000}
        movingMs={5_000}
        distance={100}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={true}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={true}
        recentSpeeds={[]}
      />
    );
    expect(allText(root)).toContain('НЕТ СИГНАЛА');
  });

  it('renders the "ОСТАНОВКА…" status when stopping', () => {
    const root = render(
      <StatsDisplay
        recordingState="stopping"
        elapsedMs={5_000}
        movingMs={5_000}
        distance={100}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    expect(allText(root)).toContain('ОСТАНОВКА…');
  });

  it('renders the "ВРЕМЯ" label when showMovingTime is false', () => {
    const root = render(
      <StatsDisplay
        recordingState="idle"
        elapsedMs={0}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    expect(allText(root)).toContain('ВРЕМЯ');
  });

  it('renders the "ВРЕМЯ В ДВИЖЕНИИ" label when showMovingTime is true', () => {
    const root = render(
      <StatsDisplay
        recordingState="idle"
        elapsedMs={0}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={true}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    expect(allText(root)).toContain('ВРЕМЯ В ДВИЖЕНИИ');
  });

  it('prepends a "⏸" pause indicator to the time value when auto-paused', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={65_000}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={true}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={true}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    const texts = allText(root);
    // ⏸ 01:05 (paused indicator + duration formatted from elapsedMs=65_000ms)
    expect(texts.some((t) => t.startsWith('⏸'))).toBe(true);
    expect(texts.some((t) => t.includes('01:05'))).toBe(true);
  });

  it('renders the "ДИСТАНЦИЯ" label', () => {
    const root = render(
      <StatsDisplay
        recordingState="idle"
        elapsedMs={0}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    expect(allText(root)).toContain('ДИСТАНЦИЯ');
  });

  it('renders the "ТЕМП" and "СРЕД. ТЕМП" labels', () => {
    const root = render(
      <StatsDisplay
        recordingState="idle"
        elapsedMs={0}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    const texts = allText(root);
    expect(texts).toContain('ТЕМП');
    expect(texts).toContain('СРЕД. ТЕМП');
  });

  it('renders "—" for current pace when currentSpeed is null and no recent speeds', () => {
    const root = render(
      <StatsDisplay
        recordingState="idle"
        elapsedMs={0}
        movingMs={0}
        distance={0}
        currentSpeed={null}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    const texts = allText(root);
    // At least one "—" should appear (current pace with no data).
    expect(texts.filter((t) => t === '—').length).toBeGreaterThanOrEqual(1);
  });

  it('renders "—" for avg pace when distance is 0', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={5_000}
        movingMs={5_000}
        distance={0}
        currentSpeed={3.0}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[3.0]}
      />
    );
    const texts = allText(root);
    // Avg pace with distance=0 → null → "—".
    expect(texts.filter((t) => t === '—').length).toBeGreaterThanOrEqual(1);
  });

  it('renders PauseBadge (АВТОПАУЗА · запись приостановлена) when isAutoPaused', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={5_000}
        movingMs={0}
        distance={100}
        currentSpeed={null}
        isAutoPaused={true}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={true}
        gapDetectionEnabled={false}
        recentSpeeds={[]}
      />
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('запись приостановлена'))).toBe(true);
  });

  it('does NOT render PauseBadge when not auto-paused', () => {
    const root = render(
      <StatsDisplay
        recordingState="recording"
        elapsedMs={5_000}
        movingMs={5_000}
        distance={100}
        currentSpeed={3.0}
        isAutoPaused={false}
        signalLost={false}
        showMovingTime={false}
        autoPauseEnabled={false}
        gapDetectionEnabled={false}
        recentSpeeds={[3.0]}
      />
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('запись приостановлена'))).toBe(false);
  });
});
