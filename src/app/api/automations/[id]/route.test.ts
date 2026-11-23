import { beforeEach, describe, expect, it, vi } from 'vitest';

// Saving an automation: steps keep their ids (a parked run finds its
// wait again) and a save over someone else's is refused.

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  deletes: [] as string[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireRole: async () => ({ accountId: 'acct-1', userId: 'u1' }),
  assertSalesAccess: (ctx: unknown) => ctx,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }),
    },
  }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: h.rpc,
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        update: () => b,
        insert: () => b,
        delete: () => (h.deletes.push(table), b),
        maybeSingle: async () => ({
          data: {
            id: 'a1',
            is_active: false,
            trigger_type: 'x',
            trigger_config: {},
          },
          error: null,
        }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(ok),
      };
      return b;
    },
  }),
}));

import { PATCH } from './route';
import {
  fromServerSteps,
  toApiSteps,
} from '@/components/automations/automation-builder';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const save = (body: unknown) =>
  PATCH(
    new Request('http://x/', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'a1' }) }
  );
type Saved = { id: string; parent_step_id: string | null }[];
const steps = () => h.rpc.mock.calls[0][1].p_steps as Saved;

beforeEach(() => {
  vi.clearAllMocks();
  h.deletes = [];
  h.rpc.mockResolvedValue({
    data: { status: 'saved', updated_at: 'T2' },
    error: null,
  });
});

describe('PATCH /api/automations/[id]', () => {
  it('keeps the id of each step and deletes nothing itself', async () => {
    const res = await save({
      name: 'n',
      updated_at: 'T1',
      steps: [
        {
          id: A,
          step_type: 'condition',
          step_config: {},
          branches: { yes: [{ id: B, step_type: 'wait', step_config: {} }] },
        },
        { step_type: 'send_message', step_config: {} },
        { id: A, step_type: 'send_message', step_config: {} },
        { id: 'not-a-uuid', step_type: 'send_message', step_config: {} },
      ],
    });
    expect(await res.json()).toEqual({ ok: true, updated_at: 'T2' });
    expect(h.rpc).toHaveBeenCalledWith(
      'automation_save',
      expect.objectContaining({
        p_account_id: 'acct-1',
        p_automation_id: 'a1',
        p_expected_updated_at: 'T1',
        p_patch: { name: 'n' },
      })
    );
    expect(steps().slice(0, 2)).toMatchObject([
      { id: A, parent_step_id: null },
      { id: B, parent_step_id: A },
    ]);
    // A missing, repeated or malformed id gets a fresh one.
    expect(new Set(steps().map((s) => s.id)).size).toBe(5);
    expect(steps()[4].id).not.toBe('not-a-uuid');
    expect(h.deletes).toEqual([]);
  });

  it('answers 409 when the automation changed since it was loaded', async () => {
    h.rpc.mockResolvedValue({ data: { status: 'conflict' }, error: null });
    const res = await save({ name: 'n', updated_at: 'T1', steps: [] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Someone else changed');
  });

  it('the on/off switch leaves the steps alone', async () => {
    await save({ is_active: false });
    expect(h.rpc.mock.calls[0][1]).toMatchObject({
      p_expected_updated_at: null,
      p_patch: { is_active: false },
      p_steps: null,
    });
  });
});

describe('the builder', () => {
  it('sends back the ids it loaded', () => {
    const tree = [
      {
        id: A,
        step_type: 'condition',
        step_config: {},
        branches: {
          yes: [
            {
              id: B,
              step_type: 'wait',
              step_config: {},
              branches: { yes: [], no: [] },
            },
          ],
          no: [],
        },
      },
    ];
    expect(toApiSteps(fromServerSteps(tree))).toMatchObject([
      { id: A, branches: { yes: [{ id: B }] } },
    ]);
  });
});
