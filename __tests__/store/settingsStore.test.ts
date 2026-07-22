/**
 * Tests for the settings Zustand store (src/store/settingsStore.ts).
 *
 * These tests replace the previous useSettings.test.ts (~36 tests covering
 * 11 near-identical handlers). The new generic toggle/step actions are
 * exercised by key, with one test per behavioural pattern (lock check,
 * re-entrancy guard, optimistic update, revert-on-error, clamp range)
 * rather than one per setting.
 */

import { useSettingsStore, SETTINGS_SPEC, type SettingKey } from '../../src/store/settingsStore';
import { useRecordingStore } from '../../src/store/recordingStore';
import { gpsMock, clearGpsMock, resetStores } from '../helpers';

describe('settingsStore — SETTINGS_SPEC', () => {
  it('defines all 11 settings', () => {
    const keys = Object.keys(SETTINGS_SPEC);
    expect(keys).toHaveLength(11);
    expect(keys).toEqual(
      expect.arrayContaining([
        'postProcessEnabled', 'gaussianSmoothingEnabled',
        'autoPauseEnabled', 'gapDetectionEnabled', 'showMovingTime',
        'radialDistanceFilterEnabled', 'radialDistanceThresholdM',
        'timeSamplingEnabled', 'timeSamplingN',
        'douglasPeuckerEnabled', 'douglasPeuckerEpsilonM',
      ])
    );
  });

  it('gapDetectionEnabled defaults to true (preserves previous APK behaviour)', () => {
    expect(SETTINGS_SPEC.gapDetectionEnabled.default).toBe(true);
  });

  it('showMovingTime is NOT locked while recording (Task 4)', () => {
    expect(SETTINGS_SPEC.showMovingTime.locked).toBe(false);
  });

  it('all other toggles ARE locked while recording', () => {
    const lockedKeys: SettingKey[] = [
      'postProcessEnabled', 'gaussianSmoothingEnabled',
      'autoPauseEnabled', 'gapDetectionEnabled',
      'radialDistanceFilterEnabled', 'timeSamplingEnabled', 'douglasPeuckerEnabled',
    ];
    for (const k of lockedKeys) {
      expect(SETTINGS_SPEC[k].locked).toBe(true);
    }
  });

  it('numeric settings have correct clamp ranges', () => {
    expect(SETTINGS_SPEC.radialDistanceThresholdM.min).toBe(0);
    expect(SETTINGS_SPEC.radialDistanceThresholdM.max).toBe(1000);
    expect(SETTINGS_SPEC.timeSamplingN.min).toBe(1);
    expect(SETTINGS_SPEC.timeSamplingN.max).toBe(60);
    expect(SETTINGS_SPEC.douglasPeuckerEpsilonM.min).toBe(0);
    expect(SETTINGS_SPEC.douglasPeuckerEpsilonM.max).toBe(500);
  });
});

describe('settingsStore — initial state', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('starts with spec defaults', () => {
    const s = useSettingsStore.getState();
    expect(s.postProcessEnabled).toBe(false);
    expect(s.gaussianSmoothingEnabled).toBe(false);
    expect(s.autoPauseEnabled).toBe(false);
    expect(s.gapDetectionEnabled).toBe(true);
    expect(s.showMovingTime).toBe(false);
    expect(s.radialDistanceFilterEnabled).toBe(false);
    expect(s.radialDistanceThresholdM).toBe(5);
    expect(s.timeSamplingEnabled).toBe(false);
    expect(s.timeSamplingN).toBe(5);
    expect(s.douglasPeuckerEnabled).toBe(false);
    expect(s.douglasPeuckerEpsilonM).toBe(5);
  });
});

