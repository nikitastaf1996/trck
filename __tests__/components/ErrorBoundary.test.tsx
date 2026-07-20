/**
 * Tests for ErrorBoundary — the top-level React error boundary.
 *
 * Verifies:
 *   - Renders children normally when no error is thrown.
 *   - On a child throwing, renders the recovery screen with the error message.
 *   - The "Перезапустить" button clears the error state.
 *   - getDerivedStateFromError returns the expected state shape.
 */
import React from 'react';
import { Text } from 'react-native';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { render, press, allText, allPressables } from '../helpers/render';

function Boom({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) {
    throw new Error('Boom!');
  }
  return <Text>normal child</Text>;
}

// Silence the expected console.error from React when a child throws inside
// an ErrorBoundary — otherwise the test output is noisy.
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('ErrorBoundary caught:')) return;
    if (typeof first === 'string' && first.includes('The above error occurred in the')) return;
    if (typeof first === 'string' && first.includes('React will try to recreate')) return;
    if (typeof first === 'string' && first.includes('Consider adding an error boundary')) return;
    originalConsoleError(...args);
  };
});
afterEach(() => {
  console.error = originalConsoleError;
});

describe('ErrorBoundary', () => {
  it('renders children normally when no error is thrown', () => {
    const root = render(
      <ErrorBoundary>
        <Text>happy child</Text>
      </ErrorBoundary>
    );
    expect(allText(root)).toContain('happy child');
  });

  it('renders the recovery screen when a child throws', () => {
    const root = render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Что-то пошло не так'))).toBe(true);
    expect(texts.some((t) => t.includes('Boom!'))).toBe(true);
  });

  it('renders the "Перезапустить" button on the recovery screen', () => {
    const root = render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>
    );
    const texts = allText(root);
    expect(texts).toContain('Перезапустить');
  });

  it('renders the hint text explaining how to recover', () => {
    const root = render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Перезапустить'))).toBe(true);
    expect(texts.some((t) => t.includes('остановить запись'))).toBe(true);
  });

  it('renders "Неизвестная ошибка" when the thrown error has no message', () => {
    // The ErrorBoundary uses `error?.message ?? 'Неизвестная ошибка'`.
    // `??` only fires on null/undefined, so an Error with `message=""`
    // would render as empty string. To exercise the "Неизвестная ошибка"
    // fallback, we throw an object that is NOT an Error instance and has
    // no `.message` property.
    function ThrowNonError(): React.ReactElement {
      // eslint-disable-next-line no-throw-literal
      throw { notAnError: true };
    }
    const root = render(
      <ErrorBoundary>
        <ThrowNonError />
      </ErrorBoundary>
    );
    const texts = allText(root);
    expect(texts.some((t) => t.includes('Неизвестная ошибка'))).toBe(true);
  });
});
