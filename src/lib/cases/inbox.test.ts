import { describe, expect, it } from 'vitest';

import { CaseInbox, CaseInboxRefusedError } from './inbox';
import { CaseStoreError } from './store';
import {
  ACCOUNT_ID,
  ACTOR,
  CASE_ID,
  FakeClient,
  type Result,
} from './read-fakes';

const NOW = new Date('2026-10-19T10:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  case_id: CASE_ID,
  bank_code: 'ADCB',
  stage: 'Submitted',
  agent_id: ACTOR,
  coordinator_id: null,
  priority: 'high',
  due_at: '2026-10-20T10:00:00Z',
  sla_state: 'overdue',
  overdue_rank: [42, 3],
  customer_waiting: true,
  documents_missing: 2,
  bank_query_open: false,
  last_activity_at: '2026-10-18T10:00:00Z',
  last_touched_by: ACTOR,
  open_task_overdue_count: 3,
  submission_ref: 'SUB-1',
  contact_id: null,
  contact_name: null,
  bank_name: 'ADCB',
  product: 'loan',
  amount: 1500,
  opened_at: '2026-10-01T08:00:00Z',
  closed_at: null,
  cursor: '{"sort":"most_overdue","now":"2026-10-19T10:00:00.123456+00:00"}',
  ...over,
});

function inbox(answer: (a: Record<string, unknown>) => Result) {
  const db = new FakeClient('db', [], { case_inbox: answer });
  return { db, inbox: new CaseInbox(db.client, () => NOW) };
}

describe('CaseInbox.list', () => {
  it('maps the typed filters to 125’s keys and passes actor, account, clock, limit', async () => {
    const { db, inbox: ib } = inbox(() => ({ data: [row()] }));
    const page = await ib.list(
      ACTOR,
      ACCOUNT_ID,
      {
        slaState: 'overdue',
        customerWaiting: true,
        noActivityDays: 3,
        includeClosed: false,
        agent: ACTOR,
        sort: 'stalest',
      },
      { limit: 10 }
    );
    expect(db.rpcs[0].args).toEqual({
      p_actor: ACTOR,
      p_account: ACCOUNT_ID,
      p_filters: {
        sla_state: 'overdue',
        customer_waiting: true,
        no_activity_days: 3,
        include_closed: false,
        agent: ACTOR,
        sort: 'stalest',
      },
      p_now: NOW.toISOString(),
      p_limit: 10,
      p_after: null,
    });
    expect(page.rows[0]).toMatchObject({
      caseId: CASE_ID,
      priority: 'high',
      overdueRank: { slaOverdueMinutes: 42, overdueTasks: 3 },
      documentsMissing: 2,
      amount: '1500',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('a full page returns the last row’s cursor; with after and no now the cursor’s clock text is sent', async () => {
    const { db, inbox: ib } = inbox(() => ({ data: [row()] }));
    const first = await ib.list(ACTOR, ACCOUNT_ID, {}, { limit: 1 });
    expect(first.nextCursor).toBe(row().cursor);
    await ib.list(ACTOR, ACCOUNT_ID, {}, { limit: 1, after: first.nextCursor });
    expect(db.rpcs[1].args.p_now).toBe('2026-10-19T10:00:00.123456+00:00');
    expect(db.rpcs[1].args.p_after).toBe(first.nextCursor);
  });

  it.each([
    [{ bogus: 1 }],
    [{ role: 'admin' }],
    [{ priority: 'critical' }],
    [{ agent: 'not-a-uuid' }],
    [{ noActivityDays: 0 }],
    [{ noActivityDays: 1.5 }],
    [{ customerWaiting: 'yes' }],
    [{ bank: '   ' }],
  ])('refuses %j with FILTER_INVALID before any call', async (f) => {
    const { db, inbox: ib } = inbox(() => ({ data: [] }));
    await expect(ib.list(ACTOR, ACCOUNT_ID, f as never)).rejects.toMatchObject({
      reason: 'FILTER_INVALID',
    });
    expect(db.rpcs).toHaveLength(0);
  });

  it('refuses a bad limit or cursor before any call', async () => {
    const { db, inbox: ib } = inbox(() => ({ data: [] }));
    await expect(
      ib.list(ACTOR, ACCOUNT_ID, {}, { limit: 0 })
    ).rejects.toMatchObject({ reason: 'LIMIT_INVALID' });
    await expect(
      ib.list(ACTOR, ACCOUNT_ID, {}, { after: 'nope' })
    ).rejects.toMatchObject({ reason: 'CURSOR_INVALID' });
    expect(db.rpcs).toHaveLength(0);
  });

  it('types the SQL refusals; anything else is a CaseStoreError', async () => {
    for (const hint of ['NOT_ALLOWED', 'CURSOR_INVALID', 'NOW_REQUIRED']) {
      const { inbox: ib } = inbox(() => ({
        error: { message: 'x', code: '22023', hint },
      }));
      const err = await ib.list(ACTOR, ACCOUNT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(CaseInboxRefusedError);
      expect(err.reason).toBe(hint);
    }
    const { inbox: ib } = inbox(() => ({
      error: { message: 'x', code: '42P01' },
    }));
    await expect(ib.list(ACTOR, ACCOUNT_ID)).rejects.toBeInstanceOf(
      CaseStoreError
    );
  });
});
