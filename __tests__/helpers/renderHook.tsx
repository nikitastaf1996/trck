/**
 * Minimal renderHook helper for testing React hooks in isolation.
 *
 * Replaces the previous __tests__/helpers/renderHook.tsx (deleted in
 * v1.4.0 when the hooks directory was removed). Brought back to test
 * the useSettingsLocked convenience hook.
 */

import React from 'react';
import TestRenderer from 'react-test-renderer';

type RenderHookResult<R> = {
  result: { current: R };
  rerender: () => void;
  unmount: () => void;
};

export function renderHook<R>(hookFn: () => R): RenderHookResult<R> {
  const result: { current: R } = { current: undefined as unknown as R };

  const Harness = () => {
    result.current = hookFn();
    return null;
  };

  let renderer: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });

  return {
    result,
    rerender: () => {
      TestRenderer.act(() => {
        renderer.update(React.createElement(Harness));
      });
    },
    unmount: () => {
      TestRenderer.act(() => {
        renderer.unmount();
      });
    },
  };
}
