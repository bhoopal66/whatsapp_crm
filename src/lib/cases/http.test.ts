import { afterEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@/lib/auth/account';

import {
  canSeeCaseAudit,
  caseErrorResponse,
  CaseHttpError,
  loadCaseForCaller,
  parseAmount,
  parseInboxQuery,
} from './http';
import { CaseInboxRefusedError } from './inbox';
import { CaseRefusedError, CaseStoreError } from './store';
import type { Case, CaseRole } from './types';

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = { accountId: 'acct-1', userId: 'u-me' };
const aCase = () => ({ id: ID, accountId: 'acct-1', stage: 'New' }) as Case;

function fakeStore(c: Case | null, role: CaseRole | null) {
  return { get: vi.fn(async () => c), role: vi.fn(async () => role) };
}

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof CaseHttpError ? e.status : e;
  }
}

describe('loadCaseForCaller', () => {
  it('answers the case and role', async () => {
    const store = fakeStore(aCase(), 'coordinator');
    await expect(loadCaseForCaller(ctx, ID, store)).resolves.toEqual({
      case: aCase(),
      role: 'coordinator',
    });
    expect(store.role).toHaveBeenCalledWith(ID, 'u-me');
  });

  it('is 404 for another account, before any role call', async () => {
    const store = fakeStore({ ...aCase(), accountId: 'acct-2' }, 'admin');
    expect(await status(loadCaseForCaller(ctx, ID, store))).toBe(404);
    expect(store.role).not.toHaveBeenCalled();
  });

  it('is 404 (not 403) when the caller has no role', async () => {
    expect(
      await status(loadCaseForCaller(ctx, ID, fakeStore(aCase(), null)))
    ).toBe(404);
  });

  it('is 404 for a missing case and a non-uuid id', async () => {
    expect(
      await status(loadCaseForCaller(ctx, ID, fakeStore(null, 'admin')))
    ).toBe(404);
    const store = fakeStore(aCase(), 'admin');
    expect(await status(loadCaseForCaller(ctx, 'nope', store))).toBe(404);
    expect(store.get).not.toHaveBeenCalled();
  });
});

describe('caseErrorResponse', () => {
  afterEach(() => vi.restoreAllMocks());
  const answer = async (err: unknown) => {
    const res = caseErrorResponse(err);
    return { status: res.status, body: await res.json() };
  };

  it('maps refusals: NOT_ALLOWED 403, CASE_NOT_FOUND 404, others 422 + code', async () => {
    expect(await answer(new CaseRefusedError('NOT_ALLOWED'))).toMatchObject({
      status: 403,
    });
    expect(await answer(new CaseRefusedError('CASE_NOT_FOUND'))).toEqual({
      status: 404,
      body: { error: 'Case not found', code: 'CASE_NOT_FOUND' },
    });
    expect(await answer(new CaseRefusedError('STAGE_NOT_CONFIGURED'))).toEqual({
      status: 422,
      body: {
        error: 'Stage not configured for this bank',
        code: 'STAGE_NOT_CONFIGURED',
      },
    });
    expect(
      await answer(new CaseInboxRefusedError('FILTER_INVALID'))
    ).toMatchObject({ status: 422, body: { code: 'FILTER_INVALID' } });
    expect(
      await answer(new CaseInboxRefusedError('NOT_ALLOWED'))
    ).toMatchObject({ status: 403 });
  });

  it('passes http errors and auth errors through', async () => {
    expect(await answer(new CaseHttpError(400, 'bad'))).toEqual({
      status: 400,
      body: { error: 'bad' },
    });
    expect((await answer(new ForbiddenError())).status).toBe(403);
  });

  it('is 500 for store and unknown errors, logging no message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await answer(new CaseStoreError('case_role', '42501'))).toEqual({
      status: 500,
      body: { error: 'Something went wrong' },
    });
    expect((await answer(new Error('Jane Doe 0501234567'))).status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Jane');
  });
});

describe('canSeeCaseAudit', () => {
  it('is admin and super_admin only', () => {
    expect(canSeeCaseAudit('admin')).toBe(true);
    expect(canSeeCaseAudit('super_admin')).toBe(true);
    for (const r of ['team_lead', 'coordinator', 'agent', null] as const)
      expect(canSeeCaseAudit(r)).toBe(false);
  });
});

describe('parseAmount', () => {
  it('accepts decimal strings and numbers, refuses the rest', () => {
    expect(parseAmount('1500.50')).toBe('1500.50');
    expect(parseAmount(1500)).toBe('1500');
    for (const bad of ['-1', '1.234', 'abc', '', null, true, 1e20])
      expect(parseAmount(bad)).toBeNull();
  });
});

describe('parseInboxQuery', () => {
  const q = (s: string) => parseInboxQuery(new URLSearchParams(s));

  it('maps known params, booleans and numbers; ignores unknown and empty', () => {
    expect(
      q(
        'bank=ADCB&stage=New&agent=a&priority=high&sla_state=overdue&customer_waiting=true&documents_missing=false&bank_query_open=true&include_closed=false&no_activity_days=7&sort=stalest&limit=25&after=c1&evil=1&product='
      )
    ).toEqual({
      filters: {
        bank: 'ADCB',
        stage: 'New',
        agent: 'a',
        priority: 'high',
        slaState: 'overdue',
        customerWaiting: true,
        documentsMissing: false,
        bankQueryOpen: true,
        includeClosed: false,
        noActivityDays: 7,
        sort: 'stalest',
      },
      limit: 25,
      after: 'c1',
    });
    expect(q('bank=')).toEqual({ filters: {} });
  });

  it('passes a bad value through for the inbox to refuse', () => {
    expect(q('customer_waiting=yes&no_activity_days=x').filters).toEqual({
      customerWaiting: 'yes',
      noActivityDays: 'x',
    });
    expect(Number.isNaN(q('limit=ten').limit)).toBe(true);
  });
});
