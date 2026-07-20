/**
 * Shared test helpers for rendering React components.
 *
 * React 19's `act` requires wrapping `TestRenderer.create()` so that any
 * initial state updates are flushed synchronously. After `act` returns,
 * the renderer instance is still mounted, but accessing `.root` *inside*
 * the act callback throws "Can't access .root on unmounted test renderer".
 *
 * So the correct pattern is:
 *
 *   let r: TestRenderer.ReactTest;
 *   TestRenderer.act(() => {
 *     r = TestRenderer.create(<Component />);
 *   });
 *   const root = r.root;
 *
 * This file wraps that pattern in `render(node)` so tests don't have to
 * repeat the boilerplate.
 *
 * NOTE on Pressable: `react-native`'s `Pressable` is a `forwardRef` /
 * `memo`-wrapped component, so `root.findByType(Pressable)` does NOT
 * match the rendered instance (the type comparison fails because the
 * wrapper's identity differs from the inner component's). We use a
 * predicate approach (`node.type?.displayName === 'Pressable'`) in
 * `firstPressable()` / `allPressables()` to work around this.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Pressable, Text } from 'react-native';

type Root = TestRenderer.ReactTestInstance;

/**
 * Render a React element and return its root ReactTestInstance.
 *
 * The TestRenderer instance is kept alive on the returned object's
 * `_renderer` property in case a test needs to call `unmount()` or
 * `update()` explicitly.
 */
export function render(node: React.ReactElement): Root {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(node);
  });
  if (!renderer) throw new Error('render() — TestRenderer.create did not return');
  return renderer.root;
}

/**
 * Trigger `onPress` on a Pressable / Touchable instance and flush the
 * resulting state updates. Tests that pass a Jest mock as the handler
 * don't strictly need this, but it's safer to use `act` so React's
 * batching behaves the same as in production.
 */
export function press(instance: Root | { props: { onPress?: () => void } }): void {
  const onPress = (instance as { props: { onPress?: () => void } }).props.onPress;
  if (typeof onPress !== 'function') {
    throw new Error('press() called on an instance without an onPress prop');
  }
  act(() => {
    onPress();
  });
}

/**
 * Predicate that matches `Pressable` instances in the rendered tree.
 *
 * React Native's `Pressable` is `React.forwardRef(React.memo(...))`, so a
 * direct identity comparison (`node.type === Pressable`) does NOT match
 * the rendered instance. We fall back to the displayName, which
 * `react-native`'s Jest preset preserves as `'Pressable'`.
 */
function isPressable(node: TestRenderer.ReactTestInstance): boolean {
  const t = node.type as { displayName?: string; name?: string } | string;
  if (typeof t === 'string') return t === 'Pressable';
  return t?.displayName === 'Pressable' || t?.name === 'Pressable';
}

/**
 * Find the FIRST Pressable inside the root.
 */
export function firstPressable(root: Root): Root {
  const all = root.findAll(isPressable);
  if (all.length === 0) {
    throw new Error('firstPressable() — no Pressable found in the tree');
  }
  return all[0];
}

/**
 * Find ALL Pressables inside the root, in document order.
 */
export function allPressables(root: Root): Root[] {
  return root.findAll(isPressable);
}

/**
 * Flatten all Text node children into an array of plain strings.
 *
 * Text nodes can have nested children (some are strings, some are other
 * Text components). We recursively flatten them into a single string per
 * outermost Text node. Numbers are coerced to strings (React does the
 * same when rendering `<Text>{42}</Text>`).
 */
export function allText(root: Root): string[] {
  const childToString = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (typeof c === 'number') return String(c);
    if (c === null || c === undefined) return '';
    if (Array.isArray(c)) {
      return c.map(childToString).join('');
    }
    if (typeof c === 'object' && 'props' in c) {
      // A nested Text component — recurse into its children.
      return childToString((c as { props: { children?: unknown } }).props.children);
    }
    return '';
  };
  return root.findAllByType(Text).map((t) => childToString(t.props.children));
}
