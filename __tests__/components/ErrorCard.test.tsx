/**
 * Tests for ErrorCard — the error display card.
 *
 * Verifies:
 *   - Renders without crashing.
 *   - Renders the error message text.
 *   - Shows the "Открыть настройки" button only when hasPermissions is false.
 *   - The dismiss button calls onDismiss when pressed.
 *   - The "open settings" button calls onOpenSettings when pressed.
 */
import React from 'react';
import { Text } from 'react-native';
import { ErrorCard } from '../../src/components/ErrorCard';
import { render, press, allText, allPressables } from '../helpers/render';

describe('ErrorCard', () => {
  it('renders the error message text', () => {
    const root = render(
      <ErrorCard
        message="Something went wrong"
        hasPermissions={true}
        onDismiss={jest.fn()}
        onOpenSettings={jest.fn()}
      />
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Something went wrong'))).toBe(true);
  });

  it('renders the dismiss (✕) button', () => {
    const root = render(
      <ErrorCard
        message="err"
        hasPermissions={true}
        onDismiss={jest.fn()}
        onOpenSettings={jest.fn()}
      />
    );
    const texts = allText(root);
    expect(texts).toContain('✕');
  });

  it('does NOT render "Открыть настройки" button when hasPermissions=true', () => {
    const root = render(
      <ErrorCard
        message="err"
        hasPermissions={true}
        onDismiss={jest.fn()}
        onOpenSettings={jest.fn()}
      />
    );
    const texts = allText(root);
    expect(texts).not.toContain('Открыть настройки');
  });

  it('renders "Открыть настройки" button when hasPermissions=false', () => {
    const root = render(
      <ErrorCard
        message="err"
        hasPermissions={false}
        onDismiss={jest.fn()}
        onOpenSettings={jest.fn()}
      />
    );
    const texts = allText(root);
    expect(texts).toContain('Открыть настройки');
  });

  it('fires onDismiss when the ✕ button is pressed', () => {
    const onDismiss = jest.fn();
    const root = render(
      <ErrorCard
        message="err"
        hasPermissions={true}
        onDismiss={onDismiss}
        onOpenSettings={jest.fn()}
      />
    );
    // ✕ is the first Pressable.
    const dismissBtn = allPressables(root)[0];
    press(dismissBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenSettings when the "Открыть настройки" button is pressed', () => {
    const onOpenSettings = jest.fn();
    const root = render(
      <ErrorCard
        message="err"
        hasPermissions={false}
        onDismiss={jest.fn()}
        onOpenSettings={onOpenSettings}
      />
    );
    // Two Pressables: [0]=dismiss ✕, [1]=open settings.
    const openSettingsBtn = allPressables(root)[1];
    press(openSettingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
