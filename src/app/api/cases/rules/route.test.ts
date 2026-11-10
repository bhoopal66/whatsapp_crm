import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  role: 'admin' as string,
  rules: {
    list: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    runs: vi.fn(),
  },
  caseStore: {} as Record<string, ReturnType<typeof vi.fn>>,
  getCurrentAccount: vi.fn(),
  admin: vi.fn(() => ({})),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...orig,
    getCurrentAccount: m.getCurrentAccount,
    requireRole: async (min: string) => {
      if (min === 'admin' && !['owner', 'admin'].includes(m.role))
        throw new orig.ForbiddenError();
      return { userId: 'u-me', accountId: 'acct-1', role: m.role };
    },
  };
});
vi.mock('@/lib/cases/rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cases/rules')>()),
  CaseRulesStore: class {
    list = m.rules.list;
    save = m.rules.save;
    delete = m.rules.delete;
    runs = m.rules.runs;
  },
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: m.admin,
}));
vi.mock('@/lib/cases/server', () => ({ caseStore: () => m.caseStore }));

import { CASE_RULE_REFUSALS, CaseRulesRefusedError } from '@/lib/cases/rules';
import { CASE_RULES_REFUSAL_HTTP } from '@/lib/cases/rules-http';
import { CaseStoreError } from '@/lib/cases/store';
import { GET as GET_RUNS } from '../[id]/rule-runs/route';
import { DELETE } from './[id]/route';
import { GET, POST } from './route';

