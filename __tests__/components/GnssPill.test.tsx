/**
 * Tests for GnssPill — the pill-shaped GNSS status indicator at the top
 * of the screen.
 */
import React from 'react';
import { Text } from 'react-native';
import { GnssPill } from '../../src/components/GnssPill';
import type { GpsFixType } from '../../src/NativeGpsRecorder';
import { render } from '../helpers/render';

function findDetailText(root: ReturnType<typeof render>): string {
  const texts = root.findAllByType(Text).map((t) => t.props.children as string);
  return texts.find((t) => typeof t === 'string' && t.length > 0) ?? '';
}

describe('GnssPill', () => {
  it('renders without crashing for the no-fix state', () => {
    const root = render(
      <GnssPill
        fixType="no fix"
        accuracy={null}
        satellitesUsed={0}
        satellitesInView={0}
        hasFix={false}
      />
    );
    expect(root).toBeDefined();
  });

  it('renders "НЕТ СИГНАЛА" when hasFix is false and no satellites are in view', () => {
    const root = render(
      <GnssPill
        fixType="no fix"
        accuracy={null}
        satellitesUsed={0}
        satellitesInView={0}
        hasFix={false}
      />
    );
    expect(findDetailText(root)).toBe('НЕТ СИГНАЛА');
  });

  it('renders "НЕТ СИГНАЛА · {used}/{inView}" when satellites are in view but no fix', () => {
    const root = render(
      <GnssPill
        fixType="no fix"
        accuracy={null}
        satellitesUsed={3}
        satellitesInView={12}
        hasFix={false}
      />
    );
    expect(findDetailText(root)).toBe('НЕТ СИГНАЛА · 3/12');
  });

  it('renders "3D FIX · {acc} м · {sat} СПУТ" for a 3D fix with accuracy', () => {
    const root = render(
      <GnssPill
        fixType="3D fix"
        accuracy={4}
        satellitesUsed={9}
        satellitesInView={14}
        hasFix={true}
      />
    );
    expect(findDetailText(root)).toBe('3D FIX · 4 м · 9 СПУТ');
  });

  it('renders "2D FIX · {acc} м · {sat} СПУТ" for a 2D fix', () => {
    const root = render(
      <GnssPill
        fixType="2D fix"
        accuracy={15}
        satellitesUsed={5}
        satellitesInView={10}
        hasFix={true}
      />
    );
    expect(findDetailText(root)).toBe('2D FIX · 15 м · 5 СПУТ');
  });

  it('omits the accuracy segment when accuracy is null (but hasFix is true)', () => {
    const root = render(
      <GnssPill
        fixType="3D fix"
        accuracy={null}
        satellitesUsed={7}
        satellitesInView={12}
        hasFix={true}
      />
    );
    expect(findDetailText(root)).toBe('3D FIX · 7 СПУТ');
  });

  it('rounds accuracy to the nearest integer (e.g. 4.7 → "5 м")', () => {
    const root = render(
      <GnssPill
        fixType="3D fix"
        accuracy={4.7}
        satellitesUsed={9}
        satellitesInView={14}
        hasFix={true}
      />
    );
    expect(findDetailText(root)).toBe('3D FIX · 5 м · 9 СПУТ');
  });

  it('renders for all three fix types without throwing', () => {
    const fixTypes: GpsFixType[] = ['no fix', '2D fix', '3D fix'];
    for (const ft of fixTypes) {
      const root = render(
        <GnssPill
          fixType={ft}
          accuracy={10}
          satellitesUsed={5}
          satellitesInView={10}
          hasFix={ft !== 'no fix'}
        />
      );
      expect(root).toBeDefined();
    }
  });
});
