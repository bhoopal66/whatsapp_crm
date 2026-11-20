import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The test environment has no DOM, so React's hooks are stood in for
// (as in use-total-unread.test.ts): state is its initial value and an
// effect runs at once. Its cleanup is kept to run after.
const cleanups: (() => void)[] = [];
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [
    typeof init === 'function' ? (init as () => unknown)() : init,
    () => {},
  ],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
}));

let auth: {
  accountId: string | null;
  accountRole: string | null;
  profileLoading: boolean;
  salesRestricted: boolean;
};
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));

import { useCasesOverdue } from '@/hooks/use-cases-overdue';

const fetchMock = vi.fn(() =>
  Promise.resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 }))
);

beforeEach(() => {
  auth = {
    accountId: 'acc-1',
    accountRole: 'agent',
    profileLoading: false,
    salesRestricted: false,
  };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
});

describe('useCasesOverdue', () => {
  it('asks the cases route for an agent of a sales department', () => {
    useCasesOverdue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/api/cases?sla_state=overdue'
    );
  });

  it('never asks for a department kept out of the sales areas', () => {
    auth.salesRestricted = true;
    expect(useCasesOverdue()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never asks below agent', () => {
    auth.accountRole = 'viewer';
    expect(useCasesOverdue()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
