/**
 * O12 — Tests for the pure formatting / math helpers extracted into
 * src/styles/index.ts. These functions are deterministic and have well-
 * defined edge cases, which makes them ideal unit-test fodder.
 *
 * Run with: npm test
 */

import {
  pad2,
  pluralRu,
  formatDuration,
  formatDistance,
  computeAvgPace,
  computeCurrentPace,
} from '../src/styles';

describe('pad2', () => {
  it('pads single-digit numbers with a leading zero', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(5)).toBe('05');
    expect(pad2(9)).toBe('09');
  });
  it('does not pad double-digit numbers', () => {
    expect(pad2(10)).toBe('10');
    expect(pad2(59)).toBe('59');
    expect(pad2(99)).toBe('99');
  });
});

describe('pluralRu', () => {
  const forms: [string, string, string] = ['точка', 'точки', 'точек'];
  it('uses the "one" form for 1, 21, 31, …', () => {
    expect(pluralRu(1, forms)).toBe('точка');
    expect(pluralRu(21, forms)).toBe('точка');
    expect(pluralRu(31, forms)).toBe('точка');
    expect(pluralRu(101, forms)).toBe('точка');
  });
  it('uses the "few" form for 2, 3, 4, 22, 23, 24, …', () => {
    expect(pluralRu(2, forms)).toBe('точки');
    expect(pluralRu(3, forms)).toBe('точки');
    expect(pluralRu(4, forms)).toBe('точки');
    expect(pluralRu(22, forms)).toBe('точки');
    expect(pluralRu(23, forms)).toBe('точки');
    expect(pluralRu(24, forms)).toBe('точки');
  });
  it('uses the "many" form for 0, 5-20, 25-30, …', () => {
    expect(pluralRu(0, forms)).toBe('точек');
    expect(pluralRu(5, forms)).toBe('точек');
    expect(pluralRu(11, forms)).toBe('точек');
    expect(pluralRu(12, forms)).toBe('точек');
    expect(pluralRu(13, forms)).toBe('точек');
    expect(pluralRu(14, forms)).toBe('точек');
    expect(pluralRu(20, forms)).toBe('точек');
    expect(pluralRu(25, forms)).toBe('точек');
    expect(pluralRu(100, forms)).toBe('точек');
  });
  it('handles the 11-14 exception (mod100 rule)', () => {
    // 11, 12, 13, 14 all use "many" even though their last digit is 1-4
    expect(pluralRu(11, forms)).toBe('точек');
    expect(pluralRu(12, forms)).toBe('точек');
    expect(pluralRu(13, forms)).toBe('точек');
    expect(pluralRu(14, forms)).toBe('точек');
    // 111-114 also use "many"
    expect(pluralRu(111, forms)).toBe('точек');
    expect(pluralRu(112, forms)).toBe('точек');
    expect(pluralRu(114, forms)).toBe('точек');
  });
  it('handles negative numbers (uses absolute value)', () => {
    expect(pluralRu(-1, forms)).toBe('точка');
    expect(pluralRu(-2, forms)).toBe('точки');
    expect(pluralRu(-5, forms)).toBe('точек');
  });
});

describe('formatDuration', () => {
  it('returns 00:00 for 0 ms', () => {
    expect(formatDuration(0)).toBe('00:00');
  });
  it('returns 00:00 for sub-second values', () => {
    expect(formatDuration(999)).toBe('00:00');
  });
  it('returns 00:01 for 1 second', () => {
    expect(formatDuration(1000)).toBe('00:01');
  });
  it('returns 00:59 for 59 seconds', () => {
    expect(formatDuration(59_000)).toBe('00:59');
  });
  it('returns 01:00 for 60 seconds', () => {
    expect(formatDuration(60_000)).toBe('01:00');
  });
  it('returns 59:59 for 3599 seconds', () => {
    expect(formatDuration(3_599_000)).toBe('59:59');
  });
  it('switches to h:mm:ss format at 1 hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
  });
  it('handles 1 hour + 1 second', () => {
    expect(formatDuration(3_601_000)).toBe('1:00:01');
  });
  it('handles 1 hour + 1 minute + 1 second', () => {
    expect(formatDuration(3_661_000)).toBe('1:01:01');
  });
  it('handles large values (10 hours)', () => {
    expect(formatDuration(36_000_000)).toBe('10:00:00');
  });
  it('clamps negative values to 00:00', () => {
    expect(formatDuration(-1000)).toBe('00:00');
  });
});

