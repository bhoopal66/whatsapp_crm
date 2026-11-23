// The tracker-status lookup the case list routes add to each row.
import { describe, expect, it } from 'vitest';

import { ACCOUNT_ID, FakeClient, type Query } from './read-fakes';
import { CaseStoreError } from './store';
import { submissionStatuses } from './submission-status';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const G1 = '44444444-4444-4444-8444-444444444444';
const G2 = '55555555-5555-4555-8555-555555555555';

function db(over: { cases?: unknown[]; groups?: unknown[] } = {}) {
  return new FakeClient(
    'db',
    [],
    {},
    {
      cases: () => ({
        data: over.cases ?? [
          { id: C1, group_id: G1 },
          { id: C2, group_id: G2 },
          { id: LEAD, group_id: null },
        ],
      }),
      submission_groups: () => ({
        data: over.groups ?? [
          { id: G1, submission_status: 'UNDER_REVIEW' },
          { id: G2, submission_status: null },
        ],
      }),
    }
  );
}

describe('submissionStatuses', () => {
  it("maps each submitted case to its group's status, word for word", async () => {
    const d = db();
    const m = await submissionStatuses(d.client, ACCOUNT_ID, [C1, C2, LEAD]);
    expect([...m]).toEqual([[C1, 'UNDER_REVIEW']]);
  });

  it('confines both reads to the account', async () => {
    const d = db();
    await submissionStatuses(d.client, ACCOUNT_ID, [C1, C1, C2, LEAD]);
    const [cases] = d.queriesOf('cases');
    const [groups] = d.queriesOf('submission_groups');
    const filters = (q: Query) => q.filters;
    expect(filters(cases)).toEqual([
      ['eq', 'account_id', ACCOUNT_ID],
      ['in', 'id', [C1, C2, LEAD]],
    ]);
    expect(filters(groups)).toEqual([
      ['eq', 'account_id', ACCOUNT_ID],
      ['in', 'id', [G1, G2]],
    ]);
  });

  it('asks for both in lists of at most 100 ids', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const inList = (q: Query) =>
      q.filters.find((f) => f[0] === 'in')![2] as string[];
    const d = new FakeClient(
      'db',
      [],
      {},
      {
        cases: (q) => ({
          data: inList(q).map((id) => ({ id, group_id: `g-${id}` })),
        }),
        submission_groups: (q) => ({
          data: inList(q).map((id) => ({ id, submission_status: 'SENT' })),
        }),
      }
    );
    const m = await submissionStatuses(d.client, ACCOUNT_ID, ids);
    for (const table of ['cases', 'submission_groups'])
      expect(d.queriesOf(table).map((q) => inList(q).length)).toEqual([
        100, 100, 50,
      ]);
    expect(m.size).toBe(250);
  });

  it('asks nothing for no cases, and skips the groups when all are leads', async () => {
    const none = db();
    expect((await submissionStatuses(none.client, ACCOUNT_ID, [])).size).toBe(
      0
    );
    expect(none.queries).toHaveLength(0);
    const leads = db({ cases: [{ id: LEAD, group_id: null }] });
    expect(
      (await submissionStatuses(leads.client, ACCOUNT_ID, [LEAD])).size
    ).toBe(0);
    expect(leads.queriesOf('submission_groups')).toHaveLength(0);
  });

  it('a read error is a CaseStoreError', async () => {
    const d = new FakeClient(
      'db',
      [],
      {},
      {
        cases: () => ({ error: { code: '42501' } }),
      }
    );
    await expect(
      submissionStatuses(d.client, ACCOUNT_ID, [C1])
    ).rejects.toBeInstanceOf(CaseStoreError);
  });
});
