import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('@/hooks/use-auth', () => {
  const auth = { accountId: 'acc-1', user: { id: 'u-1' } };
  return { useAuth: () => auth };
});
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
// One client, as the real createClient hands out.
vi.mock('@/lib/supabase/client', () => {
  const client = { rpc: h.rpc };
  return { createClient: () => client };
});

import { invalidateCached } from '@/lib/client-cache';
import { render, resetHooks, settle } from '@/test/hook-renderer';
import { MEMBER_LOADS_CACHE_PREFIX, useMemberLoads } from './use-member-loads';

const answer = (open: number) => ({
  data: [{ user_id: 'a', open_count: open, chat_limit: null }],
  error: null,
});
const failure = { data: null, error: { message: 'timeout' } };

/** Open the Assign menu, and answer the open chats it shows for `a`. */
async function openMenu() {
  render(() => useMemberLoads(false));
  render(() => useMemberLoads(true));
  await settle();
  return render(() => useMemberLoads(true)).get('a')?.openCount;
}

beforeEach(() => {
  resetHooks();
  invalidateCached(MEMBER_LOADS_CACHE_PREFIX);
  h.rpc.mockReset();
});

describe('useMemberLoads', () => {
  it('asks again at the next opening when a read failed', async () => {
    h.rpc.mockResolvedValueOnce(failure).mockResolvedValueOnce(answer(7));
    expect(await openMenu()).toBeUndefined();
    expect(await openMenu()).toBe(7);
    // A read that worked is kept for a while.
    expect(await openMenu()).toBe(7);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("shows no figures, not an earlier opening's, when a read fails", async () => {
    h.rpc.mockResolvedValueOnce(answer(7)).mockResolvedValueOnce(failure);
    expect(await openMenu()).toBe(7);
    invalidateCached(MEMBER_LOADS_CACHE_PREFIX);
    expect(await openMenu()).toBeUndefined();
  });
});