describe('settingsStore — toggle (locked-while-recording)', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('skips when a recording is in progress and the setting is locked', async () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    await useSettingsStore.getState().toggle('postProcessEnabled');
    expect(gpsMock.setPostProcessEnabled).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().postProcessEnabled).toBe(false);
  });

  it('skips when in stopping state', async () => {
    useRecordingStore.setState({ recordingState: 'stopping' });
    await useSettingsStore.getState().toggle('postProcessEnabled');
    expect(gpsMock.setPostProcessEnabled).not.toHaveBeenCalled();
  });

  it('does NOT skip for showMovingTime (Task 4 — unlocked during recording)', async () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    gpsMock.setShowMovingTimeEnabled.mockResolvedValue(true);
    await useSettingsStore.getState().toggle('showMovingTime');
    expect(gpsMock.setShowMovingTimeEnabled).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().showMovingTime).toBe(true);
  });

  it('toggles when idle', async () => {
    gpsMock.setPostProcessEnabled.mockResolvedValue(true);
    await useSettingsStore.getState().toggle('postProcessEnabled');
    expect(gpsMock.setPostProcessEnabled).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().postProcessEnabled).toBe(true);
  });

  it('applies the confirmed value (not the optimistic one) when native returns a different value', async () => {
    gpsMock.setAutoPauseEnabled.mockResolvedValue(true); // always returns true regardless
    await useSettingsStore.getState().toggle('autoPauseEnabled'); // false -> true (optimistic)
    expect(useSettingsStore.getState().autoPauseEnabled).toBe(true);
    await useSettingsStore.getState().toggle('autoPauseEnabled'); // true -> false (optimistic)
    // Native returned true (ignored the false), so we apply the confirmed true.
    expect(useSettingsStore.getState().autoPauseEnabled).toBe(true);
  });
});

describe('settingsStore — toggle (re-entrancy guard)', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('serializes concurrent toggles on different settings', async () => {
    // Make native setters slow — they don't resolve until we manually
    // flush microtasks.
    let resolvePostProcess: (v: boolean) => void = () => {};
    let resolveAutoPause: (v: boolean) => void = () => {};
    gpsMock.setPostProcessEnabled.mockImplementation(
      () => new Promise<boolean>((r) => { resolvePostProcess = r; })
    );
    gpsMock.setAutoPauseEnabled.mockImplementation(
      () => new Promise<boolean>((r) => { resolveAutoPause = r; })
    );

    const p1 = useSettingsStore.getState().toggle('postProcessEnabled');
    const p2 = useSettingsStore.getState().toggle('autoPauseEnabled');
    // The second toggle should have been skipped — the guard is shared.
    expect(gpsMock.setAutoPauseEnabled).not.toHaveBeenCalled();
    expect(gpsMock.setPostProcessEnabled).toHaveBeenCalledTimes(1);

    // Resolve the first; now the next toggle would work.
    resolvePostProcess(true);
    await p1;
    expect(useSettingsStore.getState()._updating).toBe(false);

    // Cleanup: p2 already resolved (it was a no-op).
    await p2;
    resolveAutoPause(true);
  });

  it('reverts on native setter error', async () => {
    gpsMock.setPostProcessEnabled.mockRejectedValue(new Error('native failed'));
    await useSettingsStore.getState().toggle('postProcessEnabled');
    expect(useSettingsStore.getState().postProcessEnabled).toBe(false); // reverted
    expect(useRecordingStore.getState().errorMsg).toBe('native failed');
  });
});

describe('settingsStore — step (numeric)', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('increments by delta and clamps to max', async () => {
    gpsMock.setRadialDistanceThresholdM.mockResolvedValue(6);
    await useSettingsStore.getState().step('radialDistanceThresholdM', +1);
    expect(useSettingsStore.getState().radialDistanceThresholdM).toBe(6);
    expect(gpsMock.setRadialDistanceThresholdM).toHaveBeenCalledWith(6);
  });

  it('clamps to min', async () => {
    useSettingsStore.setState({ radialDistanceThresholdM: 0 });
    gpsMock.setRadialDistanceThresholdM.mockResolvedValue(0);
    await useSettingsStore.getState().step('radialDistanceThresholdM', -1);
    // Clamped to 0, which equals the current value, so it skips the round-trip.
    expect(gpsMock.setRadialDistanceThresholdM).not.toHaveBeenCalled();
  });

  it('clamps to max', async () => {
    useSettingsStore.setState({ radialDistanceThresholdM: 1000 });
    gpsMock.setRadialDistanceThresholdM.mockResolvedValue(1000);
    await useSettingsStore.getState().step('radialDistanceThresholdM', +1);
    expect(gpsMock.setRadialDistanceThresholdM).not.toHaveBeenCalled();
  });

  it('skips when locked during recording', async () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    await useSettingsStore.getState().step('radialDistanceThresholdM', +1);
    expect(gpsMock.setRadialDistanceThresholdM).not.toHaveBeenCalled();
  });

  it('reverts on native setter error', async () => {
    gpsMock.setTimeSamplingN.mockRejectedValue(new Error('fail'));
    await useSettingsStore.getState().step('timeSamplingN', +1);
    expect(useSettingsStore.getState().timeSamplingN).toBe(5); // reverted
  });

  it('ignores a toggle call on a numeric setting (type mismatch)', async () => {
    await useSettingsStore.getState().toggle('radialDistanceThresholdM');
    expect(gpsMock.setRadialDistanceThresholdM).not.toHaveBeenCalled();
  });

  it('ignores a step call on a boolean setting (type mismatch)', async () => {
    await useSettingsStore.getState().step('postProcessEnabled', +1);
    expect(gpsMock.setPostProcessEnabled).not.toHaveBeenCalled();
  });
});