const RID = '22222222-2222-4222-8222-222222222222';
const CID = '11111111-1111-4111-8111-111111111111';
const valid = {
  name: 'Chase',
  enabled: true,
  trigger: 'no_activity',
  conditions: {},
  actions: [],
};
const post = (body: unknown) =>
  POST(
    new Request('http://x/api/cases/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
const del = (id = RID) =>
  DELETE(new Request('http://x', { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });
const runs = (id = CID) =>
  GET_RUNS(new Request('http://x'), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.role = 'admin';
  m.rules.list.mockResolvedValue([]);
  m.rules.save.mockResolvedValue({ ruleId: RID });
  m.rules.delete.mockResolvedValue(undefined);
  m.rules.runs.mockResolvedValue([]);
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
  m.caseStore = {
    get: vi.fn(async () => ({ id: CID, accountId: 'acct-1' })),
    role: vi.fn(async () => 'agent'),
  };
});

describe('GET /api/cases/rules', () => {
  it('lists for a member', async () => {
    m.role = 'agent';
    m.rules.list.mockResolvedValue([{ ruleId: RID }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [{ ruleId: RID }] });
    expect(m.rules.list).toHaveBeenCalledWith('u-me');
  });
});

describe('POST /api/cases/rules', () => {
  it('is 403 for an agent, with no store call', async () => {
    m.role = 'agent';
    expect((await post(valid)).status).toBe(403);
    expect(m.rules.save).not.toHaveBeenCalled();
  });

  it('saves and answers { rule }', async () => {
    const res = await post({ ...valid, ruleId: RID, position: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: { ruleId: RID } });
    expect(m.rules.save).toHaveBeenCalledWith('u-me', {
      ...valid,
      ruleId: RID,
      position: 3,
    });
  });

  it('passes a missing ruleId and position as null', async () => {
    await post(valid);
    expect(m.rules.save).toHaveBeenCalledWith('u-me', {
      ...valid,
      ruleId: null,
      position: null,
    });
  });

  it.each([1.5, -1, 2147483648, '3'])(
    'is 422 for position %s, with no store call',
    async (position) => {
      const res = await post({ ...valid, position });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('RULE_INVALID');
      expect(m.rules.save).not.toHaveBeenCalled();
    }
  );

  it('accepts the position bounds', async () => {
    expect((await post({ ...valid, position: 0 })).status).toBe(200);
    expect((await post({ ...valid, position: 2147483647 })).status).toBe(200);
  });

  it.each([
    ['name', 5],
    ['enabled', 'yes'],
    ['trigger', null],
    ['conditions', []],
    ['conditions', 'x'],
    ['actions', {}],
  ])('is 422 for a bad %s', async (key, value) => {
    expect((await post({ ...valid, [key]: value })).status).toBe(422);
    expect(m.rules.save).not.toHaveBeenCalled();
  });

  it('is 404 RULE_NOT_FOUND for a non-uuid ruleId, no store call', async () => {
    const res = await post({ ...valid, ruleId: 'nope' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('RULE_NOT_FOUND');
    expect(m.rules.save).not.toHaveBeenCalled();
  });

  it('is 400 for a non-object body', async () => {
    expect((await post([])).status).toBe(400);
  });

  it.each(CASE_RULE_REFUSALS)('maps a store refusal %s', async (reason) => {
    m.rules.save.mockRejectedValue(new CaseRulesRefusedError(reason));
    const res = await post(valid);
    const want = CASE_RULES_REFUSAL_HTTP[reason];
    expect(res.status).toBe(want.status);
    expect(await res.json()).toEqual({ error: want.text, code: reason });
  });

  it('pins each refusal status', () => {
    expect(
      Object.fromEntries(
        CASE_RULE_REFUSALS.map((r) => [r, CASE_RULES_REFUSAL_HTTP[r].status])
      )
    ).toEqual({
      NOT_ALLOWED: 403,
      RULE_NOT_FOUND: 404,
      CASE_NOT_FOUND: 404,
      RULE_INVALID: 422,
      NOW_REQUIRED: 422,
    });
  });

  it('answers 500 without database text for a store failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.rules.save.mockRejectedValue(new CaseStoreError('case_rule_save', 'XX'));
    const res = await post(valid);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
  });
});

describe('DELETE /api/cases/rules/[id]', () => {
  it('is 403 for an agent', async () => {
    m.role = 'agent';
    expect((await del()).status).toBe(403);
    expect(m.rules.delete).not.toHaveBeenCalled();
  });

  it('is 404 RULE_NOT_FOUND for a non-uuid id, no store call', async () => {
    const res = await del('nope');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('RULE_NOT_FOUND');
    expect(m.rules.delete).not.toHaveBeenCalled();
  });

  it('deletes and answers { ok: true }', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.rules.delete).toHaveBeenCalledWith('u-me', RID);
  });

  it('maps a store refusal', async () => {
    m.rules.delete.mockRejectedValue(new CaseRulesRefusedError('NOT_ALLOWED'));
    expect((await del()).status).toBe(403);
  });
});

describe('GET /api/cases/[id]/rule-runs', () => {
  it('is 404 for another account s case with no service call', async () => {
    m.caseStore.get.mockResolvedValue({ id: CID, accountId: 'acct-2' });
    expect((await runs()).status).toBe(404);
    expect(m.caseStore.role).not.toHaveBeenCalled();
    expect(m.rules.runs).not.toHaveBeenCalled();
    expect(m.admin).not.toHaveBeenCalled();
  });

  it('is 404 for no role and for a non-uuid id', async () => {
    m.caseStore.role.mockResolvedValue(null);
    expect((await runs()).status).toBe(404);
    expect((await runs('nope')).status).toBe(404);
    expect(m.rules.runs).not.toHaveBeenCalled();
  });

  it('lists the projected runs in the order given', async () => {
    const run = (ruleId: string, at: string) => ({
      ruleId,
      caseId: CID,
      trigger: 'case_opened',
      fireKey: 'k',
      matched: true,
      applied: [{ kind: 'x', ok: true, refusal: null }],
      at,
    });
    m.rules.runs.mockResolvedValue([run('a', 't1'), run('b', 't2')]);
    const res = await runs();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          ruleId: 'a',
          trigger: 'case_opened',
          matched: true,
          applied: [{ kind: 'x', ok: true, refusal: null }],
          at: 't1',
        },
        {
          ruleId: 'b',
          trigger: 'case_opened',
          matched: true,
          applied: [{ kind: 'x', ok: true, refusal: null }],
          at: 't2',
        },
      ],
    });
    expect(m.rules.runs).toHaveBeenCalledWith('u-me', CID);
  });
});
