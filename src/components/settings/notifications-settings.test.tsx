import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here: React's hooks are stood in for, as in
// src/hooks/live-read-wiring.test.tsx. An effect runs at once.
let sets: unknown[] = [];
const cleanups: (() => void)[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [init, (next: unknown) => sets.push(next)],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('@/hooks/use-push-subscription', () => ({
  usePushSubscription: () => ({ state: 'on', busy: false }),
}));

import { NotificationsSettings } from './notifications-settings';

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sets = [];
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  vi.unstubAllGlobals();
});

describe('loading notification settings', () => {
  const answer = (f: () => Promise<unknown>) => vi.stubGlobal('fetch', f);

  it.each([
    ['offline', () => Promise.reject(new Error('offline'))],
    ['a server error', async () => ({ ok: false, status: 500 })],
    [
      'an answer that is not settings',
      async () => ({ ok: true, json: async () => null }),
    ],
  ])('%s shows the error and never an editable form', async (_n, f) => {
    answer(f as () => Promise<unknown>);
    NotificationsSettings();
    await settle();
    expect(sets).toEqual([true]);
  });

  it('what the server holds is what can be edited', async () => {
    answer(async () => ({
      ok: true,
      json: async () => ({
        enabled: false,
        kinds: {},
        quietStart: '22:00',
        quietEnd: '07:00',
        timeZone: 'Asia/Dubai',
      }),
    }));
    NotificationsSettings();
    await settle();
    expect(sets).toMatchObject([{ enabled: false, quietStart: '22:00' }]);
  });
});