describe('formatDistance', () => {
  it('returns "0 m" for 0', () => {
    expect(formatDistance(0)).toEqual({ value: '0', unit: 'm' });
  });
  it('returns meters for small distances', () => {
    expect(formatDistance(100)).toEqual({ value: '100', unit: 'm' });
    expect(formatDistance(999)).toEqual({ value: '999', unit: 'm' });
  });
  it('still uses meters below the 1500 m boundary (U11 fix)', () => {
    expect(formatDistance(1000)).toEqual({ value: '1000', unit: 'm' });
    expect(formatDistance(1499)).toEqual({ value: '1499', unit: 'm' });
  });
  it('switches to 2-decimal km at 1500 m', () => {
    expect(formatDistance(1500)).toEqual({ value: '1.50', unit: 'km' });
    expect(formatDistance(5000)).toEqual({ value: '5.00', unit: 'km' });
    expect(formatDistance(9999)).toEqual({ value: '10.00', unit: 'km' });
  });
  it('switches to 1-decimal km at 10000 m', () => {
    expect(formatDistance(10000)).toEqual({ value: '10.0', unit: 'km' });
    expect(formatDistance(42195)).toEqual({ value: '42.2', unit: 'km' });
  });
  it('returns "0 m" for NaN (U11 guard)', () => {
    expect(formatDistance(NaN)).toEqual({ value: '0', unit: 'm' });
  });
  it('returns "0 m" for Infinity (U11 guard)', () => {
    expect(formatDistance(Infinity)).toEqual({ value: '0', unit: 'm' });
  });
  it('returns "0 m" for negative values (U11 guard)', () => {
    expect(formatDistance(-100)).toEqual({ value: '0', unit: 'm' });
  });
});

describe('computeAvgPace', () => {
  it('returns null when distance is zero', () => {
    expect(computeAvgPace(60_000, 0)).toBeNull();
  });
  it('returns null when distance is < 1 m', () => {
    expect(computeAvgPace(60_000, 0.5)).toBeNull();
  });
  it('returns null when elapsed time is < 1 second', () => {
    expect(computeAvgPace(999, 1000)).toBeNull();
  });
  it('returns null when both are zero', () => {
    expect(computeAvgPace(0, 0)).toBeNull();
  });
  it('computes 5:00/km for 1 km in 5 min', () => {
    expect(computeAvgPace(300_000, 1000)).toBe('5:00');
  });
  it('computes 6:40/km for 1 km in 6 min 40 sec', () => {
    expect(computeAvgPace(400_000, 1000)).toBe('6:40');
  });
  it('computes 5:00/km for 5 km in 25 min', () => {
    expect(computeAvgPace(1_500_000, 5000)).toBe('5:00');
  });
  it('rounds seconds correctly (1:00/km)', () => {
    expect(computeAvgPace(60_000, 1000)).toBe('1:00');
  });
});

describe('computeCurrentPace', () => {
  it('returns null when speed is null', () => {
    expect(computeCurrentPace(null)).toBeNull();
  });
  it('returns null when speed is undefined', () => {
    expect(computeCurrentPace(undefined)).toBeNull();
  });
  it('returns null when speed is at or below the 0.5 m/s standing-still threshold', () => {
    expect(computeCurrentPace(0)).toBeNull();
    expect(computeCurrentPace(0.4)).toBeNull();
    expect(computeCurrentPace(0.5)).toBeNull();
  });
  it('computes 5:00/km for 3.333 m/s (12 km/h)', () => {
    // 1000 m / 3.333 m/s = 300 sec/km -> 5:00
    expect(computeCurrentPace(3.333)).toBe('5:00');
  });
  it('computes 2:46/km for 6 m/s (21.6 km/h, a fast run)', () => {
    // 1000 / 6 = 166.67 sec -> 2 min 46.67 sec, rounds to 2:47
    expect(computeCurrentPace(6)).toBe('2:47');
  });
});
