// The case store on a fake supabase-js client: `rpc` answers from a
// per-function script and records every call; `from(table)` serves rows
// filtered by `.eq`. The SQL behaviour (claims, tokens, roles) is
// migration 122's and supabase/ci/verify-cases.sql's; this file pins what
// the store sends, how it reads the answers and the group-end flow.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { EndResult } from '@/lib/submission-groups/service';

import { sweepCaseGroupEnds } from './cron';
import {
  CaseRefusedError,
  CaseStore,
  CaseStoreError,
  VIEW_CASES_MAX,
  type GroupEnder,
} from './store';

type Args = Record<string, unknown>;
type Answer = {
  data?: unknown;
  error?: { message: string; code?: string; hint?: string | null };
};
type Row = Record<string, unknown>;

class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  constructor(
    readonly script: Record<string, Answer | Answer[]> = {},
    readonly tables: Record<string, Row[]> = {}
  ) {}
  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    const s = this.script[fn];
    const a = Array.isArray(s) ? s.shift() : s;
    if (a === undefined) throw new Error(`unscripted rpc ${fn}`);
    return { data: a.data ?? null, error: a.error ?? null };
  }
  from(table: string) {
    const filters: [string, unknown][] = [];
    const result = () =>
      (this.tables[table] ?? []).filter((r) =>
        filters.every(([k, v]) => r[k] === v)
      );
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return b;
      },
      order: async () => ({ data: result(), error: null }),
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
    };
    return b;
  }
  of(fn: string): Args[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
  get fns(): string[] {
    return this.calls.map((c) => c.fn);
  }
  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

const CASE = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const CONTACT = '55555555-5555-4555-8555-555555555555';
/** Microseconds and offset exactly as PostgREST renders a timestamptz. */
const TOKEN = '2026-10-19T08:15:42.123456+00:00';

const endResult = (over: Partial<EndResult> = {}): EndResult => ({
  ended: true,
  reason: 'CASE_APPROVED',
  closed: true,
  closeError: null,
  closeDeferred: false,
  ...over,
});

const stageRow = (over: Row = {}): Answer => ({
  data: [
    {
      moved: true,
      from_stage: 'Under review',
      to_stage: 'Approved',
      outcome: 'Approved',
      end_group: true,
      claim_token: TOKEN,
      ...over,
    },
  ],
});

function setup(opts: {
  script?: Record<string, Answer | Answer[]>;
  groupStatus?: string;
  ender?: GroupEnder | null;
}) {
  const db = new FakeDb(
    {
      case_finish_group_end: { data: true },
      case_release_group_end: { data: true },
      ...opts.script,
    },
    {
      cases: [{ id: CASE, group_id: GROUP, account_id: ACCOUNT }],
      submission_groups: [{ id: GROUP, status: opts.groupStatus ?? 'ACTIVE' }],
    }
  );
  const ender =
    opts.ender === null
      ? undefined
      : (opts.ender ?? { endNow: vi.fn(async () => endResult()) });
  const store = new CaseStore(db.client, ender ? { ender } : {});
  return { db, store, ender };
}

describe('setStage', () => {
  it('sends the exact args, p_claim true when an ender is wired', async () => {
    const { db, store } = setup({
      script: { case_set_stage: stageRow({ end_group: false }) },
    });
    await store.setStage(CASE, ACTOR, 'Approved', 'Approved');
    expect(db.of('case_set_stage')).toEqual([
      {
        p_case: CASE,
        p_actor: ACTOR,
        p_to_stage: 'Approved',
        p_outcome: 'Approved',
        p_claim: true,
      },
    ]);
  });

  it('end_group false: no ender call, no claim calls', async () => {
    const { db, store, ender } = setup({
      script: {
        case_set_stage: stageRow({
          to_stage: 'Query raised',
          outcome: null,
          end_group: false,
          claim_token: null,
        }),
      },
    });
    const r = await store.setStage(CASE, ACTOR, 'Query raised');
    expect(r).toEqual({
      moved: true,
      fromStage: 'Under review',
      toStage: 'Query raised',
      outcome: null,
      groupEnd: null,
    });
    expect(ender!.endNow).not.toHaveBeenCalled();
    expect(db.fns).toEqual(['case_set_stage']);
  });

  it('end_group true and endNow ends: finishes with the exact token', async () => {
    const { db, store, ender } = setup({
      script: { case_set_stage: stageRow() },
    });
    const r = await store.setStage(CASE, ACTOR, 'Approved', 'Approved');
    expect(ender!.endNow).toHaveBeenCalledWith(GROUP, 'CASE_APPROVED');
    expect(db.of('case_finish_group_end')).toEqual([
      { p_case: CASE, p_token: TOKEN },
    ]);
    expect(db.of('case_release_group_end')).toEqual([]);
    expect(r.groupEnd).toEqual({
      groupEnded: true,
      reason: 'ENDED',
      end: endResult(),
    });
  });

  it('group already ENDED (endNow ended false): finishes, ALREADY_ENDED', async () => {
    const ender = {
      endNow: vi.fn(async () => endResult({ ended: false, reason: null })),
    };
    const { db, store } = setup({
      script: { case_set_stage: stageRow({ to_stage: 'Closed' }) },
      groupStatus: 'ENDED',
      ender,
    });
    const r = await store.setStage(CASE, ACTOR, 'Closed');
    expect(ender.endNow).toHaveBeenCalledWith(GROUP, 'CASE_CLOSED');
    expect(db.of('case_finish_group_end')).toEqual([
      { p_case: CASE, p_token: TOKEN },
    ]);
    expect(db.of('case_release_group_end')).toEqual([]);
    expect(r.groupEnd?.reason).toBe('ALREADY_ENDED');
    expect(r.groupEnd?.groupEnded).toBe(false);
  });

  it('endNow ended nothing and the group is still ACTIVE: releases, NOT_DUE', async () => {
    const ender = {
      endNow: vi.fn(async () => endResult({ ended: false, reason: null })),
    };
    const { db, store } = setup({
      script: { case_set_stage: stageRow() },
      ender,
    });
    const r = await store.setStage(CASE, ACTOR, 'Approved');
    expect(db.of('case_release_group_end')).toEqual([
      { p_case: CASE, p_token: TOKEN },
    ]);
    expect(db.of('case_finish_group_end')).toEqual([]);
    expect(r.groupEnd?.reason).toBe('NOT_DUE');
  });

  it('endNow throws: releases with the token, END_FAILED, and still resolves', async () => {
    const ender = {
      endNow: vi.fn(async () => {
        throw new Error('whapi down');
      }),
    };
    const { db, store } = setup({
      script: { case_set_stage: stageRow() },
      ender,
    });
    const r = await store.setStage(CASE, ACTOR, 'Approved');
    expect(r.moved).toBe(true);
    expect(r.groupEnd).toEqual({
      groupEnded: false,
      reason: 'END_FAILED',
      end: null,
    });
    expect(db.of('case_release_group_end')).toEqual([
      { p_case: CASE, p_token: TOKEN },
    ]);
    expect(db.of('case_finish_group_end')).toEqual([]);
  });

  it('finish failing after an end: release, END_FAILED, still resolves', async () => {
    const { db, store } = setup({
      script: {
        case_set_stage: stageRow(),
        case_finish_group_end: { error: { message: 'x', code: '08006' } },
        case_release_group_end: { error: { message: 'y', code: '08006' } },
      },
    });
    const r = await store.setStage(CASE, ACTOR, 'Approved');
    expect(r.groupEnd?.reason).toBe('END_FAILED');
    expect(db.of('case_release_group_end')).toHaveLength(1);
  });

  it('no ender: p_claim false, NO_DEPS on a final move, no claim calls', async () => {
    const { db, store } = setup({
      script: {
        case_set_stage: stageRow({ end_group: false, claim_token: null }),
      },
      ender: null,
    });
    const r = await store.setStage(CASE, ACTOR, 'Approved');
    expect(db.of('case_set_stage')[0]!.p_claim).toBe(false);
    expect(r.groupEnd).toEqual({
      groupEnded: false,
      reason: 'NO_DEPS',
      end: null,
    });
    expect(db.fns).toEqual(['case_set_stage']);
  });

  it('a refusal HINT becomes CaseRefusedError(reason)', async () => {
    const { store } = setup({
      script: {
        case_set_stage: {
          error: {
            message: 'case is closed',
            code: '23514',
            hint: 'CASE_CLOSED',
          },
        },
      },
    });
    const err = await store
      .setStage(CASE, ACTOR, 'Approved')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseRefusedError);
    expect((err as CaseRefusedError).reason).toBe('CASE_CLOSED');
  });

  it('another error becomes CaseStoreError without the database text', async () => {
    const { store } = setup({
      script: {
        case_set_stage: {
          error: { message: 'secret detail', code: '42501', hint: 'other' },
        },
      },
    });
    const err = await store
      .setStage(CASE, ACTOR, 'Approved')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStoreError);
    expect(err).toMatchObject({ fn: 'case_set_stage', code: '42501' });
    expect((err as Error).message).not.toContain('secret');
  });
});

