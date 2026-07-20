/**
 * Tests for the useGnssMonitor hook.
 *
 * Coverage:
 *   - Initial state: fixType='no fix', accuracy=null, hasFix=false, sat counts=0.
 *   - handleGnssEvent updates all 5 state vars together.
 *   - resetGnss clears fixType / hasFix / accuracy.
 *   - startMonitor / stopMonitor are thin wrappers around GpsRecorder.
 *   - The individual setters update only the targeted field.
 */
import { useGnssMonitor } from '../../src/hooks/useGnssMonitor';
import { renderHook, act } from '../helpers/renderHook';
import { gpsMock, clearGpsMock, makeRef } from '../helpers';
import { NativeModules } from 'react-native';
import type { GpsGnssEvent } from '../../src/NativeGpsRecorder';
import type { RecordingState } from '../../src/styles';

function recordingStateRef() {
  return makeRef<RecordingState>('idle');
}

beforeEach(() => {
  clearGpsMock();
});

describe('useGnssMonitor — initial state', () => {
  it('starts with fixType="no fix", accuracy=null, satellitesUsed=0, satellitesInView=0, hasFix=false', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    expect(result.current.fixType).toBe('no fix');
    expect(result.current.accuracy).toBeNull();
    expect(result.current.satellitesUsed).toBe(0);
    expect(result.current.satellitesInView).toBe(0);
    expect(result.current.hasFix).toBe(false);
  });

  it('returns the 3 individual setters', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    expect(typeof result.current.setFixType).toBe('function');
    expect(typeof result.current.setAccuracy).toBe('function');
    expect(typeof result.current.setHasFix).toBe('function');
  });

  it('returns the 4 methods (handleGnssEvent, resetGnss, startMonitor, stopMonitor)', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    expect(typeof result.current.handleGnssEvent).toBe('function');
    expect(typeof result.current.resetGnss).toBe('function');
    expect(typeof result.current.startMonitor).toBe('function');
    expect(typeof result.current.stopMonitor).toBe('function');
  });
});

describe('useGnssMonitor — handleGnssEvent', () => {
  function makeEv(over: Partial<GpsGnssEvent> = {}): GpsGnssEvent {
    return {
      fixType: '3D fix',
      accuracy: 5,
      satellitesUsed: 9,
      satellitesInView: 14,
      hasFix: true,
      lat: 55.0,
      lon: 37.0,
      alt: 150.0,
      speed: 3.0,
      timestamp: Date.now(),
      ...over,
    };
  }

  it('updates all 5 state vars from the event', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.handleGnssEvent(makeEv());
    });
    expect(result.current.fixType).toBe('3D fix');
    expect(result.current.accuracy).toBe(5);
    expect(result.current.satellitesUsed).toBe(9);
    expect(result.current.satellitesInView).toBe(14);
    expect(result.current.hasFix).toBe(true);
  });

  it('overwrites the previous values when a new event arrives', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.handleGnssEvent(makeEv({ accuracy: 5, satellitesUsed: 9 }));
    });
    act(() => {
      result.current.handleGnssEvent(makeEv({ accuracy: 50, satellitesUsed: 4 }));
    });
    expect(result.current.accuracy).toBe(50);
    expect(result.current.satellitesUsed).toBe(4);
  });

  it('handles a "no fix" event correctly', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.handleGnssEvent(
        makeEv({ fixType: 'no fix', accuracy: null, satellitesUsed: 0, hasFix: false })
      );
    });
    expect(result.current.fixType).toBe('no fix');
    expect(result.current.accuracy).toBeNull();
    expect(result.current.hasFix).toBe(false);
  });

  it('handles null accuracy in a fix event (partial state)', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.handleGnssEvent(
        makeEv({ accuracy: null, hasFix: true, fixType: '2D fix' })
      );
    });
    expect(result.current.fixType).toBe('2D fix');
    expect(result.current.accuracy).toBeNull();
    expect(result.current.hasFix).toBe(true);
  });
});

