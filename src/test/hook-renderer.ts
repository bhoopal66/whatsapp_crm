/**
 * The test environment has no DOM, so a client component cannot be
 * mounted. This stands in for React's hooks with a one-component
 * renderer: state, refs and callbacks keep their slot between renders,
 * an effect runs when its dependencies changed, and a setter stores the
 * value for the next `render()`. The component's element tree is then
 * read (and its handlers called) with `findElements`.
 *
 *   vi.mock('react', async (importOriginal) => {
 *     const { mockReact } = await import('@/test/hook-renderer');
 *     return mockReact(await importOriginal<typeof import('react')>());
 *   });
 */
import type { ReactElement, ReactNode } from 'react';

type AnyElement = ReactElement<Record<string, unknown>>;

interface Slot {
  value: unknown;
  deps?: unknown[];
}

let slots: Slot[] = [];
let index = 0;

function slot(init: () => unknown): Slot {
  const i = index++;
  slots[i] ??= { value: init() };
  return slots[i];
}

function changed(prev: unknown[] | undefined, next?: unknown[]) {
  return !prev || !next || next.some((dep, i) => !Object.is(dep, prev[i]));
}

const hooks = {
  useState: (init: unknown) => {
    const s = slot(() => (typeof init === 'function' ? init() : init));
    return [
      s.value,
      (next: unknown) => {
        s.value = typeof next === 'function' ? next(s.value) : next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const s = slot(() => undefined);
    if (!changed(s.deps, deps)) return;
    s.deps = deps;
    if (typeof s.value === 'function') s.value();
    s.value = effect();
  },
  // No providers here: the context's default.
  useContext: (c: { _currentValue: unknown }) => c._currentValue,
  useCallback: (fn: unknown, deps?: unknown[]) => {
    const s = slot(() => fn);
    if (changed(s.deps, deps)) Object.assign(s, { value: fn, deps });
    return s.value;
  },
  useMemo: (fn: () => unknown) => fn(),
  useRef: (current: unknown) => slot(() => ({ current })).value,
  useId: () => slot(() => `id-${index}`).value,
};

export function mockReact<T extends object>(actual: T): T {
  return { ...actual, ...hooks };
}

/** Forget every slot: call before each test. */
export function resetHooks() {
  slots = [];
  index = 0;
}

/** Run the component (or hook) once with the state it has now. */
export function render<T>(component: () => T): T {
  index = 0;
  return component();
}

/** Let pending promises (a mocked fetch) settle. */
export const settle = () => new Promise((r) => setTimeout(r, 0));

/** Every element under `node` the test accepts, depth first. */
export function findElements(
  node: ReactNode,
  accept: (el: AnyElement) => boolean
): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap((n) => findElements(n, accept));
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const el = node as AnyElement;
  return [
    ...(accept(el) ? [el] : []),
    ...findElements(el.props.children as ReactNode, accept),
  ];
}