describe('retryGroupEnd / retryGroupEndSystem', () => {
  const claim = (over: Row = {}): Answer => ({
    data: [
      {
        claimed: true,
        stage: 'Declined',
        state: 'CLAIMED',
        claim_token: TOKEN,
        ...over,
      },
    ],
  });

  it('not claimed: the state, else CLAIM_HELD; no end', async () => {
    const { db, store, ender } = setup({
      script: {
        case_claim_group_end: [
          claim({ claimed: false, state: 'CLAIM_HELD', claim_token: null }),
          claim({ claimed: false, state: 'NOT_FINAL', claim_token: null }),
          claim({ claimed: false, state: 'odd', claim_token: null }),
        ],
      },
    });
    expect((await store.retryGroupEnd(CASE, ACTOR)).reason).toBe('CLAIM_HELD');
    expect((await store.retryGroupEnd(CASE, ACTOR)).reason).toBe('NOT_FINAL');
    expect((await store.retryGroupEnd(CASE, ACTOR)).reason).toBe('CLAIM_HELD');
    expect(ender!.endNow).not.toHaveBeenCalled();
    expect(db.of('case_claim_group_end')[0]).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_stale_after: '15 minutes',
    });
  });

  it('person retry: claims, ends with the stage reason, finishes with the token', async () => {
    const { db, store, ender } = setup({
      script: { case_claim_group_end: claim() },
    });
    const r = await store.retryGroupEnd(CASE, ACTOR);
    expect(ender!.endNow).toHaveBeenCalledWith(GROUP, 'CASE_DECLINED');
    expect(r.reason).toBe('ENDED');
    expect(db.of('case_finish_group_end')).toEqual([
      { p_case: CASE, p_token: TOKEN },
    ]);
  });

  it('system retry: no actor; a failing end releases with the token', async () => {
    const { db, store } = setup({
      script: { case_claim_group_end_system: claim() },
      ender: {
        endNow: async () => {
          throw new Error('boom');
        },
      },
    });
    const r = await store.retryGroupEndSystem(CASE);
    expect(db.of('case_claim_group_end_system')).toEqual([
      { p_case: CASE, p_stale_after: '15 minutes' },
    ]);
    expect(r.reason).toBe('END_FAILED');
    expect(db.of('case_release_group_end')).toEqual([
      { p_case: CASE, p_token: TOKEN },
    ]);
  });

  it('no ender: NO_DEPS without taking a claim', async () => {
    const { db, store } = setup({ ender: null });
    expect((await store.retryGroupEndSystem(CASE)).reason).toBe('NO_DEPS');
    expect(db.calls).toEqual([]);
  });
});

