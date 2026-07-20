/**
 * Tests for Divider — full-width hairline divider.
 */
import React from 'react';
import { View } from 'react-native';
import { Divider } from '../../src/components/Divider';
import { COLOR } from '../../src/styles';
import { render } from '../helpers/render';

describe('Divider', () => {
  it('renders without crashing', () => {
    const root = render(<Divider />);
    expect(root).toBeDefined();
  });

  it('renders exactly one View (no children)', () => {
    const root = render(<Divider />);
    expect(root.findAllByType(View).length).toBe(1);
  });

  it('uses the divider color from the COLOR palette', () => {
    const root = render(<Divider />);
    const view = root.findByType(View);
    expect(view.props.style).toMatchObject({
      backgroundColor: COLOR.divider,
    });
  });
});
