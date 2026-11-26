import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

// A renderer of one hook, enough for useCaseResource (no jsdom here).
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  key: undefined as unknown,
  effects: [] as (() => void)[],
}));
const same = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.every((v, i) => Object.is(v, b[i]));

vi.mock('react', async (importOriginal) => {
  const slot = <T,>(make: () => T) => {
    const i = h.at++;
    if (!(i in h.slots)) h.slots[i] = make();
    return i;
  };
  return {
    ...(await importOriginal<typeof import('react')>()),
    useContext: () => h.key,
    useRef: (v: unknown) => h.slots[slot(() => ({ current: v }))],
    useState: (v: unknown) => {
      const i = slot(() => (typeof v === 'function' ? v() : v));
      return [h.slots[i], (n: unknown) => (h.slots[i] = n)];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = slot(() => ({ fn, deps }));
      const s = h.slots[i] as { fn: unknown; deps: unknown[] };
      if (!same(s.deps, deps)) h.slots[i] = { fn, deps };
      return (h.slots[i] as { fn: unknown }).fn;
    },
    useEffect: (fn: () => void, deps: unknown[]) => {
      const i = slot(() => ({ deps: undefined }));
      if (!same((h.slots[i] as { deps?: unknown[] }).deps, deps))
        h.effects.push(fn);
      h.slots[i] = { deps };
    },
  };
});

import { useCaseResource } from './tab-kit';

const parse = (j: unknown) => (j as { v: number }).v;
const begin = (key: unknown) => {
  h.at = 0;
  h.key = key;
};
function useRender(key: unknown) {
  begin(key);
  const out = useCaseResource('/x', parse);
  h.effects.splice(0).forEach((fn) => fn());
  return out;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  h.slots = [];
  vi.unstubAllGlobals();
});

describe('useCaseResource', () => {
  it('reads again when the case was reloaded, keeping what is shown', async () => {
    const answers: ((v: number | null) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise((resolve) =>
          answers.push((v) =>
            resolve(Response.json({ v }, { status: v === null ? 500 : 200 }))
          )
        )
    );
    const first = { case: 1 };
    useRender(first);
    useRender(first);
    expect(answers).toHaveLength(1);
    answers[0](1);
    await flush();

    const second = { case: 2 };
    expect(useRender(second).data).toBe(1);
    expect(answers).toHaveLength(2);
    expect(useRender(second).data).toBe(1);
    useRender({ case: 3 });
    expect(answers).toHaveLength(3);
    // The newer answer lands first; the older one is dropped.
    answers[2](3);
    await flush();
    answers[1](2);
    await flush();
    const last = { case: 4 };
    expect(useRender(last).data).toBe(3);
    // A failed refresh keeps it too.
    answers[3](null);
    await flush();
    expect(useRender(last)).toMatchObject({ data: 3, failed: true });
  });

  it('the case page hands every reload to the open tab', () => {
    const page = readFileSync(
      new URL('./case-page.tsx', import.meta.url),
      'utf8'
    );
    expect(page).toContain('<CaseRefreshContext.Provider value={detail}>');
  });
});
