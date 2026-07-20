/**
 * Tests for the usePermissions hook.
 *
 * Coverage:
 *   - Initial state: hasPermissions=false, waitingForPermissions=false,
 *     batteryOptDenied=false.
 *   - handleCancelPermissionWait: sets the cancel ref + clears
 *     waitingForPermissions.
 *   - handleRetryBatteryOpt: invokes the native call, sets batteryOptDenied
 *     based on the returned boolean.
 *   - initialCheck: when hasPermissions() returns true, does NOT call
 *     requestPermissions().
 *   - initialCheck: when hasPermissions() returns false, calls
 *     requestPermissions() then re-checks.
 *   - handleGrantPermissions: calls requestPermissions, waits 800 ms, then
 *     re-checks and starts the GNSS monitor if granted.
 *
 * TIMER HANDLING PATTERN:
 * The hook uses `await new Promise(r => setTimeout(r, 800))` to wait for
 * the native side to settle. With Jest fake timers, we MUST advance the
 * fake clock BEFORE awaiting the hook's promise — otherwise the hook's
 * internal `await` never resolves and the test deadlocks. The pattern is:
 *
 *   let p: Promise<void>;
 *   act(() => { p = result.current.handleGrantPermissions(); });
 *   await act(async () => {
 *     jest.advanceTimersByTime(800);  // ← advances past the setTimeout
 *     await p;                         // ← now the hook resolves
 *   });
 */
import { usePermissions } from '../../src/hooks/usePermissions';
import { renderHook, act } from '../helpers/renderHook';
import { gpsMock, clearGpsMock, makeRef } from '../helpers';
import { NativeModules } from 'react-native';
import type { RecordingState } from '../../src/styles';

function recordingStateRef() {
  return makeRef<RecordingState>('idle');
}

beforeEach(() => {
  jest.useFakeTimers();
  clearGpsMock();
});

