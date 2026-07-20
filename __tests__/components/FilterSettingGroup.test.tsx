/**
 * Tests for FilterSettingGroup — a ToggleRow + StepperRow combined.
 */
import React from 'react';
import { FilterSettingGroup } from '../../src/components/FilterSettingGroup';
import { ToggleRow } from '../../src/components/ToggleRow';
import { StepperRow } from '../../src/components/StepperRow';
import { render, press, allText, allPressables } from '../helpers/render';

function findToggle(root: ReturnType<typeof render>) {
  return root.findByType(ToggleRow);
}
function findStepper(root: ReturnType<typeof render>) {
  return root.findByType(StepperRow);
}

describe('FilterSettingGroup', () => {
  const baseProps = {
    title: 'Radial Filter',
    subtitleOn: 'ON',
    subtitleOff: 'OFF',
    value: false,
    onToggle: jest.fn(),
    stepperLabel: 'Threshold',
    stepperValue: 5,
    stepperUnit: 'm',
    stepperMin: 0,
    stepperMax: 1000,
    onDecrement: jest.fn(),
    onIncrement: jest.fn(),
    settingsLocked: false,
  };

  beforeEach(() => {
    baseProps.onToggle = jest.fn();
    baseProps.onDecrement = jest.fn();
    baseProps.onIncrement = jest.fn();
  });

  it('renders without crashing', () => {
    const root = render(<FilterSettingGroup {...baseProps} />);
    expect(findToggle(root)).toBeDefined();
    expect(findStepper(root)).toBeDefined();
  });

  it('passes subtitleOff to the ToggleRow when value is false', () => {
    const root = render(<FilterSettingGroup {...baseProps} value={false} />);
    const texts = allText(root);
    expect(texts).toContain('OFF');
    expect(texts).not.toContain('ON');
  });

  it('passes subtitleOn to the ToggleRow when value is true', () => {
    const root = render(<FilterSettingGroup {...baseProps} value={true} />);
    const texts = allText(root);
    expect(texts).toContain('ON');
    expect(texts).not.toContain('OFF');
  });

  it('forwards settingsLocked=true to both toggle (disabled) and stepper (disabled)', () => {
    const root = render(<FilterSettingGroup {...baseProps} settingsLocked={true} />);
    expect(findToggle(root).props.disabled).toBe(true);
    expect(findStepper(root).props.disabled).toBe(true);
  });

  it('when settingsLocked=false, toggle (disabled) and stepper (disabled) are both false', () => {
    const root = render(<FilterSettingGroup {...baseProps} settingsLocked={false} />);
    expect(findToggle(root).props.disabled).toBe(false);
    expect(findStepper(root).props.disabled).toBe(false);
  });

  it('the inner ToggleRow fires onToggle when pressed', () => {
    const root = render(<FilterSettingGroup {...baseProps} />);
    // The first Pressable is the ToggleRow's row.
    const togglePressable = allPressables(root)[0];
    press(togglePressable);
    expect(baseProps.onToggle).toHaveBeenCalledTimes(1);
  });

  it('the inner StepperRow fires onDecrement / onIncrement when its buttons are pressed', () => {
    const root = render(<FilterSettingGroup {...baseProps} />);
    const pressables = allPressables(root);
    // [0] = ToggleRow, [1] = decrement, [2] = increment.
    press(pressables[1]);
    press(pressables[2]);
    expect(baseProps.onDecrement).toHaveBeenCalledTimes(1);
    expect(baseProps.onIncrement).toHaveBeenCalledTimes(1);
  });

  it('forwards stepperValue, stepperMin, stepperMax verbatim to StepperRow', () => {
    const root = render(
      <FilterSettingGroup
        {...baseProps}
        stepperValue={42}
        stepperMin={1}
        stepperMax={99}
      />
    );
    const stepper = findStepper(root);
    expect(stepper.props.value).toBe(42);
    expect(stepper.props.min).toBe(1);
    expect(stepper.props.max).toBe(99);
  });
});
