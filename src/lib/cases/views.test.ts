import { describe, expect, it } from 'vitest';

import { FakeClient, ACTOR, CASE_ID, type Result } from './read-fakes';
import { CaseStoreError } from './store';
import { CaseViews, CaseViewsRefusedError, viewSqlFilters } from './views';

const NOW = new Date('2026-11-10T09:00:00Z');
const VIEW = '99999999-9999-4999-8999-999999999999';

const viewRow = (over: Record<string, unknown> = {}) => ({
  view_id: VIEW,
  account_id: 'acct-1',
  owner_user_id: ACTOR,
  name: 'Overdue ADCB',
  filters: { bank: 'ADCB', sla_state: 'overdue', snoozed: 'all' },
  sort: 'most_overdue',
  shared: false,
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-02T10:00:00Z',
  ...over,
});

const mention = (id: string, over: Record<string, unknown> = {}) => ({
  note_id: id,
  case_id: CASE_ID,
  stage: 'Submitted',
  author_id: ACTOR,
  system_author: null,
  created_at: '2026-11-09T10:00:00Z',
  body: 'please check @me',
  cursor: `{"now": "2026-11-10T09:00:00.123456+00:00", "note_id": "${id}", "created_at": "x"}`,
  ...over,
});

function views(script: Record<string, (a: Record<string, unknown>) => Result>) {
  const db = new FakeClient('db', [], script);
  return { db, views: new CaseViews(db.client, () => NOW) };
}

describe('CaseViews saved views', () => {
  it('saves with the inbox’s SQL keys and maps the row back to camelCase', async () => {
    const { db, views: v } = views({
      case_view_save: () => ({ data: viewRow() }),
    });
    const view = await v.save(ACTOR, {
      name: 'Overdue ADCB',
      filters: { bank: 'ADCB', slaState: 'overdue', snoozed: 'all' },
      sort: 'most_overdue',
    });
    expect(db.rpcs[0]).toEqual({
      fn: 'case_view_save',
      args: {
        p_actor: ACTOR,
        p_view_id: null,
        p_name: 'Overdue ADCB',
        p_filters: { bank: 'ADCB', sla_state: 'overdue', snoozed: 'all' },
        p_sort: 'most_overdue',
        p_shared: false,
      },
    });
    expect(view).toEqual({
      viewId: VIEW,
      ownerUserId: ACTOR,
      name: 'Overdue ADCB',
      filters: { bank: 'ADCB', slaState: 'overdue', snoozed: 'all' },
      sort: 'most_overdue',
      shared: false,
      createdAt: new Date('2026-11-01T10:00:00Z'),
      updatedAt: new Date('2026-11-02T10:00:00Z'),
    });
  });

  it.each([
    [{ sort: 'stalest' }],
    [{ bogus: true }],
    [{ snoozed: 'later' }],
    [{ mentionedMe: 'yes' }],
    [['bank']],
  ])('refuses filters %j with FILTER_INVALID before any call', async (f) => {
    const { db, views: v } = views({});
    await expect(
      v.save(ACTOR, { name: 'x', filters: f })
    ).rejects.toMatchObject({ reason: 'FILTER_INVALID' });
    expect(db.rpcs).toHaveLength(0);
  });

  it('refuses a bad sort or a non-text name before any call', async () => {
    const { db, views: v } = views({});
    await expect(
      v.save(ACTOR, { name: 'x', sort: 'random' })
    ).rejects.toMatchObject({ reason: 'FILTER_INVALID' });
    await expect(v.save(ACTOR, { name: 7 })).rejects.toMatchObject({
      reason: 'NAME_INVALID',
    });
    expect(db.rpcs).toHaveLength(0);
    expect(viewSqlFilters(undefined)).toEqual({});
  });

  it('lists and deletes for the actor; types the SQL refusals', async () => {
    const { db, views: v } = views({
      case_view_list: () => ({ data: [viewRow({ shared: true })] }),
      case_view_delete: () => ({
        error: { code: 'P0002', hint: 'VIEW_NOT_FOUND' },
      }),
    });
    expect((await v.list(ACTOR))[0]).toMatchObject({ shared: true });
    const err = await v.delete(ACTOR, VIEW).catch((e) => e);
    expect(err).toBeInstanceOf(CaseViewsRefusedError);
    expect(err.reason).toBe('VIEW_NOT_FOUND');
    expect(db.rpcs.map((r) => r.args)).toEqual([
      { p_actor: ACTOR },
      { p_actor: ACTOR, p_view_id: VIEW },
    ]);
  });

  it('a database error that is not a refusal is a CaseStoreError', async () => {
    const { views: v } = views({
      case_view_list: () => ({ error: { code: '42P01' } }),
    });
    await expect(v.list(ACTOR)).rejects.toBeInstanceOf(CaseStoreError);
  });
});