describe('viewCases', () => {
  it('dedupes, keeps request order, returns only readable ids', async () => {
    const { db, store } = setup({
      script: { view_case: { data: ['c', 'a'] } },
    });
    expect(await store.viewCases(ACTOR, ['a', 'b', 'a', 'c', 'b'])).toEqual([
      'a',
      'c',
    ]);
    expect(db.of('view_case')).toEqual([
      { p_actor: ACTOR, p_case_ids: ['a', 'b', 'c'] },
    ]);
  });

  it('caps the distinct ids sent; an empty list makes no call', async () => {
    const { db, store } = setup({ script: { view_case: { data: [] } } });
    const ids = Array.from({ length: VIEW_CASES_MAX + 50 }, (_, i) => `id${i}`);
    await store.viewCases(ACTOR, [...ids, ...ids]);
    expect(db.of('view_case')[0]!.p_case_ids).toEqual(
      ids.slice(0, VIEW_CASES_MAX)
    );
    expect(await store.viewCases(ACTOR, [])).toEqual([]);
    expect(db.of('view_case')).toHaveLength(1);
  });
});

describe('RPC arguments', () => {
  it('case_open sends nulls for every gap and reads (case_id, created)', async () => {
    const { db, store } = setup({
      script: {
        case_open: [
          { data: [{ case_id: CASE, created: true }] },
          { data: [{ case_id: CASE, created: false }] },
        ],
      },
    });
    expect(await store.open(GROUP, {}, null)).toEqual({
      caseId: CASE,
      created: true,
    });
    await store.open(
      GROUP,
      {
        bankCode: 'ADCB',
        bankName: 'ADCB Bank',
        product: 'PL',
        amount: '1500.00',
      },
      ACTOR
    );
    expect(db.of('case_open')).toEqual([
      {
        p_group: GROUP,
        p_bank_code: null,
        p_bank_name: null,
        p_product: null,
        p_amount: null,
        p_actor: null,
      },
      {
        p_group: GROUP,
        p_bank_code: 'ADCB',
        p_bank_name: 'ADCB Bank',
        p_product: 'PL',
        p_amount: '1500.00',
        p_actor: ACTOR,
      },
    ]);
  });

  it('the rest of the signatures', async () => {
    const { db, store } = setup({
      script: {
        case_role: { data: 'team_lead' },
        case_set_details: { data: ['product'] },
        case_set_priority: { data: true },
        case_set_due: { data: false },
        case_reassign: {
          data: [{ changed: true, from_user: null, to_user: ACTOR }],
        },
        case_audit_list: { data: [] },
        case_apply_submission_status: { data: true },
        case_pending_group_end: {
          data: [{ case_id: CASE, account_id: ACCOUNT, group_id: GROUP }],
        },
        case_stages_for_bank: { data: ['Submitted', 'Closed'] },
        case_bank_upsert: {
          data: { account_id: ACCOUNT, code: 'ADCB', name: 'ADCB' },
        },
        case_bank_stages_set: { data: 2 },
      },
    });
    expect(await store.role(CASE, ACTOR)).toBe('team_lead');
    expect(await store.setDetails(CASE, ACTOR, { product: 'PL' })).toEqual([
      'product',
    ]);
    expect(await store.setPriority(CASE, ACTOR, 'urgent')).toBe(true);
    expect(
      await store.setDue(CASE, ACTOR, new Date('2026-10-20T00:00:00Z'))
    ).toBe(false);
    expect(await store.reassign(CASE, ACTOR, 'coordinator', ACTOR)).toEqual({
      changed: true,
      fromUser: null,
      toUser: ACTOR,
    });
    await store.auditList(ACTOR, CASE);
    expect(await store.applySubmissionStatus(GROUP, 'APPROVED')).toBe(true);
    expect(await store.pendingGroupEnd(5)).toEqual([
      { caseId: CASE, accountId: ACCOUNT, groupId: GROUP },
    ]);
    expect(await store.stagesFor(ACCOUNT, null)).toEqual([
      'Submitted',
      'Closed',
    ]);
    expect(await store.upsertBank(ACTOR, ACCOUNT, 'ADCB', 'ADCB')).toEqual({
      accountId: ACCOUNT,
      code: 'ADCB',
      name: 'ADCB',
    });
    expect(await store.setStages(ACTOR, ACCOUNT, 'ADCB', ['a', 'b'])).toBe(2);
    expect(db.calls).toEqual([
      { fn: 'case_role', args: { p_case: CASE, p_user: ACTOR } },
      {
        fn: 'case_set_details',
        args: {
          p_case: CASE,
          p_actor: ACTOR,
          p_bank_code: null,
          p_product: 'PL',
          p_amount: null,
        },
      },
      {
        fn: 'case_set_priority',
        args: { p_case: CASE, p_actor: ACTOR, p_priority: 'urgent' },
      },
      {
        fn: 'case_set_due',
        args: {
          p_case: CASE,
          p_actor: ACTOR,
          p_due_at: '2026-10-20T00:00:00.000Z',
        },
      },
      {
        fn: 'case_reassign',
        args: {
          p_case: CASE,
          p_actor: ACTOR,
          p_field: 'coordinator',
          p_to_user: ACTOR,
        },
      },
      {
        fn: 'case_audit_list',
        args: { p_actor: ACTOR, p_case: CASE, p_limit: null },
      },
      {
        fn: 'case_apply_submission_status',
        args: { p_group: GROUP, p_status: 'APPROVED' },
      },
      {
        fn: 'case_pending_group_end',
        args: { p_stale_after: '15 minutes', p_limit: 5 },
      },
      {
        fn: 'case_stages_for_bank',
        args: { p_account: ACCOUNT, p_bank_code: null },
      },
      {
        fn: 'case_bank_upsert',
        args: {
          p_actor: ACTOR,
          p_account: ACCOUNT,
          p_code: 'ADCB',
          p_name: 'ADCB',
        },
      },
      {
        fn: 'case_bank_stages_set',
        args: {
          p_actor: ACTOR,
          p_account: ACCOUNT,
          p_bank_code: 'ADCB',
          p_stages: ['a', 'b'],
        },
      },
    ]);
  });
});