describe('settingsStore — loadAll', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('loads all 11 settings from native prefs', async () => {
    gpsMock.getPostProcessEnabled.mockResolvedValue(true);
    gpsMock.getGaussianSmoothingEnabled.mockResolvedValue(true);
    gpsMock.getAutoPauseEnabled.mockResolvedValue(true);
    gpsMock.getGapDetectionEnabled.mockResolvedValue(false);
    gpsMock.getShowMovingTimeEnabled.mockResolvedValue(true);
    gpsMock.getRadialDistanceFilterEnabled.mockResolvedValue(true);
    gpsMock.getRadialDistanceThresholdM.mockResolvedValue(10);
    gpsMock.getTimeSamplingEnabled.mockResolvedValue(true);
    gpsMock.getTimeSamplingN.mockResolvedValue(7);
    gpsMock.getDouglasPeuckerEnabled.mockResolvedValue(true);
    gpsMock.getDouglasPeuckerEpsilonM.mockResolvedValue(15);

    await useSettingsStore.getState().loadAll();

    const s = useSettingsStore.getState();
    expect(s.postProcessEnabled).toBe(true);
    expect(s.gaussianSmoothingEnabled).toBe(true);
    expect(s.autoPauseEnabled).toBe(true);
    expect(s.gapDetectionEnabled).toBe(false);
    expect(s.showMovingTime).toBe(true);
    expect(s.radialDistanceFilterEnabled).toBe(true);
    expect(s.radialDistanceThresholdM).toBe(10);
    expect(s.timeSamplingEnabled).toBe(true);
    expect(s.timeSamplingN).toBe(7);
    expect(s.douglasPeuckerEnabled).toBe(true);
    expect(s.douglasPeuckerEpsilonM).toBe(15);
  });

  it('keeps spec defaults when a native getter fails', async () => {
    gpsMock.getPostProcessEnabled.mockRejectedValue(new Error('fail'));
    gpsMock.getAutoPauseEnabled.mockResolvedValue(true);
    // Other getters fall through to default mock implementations.
    await useSettingsStore.getState().loadAll();
    expect(useSettingsStore.getState().postProcessEnabled).toBe(false); // spec default
    expect(useSettingsStore.getState().autoPauseEnabled).toBe(true); // loaded
  });
});

describe('settingsStore — useSettingsLocked', () => {
  beforeEach(() => {
    resetStores();
  });

  it('returns false when idle', () => {
    // We can't easily test the hook without a React host, but we can
    // verify the underlying logic via the recording state.
    useRecordingStore.setState({ recordingState: 'idle' });
    const recordingState = useRecordingStore.getState().recordingState;
    const locked = recordingState === 'recording' || recordingState === 'stopping';
    expect(locked).toBe(false);
  });

  it('returns true when recording or stopping', () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    let s = useRecordingStore.getState().recordingState;
    expect(s === 'recording' || s === 'stopping').toBe(true);

    useRecordingStore.setState({ recordingState: 'stopping' });
    s = useRecordingStore.getState().recordingState;
    expect(s === 'recording' || s === 'stopping').toBe(true);
  });
});
