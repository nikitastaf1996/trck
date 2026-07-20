/**
 * Tests for StepperRow.
 */
import React from 'react';
import { StepperRow } from '../../src/components/StepperRow';
import { render, press, allText, allPressables } from '../helpers/render';

describe('StepperRow', () => {
  it('renders the label, value, and unit text', () => {
    const root = render(
      <StepperRow
        label="Мин. расстояние"
        value={5}
        unit="м"
        min={0}
        max={1000}
        disabled={false}
        onDecrement={jest.fn()}
        onIncrement={jest.fn()}
      />
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Мин. расстояние'))).toBe(true);
    expect(texts.some((t) => t.includes('5'))).toBe(true);
    expect(texts.some((t) => t.includes('м'))).toBe(true);
  });

  it('enables both buttons when value is strictly inside the [min, max] range', () => {
    const root = render(
      <StepperRow
        label="x" value={5} unit="m" min={0} max={10}
        disabled={false} onDecrement={jest.fn()} onIncrement={jest.fn()}
      />
    );
    const [dec, inc] = allPressables(root);
    expect(dec.props.disabled).toBe(false);
    expect(inc.props.disabled).toBe(false);
  });

  it('disables the decrement button when value === min', () => {
    const root = render(
      <StepperRow
        label="x" value={0} unit="m" min={0} max={10}
        disabled={false} onDecrement={jest.fn()} onIncrement={jest.fn()}
      />
    );
    const [dec, inc] = allPressables(root);
    expect(dec.props.disabled).toBe(true);
    expect(inc.props.disabled).toBe(false);
  });

  it('disables the increment button when value === max', () => {
    const root = render(
      <StepperRow
        label="x" value={10} unit="m" min={0} max={10}
        disabled={false} onDecrement={jest.fn()} onIncrement={jest.fn()}
      />
    );
    const [dec, inc] = allPressables(root);
    expect(dec.props.disabled).toBe(false);
    expect(inc.props.disabled).toBe(true);
  });

  it('disables both buttons when the disabled prop is true (recording in progress)', () => {
    const root = render(
      <StepperRow
        label="x" value={5} unit="m" min={0} max={10}
        disabled={true} onDecrement={jest.fn()} onIncrement={jest.fn()}
      />
    );
    const [dec, inc] = allPressables(root);
    expect(dec.props.disabled).toBe(true);
    expect(inc.props.disabled).toBe(true);
  });

  it('calls onDecrement when the decrement button is pressed', () => {
    const onDecrement = jest.fn();
    const root = render(
      <StepperRow
        label="x" value={5} unit="m" min={0} max={10}
        disabled={false} onDecrement={onDecrement} onIncrement={jest.fn()}
      />
    );
    const [dec] = allPressables(root);
    press(dec);
    expect(onDecrement).toHaveBeenCalledTimes(1);
  });

  it('calls onIncrement when the increment button is pressed', () => {
    const onIncrement = jest.fn();
    const root = render(
      <StepperRow
        label="x" value={5} unit="m" min={0} max={10}
        disabled={false} onDecrement={jest.fn()} onIncrement={onIncrement}
      />
    );
    const [, inc] = allPressables(root);
    press(inc);
    expect(onIncrement).toHaveBeenCalledTimes(1);
  });
});