describe('useGnssMonitor — resetGnss', () => {
  it('clears fixType, hasFix, and accuracy to their initial values', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    // Set some non-default values first.
    act(() => {
      result.current.handleGnssEvent({
        fixType: '3D fix',
        accuracy: 5,
        satellitesUsed: 9,
        satellitesInView: 14,
        hasFix: true,
        lat: 55.0,
        lon: 37.0,
        alt: 150.0,
        speed: 3.0,
        timestamp: Date.now(),
      });
    });
    // Sanity check: state changed.
    expect(result.current.fixType).toBe('3D fix');
    expect(result.current.accuracy).toBe(5);
    expect(result.current.hasFix).toBe(true);
    // Reset.
    act(() => {
      result.current.resetGnss();
    });
    expect(result.current.fixType).toBe('no fix');
    expect(result.current.accuracy).toBeNull();
    expect(result.current.hasFix).toBe(false);
  });

  it('does NOT reset satellitesUsed or satellitesInView', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.handleGnssEvent({
        fixType: '3D fix',
        accuracy: 5,
        satellitesUsed: 9,
        satellitesInView: 14,
        hasFix: true,
        lat: 55.0, lon: 37.0, alt: 150.0, speed: 3.0, timestamp: Date.now(),
      });
    });
    act(() => {
      result.current.resetGnss();
    });
    // Per the source comment in useGnssMonitor.ts, resetGnss only clears
    // fixType / hasFix / accuracy — NOT the satellite counts (those are
    // GNSS-side state, not "fix state").
    expect(result.current.satellitesUsed).toBe(9);
    expect(result.current.satellitesInView).toBe(14);
  });
});

describe('useGnssMonitor — startMonitor / stopMonitor', () => {
  it('startMonitor delegates to GpsRecorder.startGnssMonitor', async () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    await act(async () => {
      await result.current.startMonitor();
    });
    expect(NativeModules.GpsRecorder!.startGnssMonitor).toHaveBeenCalledTimes(1);
  });

  it('stopMonitor delegates to GpsRecorder.stopGnssMonitor', async () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    await act(async () => {
      await result.current.stopMonitor();
    });
    expect(NativeModules.GpsRecorder!.stopGnssMonitor).toHaveBeenCalledTimes(1);
  });

  it('startMonitor returns the boolean from the native call (true)', async () => {
    (gpsMock.startGnssMonitor as jest.Mock).mockResolvedValueOnce(true);
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    let ret: boolean | undefined;
    await act(async () => {
      ret = await result.current.startMonitor();
    });
    expect(ret).toBe(true);
  });

  it('startMonitor returns the boolean from the native call (false)', async () => {
    (gpsMock.startGnssMonitor as jest.Mock).mockResolvedValueOnce(false);
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    let ret: boolean | undefined;
    await act(async () => {
      ret = await result.current.startMonitor();
    });
    expect(ret).toBe(false);
  });
});

describe('useGnssMonitor — individual setters', () => {
  it('setFixType updates only fixType', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.setFixType('3D fix');
    });
    expect(result.current.fixType).toBe('3D fix');
    // Other fields unchanged.
    expect(result.current.accuracy).toBeNull();
    expect(result.current.hasFix).toBe(false);
  });

  it('setAccuracy updates only accuracy', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.setAccuracy(42);
    });
    expect(result.current.accuracy).toBe(42);
    expect(result.current.fixType).toBe('no fix');
  });

  it('setHasFix updates only hasFix', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.setHasFix(true);
    });
    expect(result.current.hasFix).toBe(true);
    expect(result.current.fixType).toBe('no fix');
  });

  it('setAccuracy accepts null (clearing)', () => {
    const { result } = renderHook(useGnssMonitor, recordingStateRef());
    act(() => {
      result.current.setAccuracy(42);
    });
    act(() => {
      result.current.setAccuracy(null);
    });
    expect(result.current.accuracy).toBeNull();
  });
});
