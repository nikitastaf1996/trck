/**
 * Tests for the useSettings hook.
 *
 * Coverage:
 *   - Initial state: 11 settings + 3 mirror refs initialized to defaults.
 *   - settingsLocked=true: every handler (except showMovingTime) returns
 *     early without calling the native setter.
 *   - settingsLocked=false: each toggle handler does the optimistic update
 *     + native call + confirmed-value update.
 *   - showMovingTime is intentionally NOT locked (Task 4).
 *   - U15 re-entrancy: a second concurrent handler call returns early.
 *   - Stepper handlers clamp to the same range as the native side.
 *   - On native setter rejection, the handler reverts the optimistic update
 *     and calls setErrorMsg.
 */
import { useSettings } from '../../src/hooks/useSettings';
import { renderHook, act } from '../helpers/renderHook';
import { gpsMock, clearGpsMock } from '../helpers';
import { NativeModules } from 'react-native';

beforeEach(() => {
  clearGpsMock();
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

describe('useSettings — initial state', () => {
  function setup() {
    return renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
  }

  it('initializes all 11 settings to their defaults', () => {
    const { result } = setup();
    expect(result.current.postProcessEnabled).toBe(false);
    expect(result.current.gaussianSmoothingEnabled).toBe(false);
    expect(result.current.autoPauseEnabled).toBe(false);
    expect(result.current.gapDetectionEnabled).toBe(true); // default true
    expect(result.current.showMovingTime).toBe(false);
    expect(result.current.radialDistanceFilterEnabled).toBe(false);
    expect(result.current.radialDistanceThresholdM).toBe(5);
    expect(result.current.timeSamplingEnabled).toBe(false);
    expect(result.current.timeSamplingN).toBe(5);
    expect(result.current.douglasPeuckerEnabled).toBe(false);
    expect(result.current.douglasPeuckerEpsilonM).toBe(5);
  });

  it('initializes the 3 mirror refs to their defaults', () => {
    const { result } = setup();
    expect(result.current.autoPauseEnabledRef.current).toBe(false);
    expect(result.current.gapDetectionEnabledRef.current).toBe(true);
    expect(result.current.showMovingTimeRef.current).toBe(false);
  });

  it('returns all 11 handlers + loadSettings as functions', () => {
    const { result } = setup();
    [
      'handleTogglePostProcess',
      'handleToggleGaussianSmoothing',
      'handleToggleAutoPause',
      'handleToggleGapDetection',
      'handleToggleShowMovingTime',
      'handleToggleRadialDistanceFilter',
      'handleStepperRadialThreshold',
      'handleToggleTimeSampling',
      'handleStepperTimeSamplingN',
      'handleToggleDouglasPeucker',
      'handleStepperDouglasPeuckerEpsilon',
      'loadSettings',
    ].forEach((name) => {
      expect(typeof (result.current as Record<string, unknown>)[name]).toBe('function');
    });
  });
});

describe('useSettings — settingsLocked=true', () => {
  function setup() {
    return renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      true,
    );
  }

  it('handleTogglePostProcess returns early (no native call)', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleTogglePostProcess();
    });
    expect(NativeModules.GpsRecorder!.setPostProcessEnabled).not.toHaveBeenCalled();
  });

  it('handleToggleGaussianSmoothing returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleToggleGaussianSmoothing();
    });
    expect(NativeModules.GpsRecorder!.setGaussianSmoothingEnabled).not.toHaveBeenCalled();
  });

  it('handleToggleAutoPause returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleToggleAutoPause();
    });
    expect(NativeModules.GpsRecorder!.setAutoPauseEnabled).not.toHaveBeenCalled();
  });

  it('handleToggleGapDetection returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleToggleGapDetection();
    });
    expect(NativeModules.GpsRecorder!.setGapDetectionEnabled).not.toHaveBeenCalled();
  });

  it('handleToggleRadialDistanceFilter returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleToggleRadialDistanceFilter();
    });
    expect(NativeModules.GpsRecorder!.setRadialDistanceFilterEnabled).not.toHaveBeenCalled();
  });

  it('handleStepperRadialThreshold returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleStepperRadialThreshold(+1);
    });
    expect(NativeModules.GpsRecorder!.setRadialDistanceThresholdM).not.toHaveBeenCalled();
  });

  it('handleToggleTimeSampling returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleToggleTimeSampling();
    });
    expect(NativeModules.GpsRecorder!.setTimeSamplingEnabled).not.toHaveBeenCalled();
  });

  it('handleStepperTimeSamplingN returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleStepperTimeSamplingN(+1);
    });
    expect(NativeModules.GpsRecorder!.setTimeSamplingN).not.toHaveBeenCalled();
  });

  it('handleToggleDouglasPeucker returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleToggleDouglasPeucker();
    });
    expect(NativeModules.GpsRecorder!.setDouglasPeuckerEnabled).not.toHaveBeenCalled();
  });

  it('handleStepperDouglasPeuckerEpsilon returns early', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleStepperDouglasPeuckerEpsilon(+1);
    });
    expect(NativeModules.GpsRecorder!.setDouglasPeuckerEpsilonM).not.toHaveBeenCalled();
  });

  it('handleToggleShowMovingTime is NOT blocked by settingsLocked (Task 4)', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleToggleShowMovingTime();
    });
    // The native setter IS called even when settingsLocked is true.
    expect(NativeModules.GpsRecorder!.setShowMovingTimeEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('useSettings — toggle handlers (settingsLocked=false)', () => {
  function setup() {
    return renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
  }

  it('handleTogglePostProcess: optimistic update + native call + confirmed update', async () => {
    (gpsMock.setPostProcessEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = setup();
    expect(result.current.postProcessEnabled).toBe(false);
    let p: Promise<void> | undefined;
    act(() => {
      p = result.current.handleTogglePostProcess();
    });
    // Optimistic update should have flipped to true synchronously.
    expect(result.current.postProcessEnabled).toBe(true);
    await act(async () => { await p!; });
    expect(NativeModules.GpsRecorder!.setPostProcessEnabled).toHaveBeenCalledWith(true);
    expect(result.current.postProcessEnabled).toBe(true); // confirmed value
  });

  it('handleTogglePostProcess: reverts on native rejection + surfaces error', async () => {
    const setErrorMsg = jest.fn();
    const { result } = renderHook(
      (locked: boolean) => useSettings(locked, setErrorMsg),
      false,
    );
    (gpsMock.setPostProcessEnabled as jest.Mock).mockRejectedValueOnce(new Error('nope'));
    let p: Promise<void> | undefined;
    act(() => {
      p = result.current.handleTogglePostProcess();
    });
    expect(result.current.postProcessEnabled).toBe(true); // optimistic
    await act(async () => { await p!; });
    expect(result.current.postProcessEnabled).toBe(false); // reverted
    expect(setErrorMsg).toHaveBeenCalledWith('nope');
  });

  it('handleToggleGaussianSmoothing: flips false→true', async () => {
    (gpsMock.setGaussianSmoothingEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleGaussianSmoothing(); });
    await act(async () => { await p!; });
    expect(result.current.gaussianSmoothingEnabled).toBe(true);
  });

  it('handleToggleAutoPause: flips false→true', async () => {
    (gpsMock.setAutoPauseEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleAutoPause(); });
    await act(async () => { await p!; });
    expect(result.current.autoPauseEnabled).toBe(true);
  });

  it('handleToggleGapDetection: flips true→false (default is true)', async () => {
    (gpsMock.setGapDetectionEnabled as jest.Mock).mockResolvedValueOnce(false);
    const { result } = setup();
    expect(result.current.gapDetectionEnabled).toBe(true); // default
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleGapDetection(); });
    expect(result.current.gapDetectionEnabled).toBe(false); // optimistic
    await act(async () => { await p!; });
    expect(result.current.gapDetectionEnabled).toBe(false); // confirmed
  });

  it('handleToggleShowMovingTime: flips false→true and updates the ref synchronously', async () => {
    (gpsMock.setShowMovingTimeEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleShowMovingTime(); });
    // showMovingTimeRef is updated synchronously by the handler (not via
    // the mirror effect that updates the other 2 refs).
    expect(result.current.showMovingTimeRef.current).toBe(true);
    await act(async () => { await p!; });
    expect(result.current.showMovingTime).toBe(true);
  });

  it('handleToggleRadialDistanceFilter: flips false→true', async () => {
    (gpsMock.setRadialDistanceFilterEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleRadialDistanceFilter(); });
    await act(async () => { await p!; });
    expect(result.current.radialDistanceFilterEnabled).toBe(true);
  });

  it('handleToggleTimeSampling: flips false→true', async () => {
    (gpsMock.setTimeSamplingEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleTimeSampling(); });
    await act(async () => { await p!; });
    expect(result.current.timeSamplingEnabled).toBe(true);
  });

  it('handleToggleDouglasPeucker: flips false→true', async () => {
    (gpsMock.setDouglasPeuckerEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleDouglasPeucker(); });
    await act(async () => { await p!; });
    expect(result.current.douglasPeuckerEnabled).toBe(true);
  });
});