afterEach(() => {
  // Drain any pending fake-timer callbacks so they don't leak into the
  // next test file.
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

describe('usePermissions — initial state', () => {
  it('starts with hasPermissions=false, waitingForPermissions=false, batteryOptDenied=false', () => {
    const { result } = renderHook(usePermissions, recordingStateRef());
    expect(result.current.hasPermissions).toBe(false);
    expect(result.current.waitingForPermissions).toBe(false);
    expect(result.current.batteryOptDenied).toBe(false);
  });

  it('returns the 2 refs (cancelPermissionWaitRef, hasAskedBatteryOptRef) initialized to false', () => {
    const { result } = renderHook(usePermissions, recordingStateRef());
    expect(result.current.cancelPermissionWaitRef.current).toBe(false);
    expect(result.current.hasAskedBatteryOptRef.current).toBe(false);
  });

  it('returns all 3 setters (setHasPermissions, setWaitingForPermissions, setBatteryOptDenied)', () => {
    const { result } = renderHook(usePermissions, recordingStateRef());
    expect(typeof result.current.setHasPermissions).toBe('function');
    expect(typeof result.current.setWaitingForPermissions).toBe('function');
    expect(typeof result.current.setBatteryOptDenied).toBe('function');
  });
});

describe('usePermissions — handleCancelPermissionWait', () => {
  it('sets cancelPermissionWaitRef.current to true', () => {
    const { result } = renderHook(usePermissions, recordingStateRef());
    act(() => {
      result.current.handleCancelPermissionWait();
    });
    expect(result.current.cancelPermissionWaitRef.current).toBe(true);
  });

  it('clears waitingForPermissions to false', () => {
    const { result } = renderHook(usePermissions, recordingStateRef());
    act(() => {
      result.current.setWaitingForPermissions(true);
    });
    act(() => {
      result.current.handleCancelPermissionWait();
    });
    expect(result.current.waitingForPermissions).toBe(false);
  });
});

describe('usePermissions — handleRetryBatteryOpt', () => {
  it('calls GpsRecorder.requestIgnoreBatteryOptimizations once', async () => {
    const { result } = renderHook(usePermissions, recordingStateRef());
    await act(async () => {
      await result.current.handleRetryBatteryOpt();
    });
    expect(NativeModules.GpsRecorder!.requestIgnoreBatteryOptimizations)
      .toHaveBeenCalledTimes(1);
  });

  it('sets batteryOptDenied=false when the native call returns true (granted)', async () => {
    (gpsMock.requestIgnoreBatteryOptimizations as jest.Mock).mockResolvedValueOnce(true);
    const { result } = renderHook(usePermissions, recordingStateRef());
    await act(async () => {
      await result.current.handleRetryBatteryOpt();
    });
    expect(result.current.batteryOptDenied).toBe(false);
  });

  it('sets batteryOptDenied=true when the native call returns false (denied)', async () => {
    (gpsMock.requestIgnoreBatteryOptimizations as jest.Mock).mockResolvedValueOnce(false);
    const { result } = renderHook(usePermissions, recordingStateRef());
    await act(async () => {
      await result.current.handleRetryBatteryOpt();
    });
    expect(result.current.batteryOptDenied).toBe(true);
  });

  it('sets batteryOptDenied=true when the native call rejects', async () => {
    (gpsMock.requestIgnoreBatteryOptimizations as jest.Mock).mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(usePermissions, recordingStateRef());
    await act(async () => {
      await result.current.handleRetryBatteryOpt();
    });
    expect(result.current.batteryOptDenied).toBe(true);
  });
});

describe('usePermissions — initialCheck', () => {
  it('sets hasPermissions=true when hasPermissions() returns true (no requestPermissions call)', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(true);
    const { result } = renderHook(usePermissions, recordingStateRef());
    await act(async () => {
      const granted = await result.current.initialCheck();
      expect(granted).toBe(true);
    });
    expect(result.current.hasPermissions).toBe(true);
    expect(NativeModules.GpsRecorder!.requestPermissions).not.toHaveBeenCalled();
  });

  it('calls requestPermissions when hasPermissions() returns false', async () => {
    (gpsMock.hasPermissions as jest.Mock)
      .mockResolvedValueOnce(false)   // first call: not granted
      .mockResolvedValueOnce(true);  // second call (after wait): granted
    const { result } = renderHook(usePermissions, recordingStateRef());
    let p: Promise<boolean> | undefined;
    act(() => {
      p = result.current.initialCheck();
    });
    await act(async () => {
      // Flush microtasks (requestPermissions resolves) → then advance the
      // 800ms fake timer → then flush microtasks again (second
      // hasPermissions resolves).
      await jest.advanceTimersByTimeAsync(800);
      const granted = await p!;
      expect(granted).toBe(true);
    });
    expect(NativeModules.GpsRecorder!.requestPermissions).toHaveBeenCalledTimes(1);
    expect(result.current.hasPermissions).toBe(true);
  });

  it('returns false when neither hasPermissions() nor requestPermissions grants permission', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(false);
    (gpsMock.requestPermissions as jest.Mock).mockResolvedValue(false);
    const { result } = renderHook(usePermissions, recordingStateRef());
    let p: Promise<boolean> | undefined;
    act(() => {
      p = result.current.initialCheck();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(800);
      const granted = await p!;
      expect(granted).toBe(false);
    });
    expect(result.current.hasPermissions).toBe(false);
  });
});

describe('usePermissions — handleGrantPermissions', () => {
  it('calls requestPermissions, waits 800ms, then re-checks hasPermissions', async () => {
    (gpsMock.requestPermissions as jest.Mock).mockResolvedValue(true);
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(true);
    const { result } = renderHook(usePermissions, recordingStateRef());
    let p: Promise<void> | undefined;
    act(() => {
      p = result.current.handleGrantPermissions();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(800);
      await p!;
    });
    expect(NativeModules.GpsRecorder!.requestPermissions).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.hasPermissions).toHaveBeenCalledTimes(1);
    expect(result.current.hasPermissions).toBe(true);
  });

  it('starts the GNSS monitor when permissions are granted', async () => {
    (gpsMock.requestPermissions as jest.Mock).mockResolvedValue(true);
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(true);
    const { result } = renderHook(usePermissions, recordingStateRef());
    let p: Promise<void> | undefined;
    act(() => {
      p = result.current.handleGrantPermissions();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(800);
      await p!;
    });
    expect(NativeModules.GpsRecorder!.startGnssMonitor).toHaveBeenCalledTimes(1);
  });

  it('does NOT start the GNSS monitor when permissions are not granted', async () => {
    (gpsMock.requestPermissions as jest.Mock).mockResolvedValue(false);
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(false);
    const { result } = renderHook(usePermissions, recordingStateRef());
    let p: Promise<void> | undefined;
    act(() => {
      p = result.current.handleGrantPermissions();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(800);
      await p!;
    });
    expect(NativeModules.GpsRecorder!.startGnssMonitor).not.toHaveBeenCalled();
  });
});
