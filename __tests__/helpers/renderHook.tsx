/**
 * Minimal `renderHook` implementation for the trck Jest suite.
 *
 * We don't depend on @testing-library/react-hooks (an extra dep) because
 * the hooks in src/hooks/ are simple enough to drive with a plain
 * TestRenderer wrapper component. This helper:
 *
 *   1. Renders a wrapper component that calls the hook and stores the
 *      result on a ref-like object.
 *   2. Returns `{ result, rerender, unmount }`.
 *
 *   - `result.current` is the latest return value of the hook.
 *   - `rerender(newProps)` re-renders the wrapper with new props (so we
 *     can test that the hook reacts to prop changes).
 *   - `unmount()` unmounts the wrapper — used to test cleanup effects.
 *
 * Limitations vs. @testing-library/react-hooks:
 *   - No automatic `act()` wrapping of state updates triggered inside
 *     the hook. Tests that fire async effects must wrap their asserts
 *     in `act()` themselves (see useSettings.test.ts for examples).
 *   - No automatic error boundaries. A hook that throws will surface as
 *     a real React error, which is fine for our tests.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Re-export `act` so test files can import a single helper module.
export { act };

export type RenderHookResult<T> = {
  result: { current: T };
  rerender: (props: unknown) => void;
  unmount: () => void;
};

export function renderHook<T, P>(
  hook: (props: P) => T,
  initialProps: P,
): RenderHookResult<T> {
  const result: { current: T } = { current: undefined as unknown as T };

  function Wrapper(props: { hookProps: P }): null {
    result.current = hook(props.hookProps);
    return null;
  }

  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Wrapper hookProps={initialProps} />);
  });
  if (!renderer) throw new Error('renderHook — TestRenderer.create failed');

  return {
    result,
    rerender: (props: unknown) => {
      act(() => {
        renderer!.update(<Wrapper hookProps={props as P} />);
      });
    },
    unmount: () => {
      act(() => {
        renderer!.unmount();
      });
    },
  };
}