describe('useSettings — stepper handlers (settingsLocked=false)', () => {
  function setup() {
    return renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
  }

  it('handleStepperRadialThreshold: increments by 1 and clamps to 1000', async () => {
    (gpsMock.setRadialDistanceThresholdM as jest.Mock).mockResolvedValueOnce(6);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleStepperRadialThreshold(+1); });
    await act(async () => { await p!; });
    expect(NativeModules.GpsRecorder!.setRadialDistanceThresholdM).toHaveBeenCalledWith(6);
    expect(result.current.radialDistanceThresholdM).toBe(6);
  });

  it('handleStepperRadialThreshold: clamps to 0 at the lower bound', async () => {
    (gpsMock.setRadialDistanceThresholdM as jest.Mock).mockResolvedValueOnce(0);
    const { result } = setup();
    // Set to 0 first.
    act(() => {
      // Decrement by 10 — should clamp to 0.
    });
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleStepperRadialThreshold(-10); });
    await act(async () => { await p!; });
    expect(NativeModules.GpsRecorder!.setRadialDistanceThresholdM).toHaveBeenCalledWith(0);
    expect(result.current.radialDistanceThresholdM).toBe(0);
  });

  it('handleStepperRadialThreshold: clamps to 1000 at the upper bound', async () => {
    (gpsMock.setRadialDistanceThresholdM as jest.Mock).mockResolvedValueOnce(1000);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleStepperRadialThreshold(+10_000); });
    await act(async () => { await p!; });
    expect(NativeModules.GpsRecorder!.setRadialDistanceThresholdM).toHaveBeenCalledWith(1000);
  });

  it('handleStepperTimeSamplingN: clamps to [1, 60]', async () => {
    (gpsMock.setTimeSamplingN as jest.Mock).mockResolvedValueOnce(1);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleStepperTimeSamplingN(-10); });
    await act(async () => { await p!; });
    expect(NativeModules.GpsRecorder!.setTimeSamplingN).toHaveBeenCalledWith(1);
  });

  it('handleStepperDouglasPeuckerEpsilon: clamps to [0, 500]', async () => {
    (gpsMock.setDouglasPeuckerEpsilonM as jest.Mock).mockResolvedValueOnce(500);
    const { result } = setup();
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleStepperDouglasPeuckerEpsilon(+10_000); });
    await act(async () => { await p!; });
    expect(NativeModules.GpsRecorder!.setDouglasPeuckerEpsilonM).toHaveBeenCalledWith(500);
  });

  it('stepper handler skips the native call when the clamped value equals the current value', async () => {
    const { result } = setup();
    // radialDistanceThresholdM defaults to 5. Asking for -100 should
    // clamp to 0, which != 5, so the call proceeds. Let's test the
    // boundary case instead: set to 5, then increment by 0.
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleStepperRadialThreshold(0); });
    await act(async () => { await p!; });
    // 5 + 0 = 5, equals the current value → no native call.
    expect(NativeModules.GpsRecorder!.setRadialDistanceThresholdM).not.toHaveBeenCalled();
  });
});

