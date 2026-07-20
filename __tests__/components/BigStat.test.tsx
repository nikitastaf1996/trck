/**
 * Tests for BigStat — large label + numeral + optional unit block.
 */
import React from 'react';
import { Text } from 'react-native';
import { BigStat } from '../../src/components/BigStat';
import { render, allText } from '../helpers/render';

describe('BigStat', () => {
  it('renders label + value + unit when all are provided', () => {
    const root = render(<BigStat label="ДИСТАНЦИЯ" value="5.00" unit="км" />);
    const texts = allText(root);
    expect(texts).toContain('ДИСТАНЦИЯ');
    expect(texts).toContain('5.00');
    expect(texts).toContain('км');
  });

  it('renders label + value when unit is omitted', () => {
    const root = render(<BigStat label="ВРЕМЯ" value="01:23" />);
    const texts = allText(root);
    expect(texts).toContain('ВРЕМЯ');
    expect(texts).toContain('01:23');
    // No unit should be rendered — only 2 Text nodes (label + value).
    expect(root.findAllByType(Text).length).toBe(2);
  });

  it('compact prop does not change the rendered text', () => {
    const root = render(<BigStat label="ТЕМП" value="5:00" unit="/км" compact />);
    const texts = allText(root);
    expect(texts).toContain('ТЕМП');
    expect(texts).toContain('5:00');
    expect(texts).toContain('/км');
  });

  it('renders with numeric value (gets coerced to string by React)', () => {
    const root = render(<BigStat label="N" value={42 as unknown as string} />);
    const texts = allText(root);
    expect(texts.some((t) => t.includes('42'))).toBe(true);
  });
});
