/**
 * Tests for Banners — SignalLostBanner, BatteryOptBanner, OverFilterWarning,
 * PauseBadge.
 *
 * Verifies:
 *   - Each banner renders without crashing.
 *   - Each renders its expected text content.
 *   - BatteryOptBanner fires onPress when tapped.
 */
import React from 'react';
import {
  SignalLostBanner,
  BatteryOptBanner,
  OverFilterWarning,
  PauseBadge,
} from '../../src/components/Banners';
import { render, press, allText, firstPressable } from '../helpers/render';

describe('SignalLostBanner', () => {
  it('renders without crashing', () => {
    const root = render(<SignalLostBanner />);
    expect(root).toBeDefined();
  });

  it('renders the "ПОТЕРЯ СИГНАЛА GPS" title', () => {
    const root = render(<SignalLostBanner />);
    const texts = allText(root);
    expect(texts).toContain('ПОТЕРЯ СИГНАЛА GPS');
  });

  it('renders the explanatory body text mentioning the 15-second threshold', () => {
    const root = render(<SignalLostBanner />);
    const texts = allText(root);
    expect(texts.some((t) => t.includes('15 с'))).toBe(true);
    expect(texts.some((t) => t.includes('сегмент'))).toBe(true);
  });
});

describe('BatteryOptBanner', () => {
  it('renders without crashing', () => {
    const root = render(<BatteryOptBanner onPress={jest.fn()} />);
    expect(root).toBeDefined();
  });

  it('renders the Doze-mode warning text', () => {
    const root = render(<BatteryOptBanner onPress={jest.fn()} />);
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Doze'))).toBe(true);
  });

  it('fires onPress when the banner is tapped', () => {
    const onPress = jest.fn();
    const root = render(<BatteryOptBanner onPress={onPress} />);
    press(firstPressable(root));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('OverFilterWarning', () => {
  it('renders without crashing', () => {
    const root = render(<OverFilterWarning />);
    expect(root).toBeDefined();
  });

  it('renders the warning title and body', () => {
    const root = render(<OverFilterWarning />);
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Предупреждение'))).toBe(true);
    expect(texts.some((t) => t.includes('три фильтра'))).toBe(true);
    expect(texts.some((t) => t.includes('Дуглас'))).toBe(true);
  });
});

describe('PauseBadge', () => {
  it('renders without crashing', () => {
    const root = render(<PauseBadge />);
    expect(root).toBeDefined();
  });

  it('renders the "АВТОПАУЗА" label', () => {
    const root = render(<PauseBadge />);
    const texts = allText(root);
    expect(texts.some((t) => t.includes('АВТОПАУЗА'))).toBe(true);
  });

  it('renders the "запись приостановлена" subtitle', () => {
    const root = render(<PauseBadge />);
    const texts = allText(root);
    expect(texts.some((t) => t.includes('приостановлена'))).toBe(true);
  });
});