describe('get', () => {
  it('joins the group ref, contact name and bank name; amount stays a string', async () => {
    const db = new FakeDb(
      {},
      {
        cases: [
          {
            id: CASE,
            account_id: ACCOUNT,
            group_id: GROUP,
            bank_code: 'ADCB',
            product: 'PL',
            amount: '1500.00',
            agent_id: ACTOR,
            coordinator_id: null,
            stage: 'Submitted',
            priority: 'normal',
            due_at: null,
            sla_state: null,
            opened_at: '2026-10-19T08:00:00+00:00',
            closed_at: null,
            outcome: null,
            group_ended_at: null,
          },
        ],
        submission_groups: [
          { id: GROUP, submission_ref: 'S-1', contact_id: CONTACT },
        ],
        contacts: [{ id: CONTACT, name: 'Customer' }],
        case_banks: [{ account_id: ACCOUNT, code: 'ADCB', name: 'ADCB Bank' }],
      }
    );
    const c = await new CaseStore(db.client).get(CASE);
    expect(c).toMatchObject({
      id: CASE,
      accountId: ACCOUNT,
      groupId: GROUP,
      submissionRef: 'S-1',
      contactId: CONTACT,
      contactName: 'Customer',
      bankName: 'ADCB Bank',
      amount: '1500.00',
      openedAt: new Date('2026-10-19T08:00:00Z'),
    });
    expect(await new CaseStore(db.client).get('nope')).toBeNull();
  });
});

describe('sweepCaseGroupEnds', () => {
  it('retries each case on its own account store and stops at the deadline', async () => {
    let t = 0;
    const pending = [
      { caseId: 'c1', accountId: 'A', groupId: 'g1' },
      { caseId: 'c2', accountId: 'B', groupId: 'g2' },
      { caseId: 'c3', accountId: 'A', groupId: 'g3' },
    ];
    const seen: string[] = [];
    const storeFor = vi.fn((account: string) => ({
      retryGroupEndSystem: async (caseId: string) => {
        seen.push(`${account}:${caseId}`);
        t += 60;
        if (caseId === 'c2') throw new Error('db');
        return { groupEnded: true, reason: 'ENDED' as const, end: null };
      },
    }));
    const r = await sweepCaseGroupEnds({
      store: { pendingGroupEnd: async () => pending },
      storeFor,
      deadlineMs: 100,
      now: () => t,
    });
    expect(seen).toEqual(['A:c1', 'B:c2']);
    expect(r).toEqual({
      attempted: 2,
      results: [
        { caseId: 'c1', reason: 'ENDED' },
        { caseId: 'c2', reason: 'ERROR' },
      ],
      stopped: true,
    });
    expect(storeFor.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
  });
});
