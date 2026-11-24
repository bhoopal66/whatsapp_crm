import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM: React's hooks are stood in for, as in use-cases-overdue.test.
const setCount = vi.fn();
const cleanups: (() => void)[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: () => [0, setCount],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    accountId: 'a1',
    accountRole: 'agent',
    isBankGuest: false,
  }),
}));
const rpc = vi.fn();
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import { useGroupsUnread } from '@/hooks/use-groups-unread';
import { useSubmissionGroupsUnread } from '@/hooks/use-submission-groups-unread';

let visibilityState: string;

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = 'visible';
  setCount.mockClear();
  rpc.mockReset();
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  ['useGroupsUnread', useGroupsUnread],
  ['useSubmissionGroupsUnread', useSubmissionGroupsUnread],
])('%s', (_name, useCount) => {
  it('keeps the last good count when a poll fails', async () => {
    rpc.mockResolvedValueOnce({ data: 7, error: null });
    useCount();
    await vi.advanceTimersByTimeAsync(0);
    expect(setCount.mock.calls).toEqual([[7]]);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    await vi.advanceTimersByTimeAsync(60_000);
    rpc.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(setCount.mock.calls).toEqual([[7]]);
  });

  it('asks nothing while hidden', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    useCount();
    await vi.advanceTimersByTimeAsync(0);
    visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(600_000);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('every badge poll', () => {
  it.each([
    'use-groups-unread.ts',
    'use-submission-groups-unread.ts',
    'use-cases-overdue.ts',
    'use-hr-counts.ts',
    'use-phone-presence.ts',
    'use-chat-workspace.ts',
  ])('%s sleeps while hidden', (file) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(src).toContain('visibleInterval(');
    expect(src).not.toMatch(/\bsetInterval\(/);
  });
});
