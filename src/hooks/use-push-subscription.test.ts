import { afterEach, describe, expect, it, vi } from 'vitest';

// No DOM here: React's hooks are stood in for. An effect runs at once.
let sets: unknown[] = [];
vi.mock('react', () => ({
  useState: (init: unknown) => [init, (next: unknown) => sets.push(next)],
  useEffect: (effect: () => void) => effect(),
  useCallback: (fn: unknown) => fn,
}));
const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  accountId: null as string | null,
  profileLoading: true,
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/push/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/client')>()),
  readPushEnv: () => ({}),
  pushSupport: () => 'supported',
}));
const repairPush = vi.hoisted(() => vi.fn());
vi.mock('@/lib/push/repair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/repair')>()),
  repairPush,
}));

import { usePushSubscription } from './use-push-subscription';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('usePushSubscription', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('settles whose device this is, once per person, before the switch says on', async () => {
    let subscribed = true;
    vi.stubGlobal('window', { Notification: { permission: 'granted' } });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: async () => ({
          pushManager: {
            getSubscription: async () => (subscribed ? {} : null),
          },
        }),
      },
    });
    repairPush.mockImplementation(async () => {
      subscribed = false;
      return 'released';
    });

    usePushSubscription();
    await settle();
    expect(sets).toEqual([]); // the person is not known yet
    Object.assign(auth, {
      user: { id: 'u2' },
      accountId: 'a1',
      profileLoading: false,
    });
    usePushSubscription();
    usePushSubscription();
    await settle();
    expect(repairPush).toHaveBeenCalledTimes(1);
    expect(repairPush.mock.calls[0][0]).toBe('u2');
    expect(sets).toContain('off');
    expect(sets).not.toContain('on');
    Object.assign(auth, { user: { id: 'u3' } });
    usePushSubscription();
    await settle();
    expect(repairPush).toHaveBeenCalledTimes(2);
    sets = [];
  });
});