describe('useSettings — U15 re-entrancy guard', () => {
  it('a second concurrent handler call returns early without calling the native setter twice', async () => {
    (gpsMock.setPostProcessEnabled as jest.Mock).mockResolvedValue(true);
    const { result } = renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
    let p1: Promise<void> | undefined;
    let p2: Promise<void> | undefined;
    act(() => {
      p1 = result.current.handleTogglePostProcess();
      // Second call BEFORE p1 resolves — should be a no-op.
      p2 = result.current.handleTogglePostProcess();
    });
    await act(async () => {
      await p1;
      await p2;
    });
    // Only ONE native call should have happened — the second was blocked.
    expect(NativeModules.GpsRecorder!.setPostProcessEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('useSettings — loadSettings', () => {
  it('loads all 11 settings from native prefs', async () => {
    (gpsMock.getPostProcessEnabled as jest.Mock).mockResolvedValueOnce(true);
    (gpsMock.getGaussianSmoothingEnabled as jest.Mock).mockResolvedValueOnce(true);
    (gpsMock.getAutoPauseEnabled as jest.Mock).mockResolvedValueOnce(true);
    (gpsMock.getGapDetectionEnabled as jest.Mock).mockResolvedValueOnce(false);
    (gpsMock.getShowMovingTimeEnabled as jest.Mock).mockResolvedValueOnce(true);
    (gpsMock.getRadialDistanceFilterEnabled as jest.Mock).mockResolvedValueOnce(true);
    (gpsMock.getRadialDistanceThresholdM as jest.Mock).mockResolvedValueOnce(42);
    (gpsMock.getTimeSamplingEnabled as jest.Mock).mockResolvedValueOnce(true);
    (gpsMock.getTimeSamplingN as jest.Mock).mockResolvedValueOnce(7);
    (gpsMock.getDouglasPeuckerEnabled as jest.Mock).mockResolvedValueOnce(true);
    (gpsMock.getDouglasPeuckerEpsilonM as jest.Mock).mockResolvedValueOnce(11.5);

    const { result } = renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
    await act(async () => {
      await result.current.loadSettings();
    });
    expect(result.current.postProcessEnabled).toBe(true);
    expect(result.current.gaussianSmoothingEnabled).toBe(true);
    expect(result.current.autoPauseEnabled).toBe(true);
    expect(result.current.gapDetectionEnabled).toBe(false);
    expect(result.current.showMovingTime).toBe(true);
    expect(result.current.radialDistanceFilterEnabled).toBe(true);
    expect(result.current.radialDistanceThresholdM).toBe(42);
    expect(result.current.timeSamplingEnabled).toBe(true);
    expect(result.current.timeSamplingN).toBe(7);
    expect(result.current.douglasPeuckerEnabled).toBe(true);
    expect(result.current.douglasPeuckerEpsilonM).toBe(11.5);
  });

  it('does NOT throw when a single getter rejects (the rest still load)', async () => {
    (gpsMock.getPostProcessEnabled as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    (gpsMock.getGaussianSmoothingEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
    await act(async () => {
      await result.current.loadSettings();
    });
    // The Gaussian setter should have succeeded even though postProcess failed.
    expect(result.current.gaussianSmoothingEnabled).toBe(true);
    // postProcess retains its default (false) since the load failed.
    expect(result.current.postProcessEnabled).toBe(false);
  });
});

describe('useSettings — mirror effects', () => {
  it('the autoPauseEnabledRef mirrors autoPauseEnabled state', async () => {
    (gpsMock.setAutoPauseEnabled as jest.Mock).mockResolvedValueOnce(true);
    const { result } = renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleAutoPause(); });
    await act(async () => { await p!; });
    // The mirror effect runs after state updates — give it a microtask.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.autoPauseEnabledRef.current).toBe(true);
  });

  it('the gapDetectionEnabledRef mirrors gapDetectionEnabled state', async () => {
    (gpsMock.setGapDetectionEnabled as jest.Mock).mockResolvedValueOnce(false);
    const { result } = renderHook(
      (locked: boolean) => useSettings(locked, jest.fn()),
      false,
    );
    let p: Promise<void> | undefined;
    act(() => { p = result.current.handleToggleGapDetection(); });
    await act(async () => { await p!; });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.gapDetectionEnabledRef.current).toBe(false);
  });
});
