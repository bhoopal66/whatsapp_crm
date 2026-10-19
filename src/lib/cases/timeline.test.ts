import { describe, expect, it } from 'vitest';

import { CaseRefusedError } from './store';
import { caseTimeline } from './timeline';
import {
  ACCOUNT_ID,
  ACTOR,
  CASE_ID,
  CONTACT_ID,
  FakeClient,
  fakeStore,
  groupRow,
  messageRow,
  type Result,
} from './read-fakes';

const T = '2026-10-02T09:00:00Z';
const sqlRows = [
  {
    at: T,
    kind: 'stage',
    ref_id: '1',
    actor: ACTOR,
    summary: 'New -> Submitted',
  },
  {
    at: '2026-10-01T07:00:00Z',
    kind: 'note',
    ref_id: '2',
    actor: ACTOR,
    summary: 'early',
  },
];
const callRow = (id: string, at: string) => ({
  id,
  direction: 'inbound',
  status: 'answered',
  started_at: at,
  talk_seconds: 30,
  user_id: ACTOR,
});

function setup(
  opts: {
    status?: 'ACTIVE' | 'ENDED';
    readable?: boolean;
    timeline?: Result;
    groupCreated?: string;
  } = {}
) {
  const log: string[] = [];
  const db = new FakeClient(
    'db',
    log,
    { case_timeline: () => opts.timeline ?? { data: sqlRows } },
    {
      submission_groups: () => ({
        data: groupRow(opts.status ?? 'ACTIVE', {
          created_at: opts.groupCreated ?? T,
        }),
      }),
      submission_group_messages: () => ({
        data: [messageRow('m1', T)],
      }),
      calls: () => {
        throw new Error('calls must be read through the RLS client');
      },
    }
  );
  const rlsDb = new FakeClient(
    'rls',
    log,
    {},
    {
      calls: () => ({ data: [callRow('c1', T)] }),
    }
  );
  const { store, calls } = fakeStore(log, { readable: opts.readable });
  const run = (includeMessages: boolean) =>
    caseTimeline(
      { db: db.client, rlsDb: rlsDb.client, store },
      { caseId: CASE_ID, actor: ACTOR, includeMessages }
    );
  return { log, db, rlsDb, store, calls, run };
}

describe('caseTimeline', () => {
  it('merges by time; equal times order case < group < message < call', async () => {
    const { run } = setup();
    const t = await run(true);
    expect(t.map((e) => `${e.source}:${e.kind}`)).toEqual([
      'case:note',
      'case:stage',
      'group:group_open',
      'message:group_message',
      'call:call',
    ]);
  });

  it('reads calls of the case’s contact since it opened, through the RLS client only', async () => {
    const { rlsDb, db, run } = setup();
    await run(false);
    expect(db.queriesOf('calls')).toHaveLength(0);
    const [q] = rlsDb.queriesOf('calls');
    expect(q.filters).toEqual([
      ['eq', 'account_id', ACCOUNT_ID],
      ['eq', 'contact_id', CONTACT_ID],
      ['gte', 'started_at', '2026-10-01T08:00:00.000Z'],
    ]);
  });

  it('no messages without includeMessages, and no audited read either', async () => {
    const { db, calls, run } = setup();
    const t = await run(false);
    expect(t.some((e) => e.source === 'message')).toBe(false);
    expect(db.queriesOf('submission_group_messages')).toHaveLength(0);
    expect(calls.some((c) => c.fn === 'viewCases')).toBe(false);
  });

  it('messages only after view_case returned the case', async () => {
    const { log, run } = setup();
    await run(true);
    expect(log.indexOf('store.viewCases')).toBeGreaterThan(-1);
    expect(log.indexOf('store.viewCases')).toBeLessThan(
      log.indexOf('db.from:submission_group_messages')
    );
    const refused = setup({ readable: false });
    const t = await refused.run(true);
    expect(t.some((e) => e.source === 'message')).toBe(false);
    expect(refused.db.queriesOf('submission_group_messages')).toHaveLength(0);
  });

  it('live messages exclude post_end rows', async () => {
    const { db, run } = setup();
    await run(true);
    expect(db.queriesOf('submission_group_messages')[0].filters).toContainEqual(
      ['eq', 'post_end', false]
    );
  });

  it('an ENDED group’s messages never enter the timeline: one archived entry instead', async () => {
    const { db, run } = setup({ status: 'ENDED' });
    const t = await run(true);
    expect(t.some((e) => e.source === 'message')).toBe(false);
    expect(db.queriesOf('submission_group_messages')).toHaveLength(0);
    expect(t.filter((e) => e.kind === 'conversation_archived')).toHaveLength(1);
    expect(t.map((e) => e.kind)).toContain('group_end');
  });

  it('a case_timeline refusal is typed and nothing else is read', async () => {
    const { db, rlsDb, calls, run } = setup({
      timeline: { error: { message: 'x', code: '42501', hint: 'NOT_ALLOWED' } },
    });
    const err = await run(true).catch((e) => e);
    expect(err).toBeInstanceOf(CaseRefusedError);
    expect(err.reason).toBe('NOT_ALLOWED');
    expect(db.queries).toHaveLength(0);
    expect(rlsDb.queries).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