describe('CaseViews snooze', () => {
  it('passes until, reason and the server clock; answers the stored end', async () => {
    const until = new Date('2026-11-12T09:00:00Z');
    const { db, views: v } = views({
      case_snooze: () => ({ data: '2026-11-12T09:00:00+00:00' }),
      case_unsnooze: () => ({ data: null }),
    });
    expect(await v.snooze(ACTOR, CASE_ID, until, 'waiting on bank')).toEqual(
      until
    );
    await v.unsnooze(ACTOR, CASE_ID);
    expect(db.rpcs).toEqual([
      {
        fn: 'case_snooze',
        args: {
          p_actor: ACTOR,
          p_case: CASE_ID,
          p_until: until.toISOString(),
          p_reason: 'waiting on bank',
          p_now: NOW.toISOString(),
        },
      },
      {
        fn: 'case_unsnooze',
        args: { p_actor: ACTOR, p_case: CASE_ID, p_now: NOW.toISOString() },
      },
    ]);
  });
});

describe('CaseViews mentions', () => {
  it('first page at the server clock; a short page has no next', async () => {
    const { db, views: v } = views({
      case_mentions: () => ({
        data: [mention('n1', { author_id: null, system_author: 'sla' })],
      }),
    });
    const page = await v.mentions(ACTOR);
    expect(db.rpcs[0].args).toEqual({
      p_actor: ACTOR,
      p_now: NOW.toISOString(),
      p_limit: 50,
      p_after: null,
    });
    expect(page).toEqual({
      items: [
        {
          noteId: 'n1',
          caseId: CASE_ID,
          stage: 'Submitted',
          authorId: null,
          systemAuthor: 'sla',
          createdAt: new Date('2026-11-09T10:00:00Z'),
          body: 'please check @me',
        },
      ],
      next: null,
    });
  });

  it('a full page gives the last cursor; after passes it with its own clock text', async () => {
    const { db, views: v } = views({
      case_mentions: () => ({ data: [mention('n1'), mention('n2')] }),
    });
    const first = await v.mentions(ACTOR, { limit: 2 });
    expect(first.next).toBe(mention('n2').cursor);
    await v.mentions(ACTOR, { limit: 2, after: first.next });
    expect(db.rpcs[1].args).toEqual({
      p_actor: ACTOR,
      p_now: '2026-11-10T09:00:00.123456+00:00',
      p_limit: 2,
      p_after: first.next,
    });
  });

  it('refuses a bad limit or cursor before any call', async () => {
    const { db, views: v } = views({});
    await expect(v.mentions(ACTOR, { limit: 0 })).rejects.toMatchObject({
      reason: 'LIMIT_INVALID',
    });
    await expect(v.mentions(ACTOR, { limit: NaN })).rejects.toMatchObject({
      reason: 'LIMIT_INVALID',
    });
    for (const after of ['nope', '{"now":"never"}', '[]'])
      await expect(v.mentions(ACTOR, { after })).rejects.toMatchObject({
        reason: 'CURSOR_INVALID',
      });
    expect(db.rpcs).toHaveLength(0);
  });
});
