import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reviewerContactNames, seesAllCalls } from './call-reviewers';

const ctx = (role: string, rpc: (fn: string) => unknown) => ({
  role: role as 'agent',
  supabase: { rpc: vi.fn(rpc) } as unknown as SupabaseClient,
});

describe('seesAllCalls', () => {
  it('an owner or admin without a round trip', async () => {
    const c = ctx('admin', () => ({ data: false, error: null }));
    expect(await seesAllCalls(c)).toBe(true);
    expect(c.supabase.rpc).not.toHaveBeenCalled();
  });

  it('anyone else as pbx_sees_all_calls answers', async () => {
    const yes = ctx('agent', async () => ({ data: true, error: null }));
    expect(await seesAllCalls(yes)).toBe(true);
    expect(yes.supabase.rpc).toHaveBeenCalledWith('pbx_sees_all_calls');
    const no = ctx('team_leader', async () => ({ data: false, error: null }));
    expect(await seesAllCalls(no)).toBe(false);
  });

  it('falls back to the role on an RPC error, and never throws', async () => {
    const missing = ctx('agent', async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'no function' },
    }));
    expect(await seesAllCalls(missing)).toBe(false);
    const thrown = ctx('viewer', async () => {
      throw new Error('network');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await seesAllCalls(thrown)).toBe(false);
    spy.mockRestore();
  });
});

describe('reviewerContactNames', () => {
  it('reads exactly those contacts in the workspace, the name only', async () => {
    const steps: [string, unknown[]][] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq'])
      chain[m] = (...a: unknown[]) => {
        steps.push([m, a]);
        return chain;
      };
    chain.in = async (...a: unknown[]) => {
      steps.push(['in', a]);
      return { data: [{ id: 'c1', name: 'Ahmed' }], error: null };
    };
    const names = await reviewerContactNames(
      'acct',
      ['c1'],
      chain as unknown as SupabaseClient
    );
    expect(names).toEqual(new Map([['c1', 'Ahmed']]));
    expect(steps).toEqual([
      ['from', ['contacts']],
      ['select', ['id, name']],
      ['eq', ['account_id', 'acct']],
      ['in', ['id', ['c1']]],
    ]);
  });

  it('reads nothing for no ids', async () => {
    expect(await reviewerContactNames('acct', [])).toEqual(new Map());
  });
});
