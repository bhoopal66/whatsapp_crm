// The bank workspace store on a fake supabase-js client: the exact args
// each wrapper sends, row mapping, hints -> BankWorkspaceRefusedError, and
// a non-member's empty lists. The SQL is 126's (verify-bank-workspaces.sql).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  BANK_WS_REFUSALS,
  BankWorkspaceRefusedError,
  BankWorkspaceStore,
} from './bank-workspaces';
import { CaseRefusedError, CaseStoreError } from './store';

type Args = Record<string, unknown>;
type Answer = {
  data?: unknown;
  error?: { message: string; hint?: string; code?: string };
};

class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  constructor(readonly script: Record<string, Answer> = {}) {}
  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    const a = this.script[fn];
    if (!a) throw new Error(`unscripted rpc ${fn}`);
    return { data: a.data ?? null, error: a.error ?? null };
  }
  get client() {
    return this as unknown as SupabaseClient;
  }
}

const WS = '11111111-1111-4111-8111-111111111111';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const THREAD = '55555555-5555-4555-8555-555555555555';
const POST = '66666666-6666-4666-8666-666666666666';
const CASE = '77777777-7777-4777-8777-777777777777';
const TASK = '88888888-8888-4888-8888-888888888888';
const OWNER = '99999999-9999-4999-8999-999999999999';
const T0 = new Date('2026-10-19T08:00:00.000Z');
const NOW = T0.toISOString();
const DUE = new Date('2026-10-21T12:00:00.000Z');

function store(script: Record<string, Answer>) {
  const db = new FakeDb(script);
  return { db, s: new BankWorkspaceStore(db.client, () => T0) };
}

describe('BankWorkspaceStore: what each wrapper sends', () => {
  it('create', async () => {
    const { db, s } = store({ bank_ws_create: { data: WS } });
    await expect(s.create(ACTOR, ACCOUNT, 'ADCB')).resolves.toBe(WS);
    expect(db.calls).toEqual([
      {
        fn: 'bank_ws_create',
        args: {
          p_actor: ACTOR,
          p_account: ACCOUNT,
          p_bank_code: 'ADCB',
          p_now: NOW,
        },
      },
    ]);
  });

  it('setPin returns the bigint version id as a string', async () => {
    const { db, s } = store({ bank_ws_pin_set: { data: 42 } });
    await expect(s.setPin(WS, ACTOR, 'product_rules', 'rules')).resolves.toBe(
      '42'
    );
    expect(db.calls[0].args).toEqual({
      p_bank_ws: WS,
      p_actor: ACTOR,
      p_kind: 'product_rules',
      p_body: 'rules',
      p_now: NOW,
    });
  });

  it('createThread with and without a link', async () => {
    const { db, s } = store({ bank_ws_thread_create: { data: THREAD } });
    await s.createThread({ bankWsId: WS, actor: ACTOR, title: 'T', body: 'B' });
    await s.createThread({
      bankWsId: WS,
      actor: ACTOR,
      title: 'T',
      body: 'B',
      caseId: CASE,
      taskId: TASK,
    });
    expect(db.calls.map((c) => c.args)).toEqual([
      {
        p_bank_ws: WS,
        p_actor: ACTOR,
        p_title: 'T',
        p_body: 'B',
        p_case: null,
        p_task: null,
        p_now: NOW,
      },
      {
        p_bank_ws: WS,
        p_actor: ACTOR,
        p_title: 'T',
        p_body: 'B',
        p_case: CASE,
        p_task: TASK,
        p_now: NOW,
      },
    ]);
  });

  it('addPost sends p_parent (null for a reply to the root)', async () => {
    const { db, s } = store({ bank_ws_post_add: { data: POST } });
    await expect(
      s.addPost({
        threadId: THREAD,
        actor: ACTOR,
        parentPostId: POST,
        body: 'x',
        caseId: CASE,
      })
    ).resolves.toBe(POST);
    await s.addPost({ threadId: THREAD, actor: ACTOR, body: 'y' });
    expect(db.calls.map((c) => c.args)).toEqual([
      {
        p_thread: THREAD,
        p_actor: ACTOR,
        p_parent: POST,
        p_body: 'x',
        p_case: CASE,
        p_task: null,
        p_now: NOW,
      },
      {
        p_thread: THREAD,
        p_actor: ACTOR,
        p_parent: null,
        p_body: 'y',
        p_case: null,
        p_task: null,
        p_now: NOW,
      },
    ]);
  });

  it('retractPost', async () => {
    const { db, s } = store({ bank_ws_post_retract: { data: null } });
    await expect(s.retractPost(POST, ACTOR)).resolves.toBeUndefined();
    expect(db.calls[0]).toEqual({
      fn: 'bank_ws_post_retract',
      args: { p_post: POST, p_actor: ACTOR, p_now: NOW },
    });
  });

  it('markAction sends the due date; NULL is left to the SQL (DUE_REQUIRED)', async () => {
    const { db, s } = store({ bank_ws_action_mark: { data: TASK } });
    await expect(
      s.markAction({
        threadId: THREAD,
        actor: ACTOR,
        ownerId: OWNER,
        dueAt: DUE,
      })
    ).resolves.toBe(TASK);
    await s.markAction({
      threadId: THREAD,
      actor: ACTOR,
      ownerId: OWNER,
      dueAt: null,
    });
    expect(db.calls.map((c) => c.args)).toEqual([
      {
        p_thread: THREAD,
        p_actor: ACTOR,
        p_owner: OWNER,
        p_due_at: DUE.toISOString(),
        p_now: NOW,
      },
      {
        p_thread: THREAD,
        p_actor: ACTOR,
        p_owner: OWNER,
        p_due_at: null,
        p_now: NOW,
      },
    ]);
  });

  it('markAction refuses an invalid Date before any call', async () => {
    const { db, s } = store({});
    await expect(
      s.markAction({
        threadId: THREAD,
        actor: ACTOR,
        ownerId: OWNER,
        dueAt: new Date('x'),
      })
    ).rejects.toMatchObject({
      name: 'BankWorkspaceRefusedError',
      reason: 'DUE_INVALID',
    });
    expect(db.calls).toEqual([]);
  });

  it('a write with no id back is a CaseStoreError', async () => {
    const { s } = store({ bank_ws_create: { data: null } });
    await expect(s.create(ACTOR, ACCOUNT, 'ADCB')).rejects.toBeInstanceOf(
      CaseStoreError
    );
  });
});

describe('BankWorkspaceStore: listings', () => {
  it('list / cases map rows', async () => {
    const { db, s } = store({
      bank_ws_list: {
        data: [
          {
            bank_ws_id: WS,
            account_id: ACCOUNT,
            bank_code: 'ADCB',
            bank_name: 'ADCB Bank',
            access: 'member',
            created_at: NOW,
          },
        ],
      },
      bank_ws_cases: {
        data: [
          {
            case_id: CASE,
            stage: 'Submitted',
            product: null,
            agent_id: ACTOR,
            coordinator_id: null,
            opened_at: NOW,
            closed_at: null,
            contact_id: OWNER,
            contact_name: 'Sara',
            sla_state: 'overdue',
            next_due_at: DUE.toISOString(),
            is_lead: true,
          },
          {
            case_id: TASK,
            stage: 'Approved',
            product: 'Loan',
            agent_id: ACTOR,
            coordinator_id: null,
            opened_at: NOW,
            closed_at: NOW,
            contact_id: null,
            contact_name: null,
            sla_state: null,
            next_due_at: null,
            is_lead: false,
          },
        ],
      },
    });
    expect(await s.list(ACTOR, ACCOUNT)).toEqual([
      {
        bankWsId: WS,
        accountId: ACCOUNT,
        bankCode: 'ADCB',
        bankName: 'ADCB Bank',
        access: 'member',
        createdAt: T0,
      },
    ]);
    expect(await s.cases(WS, ACTOR)).toEqual([
      {
        caseId: CASE,
        stage: 'Submitted',
        product: null,
        agentId: ACTOR,
        coordinatorId: null,
        openedAt: T0,
        closedAt: null,
        contactId: OWNER,
        contactName: 'Sara',
        slaState: 'overdue',
        nextDueAt: DUE,
        isLead: true,
      },
      // The server's order is kept.
      {
        caseId: TASK,
        stage: 'Approved',
        product: 'Loan',
        agentId: ACTOR,
        coordinatorId: null,
        openedAt: T0,
        closedAt: T0,
        contactId: null,
        contactName: null,
        slaState: null,
        nextDueAt: null,
        isLead: false,
      },
    ]);
    expect(db.calls.map((c) => c.args)).toEqual([
      { p_actor: ACTOR, p_account: ACCOUNT },
      { p_bank_ws: WS, p_actor: ACTOR },
    ]);
  });

  it('pins: current hides a cleared (blank) kind; history keeps it', async () => {
    const data = [
      {
        pin_id: 3,
        kind: 'bank_contacts',
        body: '  ',
        author_id: ACTOR,
        created_at: NOW,
      },
      {
        pin_id: 4,
        kind: 'product_rules',
        body: 'rules',
        author_id: ACTOR,
        created_at: NOW,
      },
    ];
    const { db, s } = store({ bank_ws_pins_list: { data } });
    const current = await s.pins(WS, ACTOR);
    expect(current.map((p) => p.pinId)).toEqual(['4']);
    expect(current[0]).toEqual({
      pinId: '4',
      kind: 'product_rules',
      body: 'rules',
      authorId: ACTOR,
      createdAt: T0,
    });
    expect(
      (await s.pins(WS, ACTOR, { history: true })).map((p) => p.pinId)
    ).toEqual(['3', '4']);
    expect(db.calls.map((c) => c.args)).toEqual([
      { p_bank_ws: WS, p_actor: ACTOR, p_history: false },
      { p_bank_ws: WS, p_actor: ACTOR, p_history: true },
    ]);
  });

  it('threads / posts / actions map rows', async () => {
    const { db, s } = store({
      bank_ws_threads_list: {
        data: [
          {
            thread_id: THREAD,
            title: 'T',
            author_id: ACTOR,
            created_at: NOW,
            case_id: CASE,
            task_id: null,
            post_count: 3,
            action_owner_id: OWNER,
            action_due_at: DUE.toISOString(),
            action_task_id: TASK,
          },
        ],
      },
      bank_ws_posts_list: {
        data: [
          {
            post_id: POST,
            parent_post_id: null,
            author_id: ACTOR,
            body: null,
            retracted: true,
            case_id: CASE,
            task_id: null,
            case_readable: false,
            case_stage: null,
            case_product: null,
            created_at: NOW,
          },
        ],
      },
      bank_ws_actions_list: {
        data: [
          {
            action_id: POST,
            thread_id: THREAD,
            owner_id: OWNER,
            due_at: DUE.toISOString(),
            case_id: null,
            task_id: null,
            task_status: null,
            created_by: ACTOR,
            created_at: NOW,
          },
        ],
      },
    });
    expect(await s.threads(WS, ACTOR)).toEqual([
      {
        threadId: THREAD,
        title: 'T',
        authorId: ACTOR,
        createdAt: T0,
        caseId: CASE,
        taskId: null,
        postCount: 3,
        actionOwnerId: OWNER,
        actionDueAt: DUE,
        actionTaskId: TASK,
      },
    ]);
    expect(await s.posts(THREAD, ACTOR)).toEqual([
      {
        postId: POST,
        parentPostId: null,
        authorId: ACTOR,
        body: null,
        retracted: true,
        caseId: CASE,
        taskId: null,
        caseReadable: false,
        caseStage: null,
        caseProduct: null,
        createdAt: T0,
      },
    ]);
    expect(await s.actions(WS, ACTOR)).toEqual([
      {
        actionId: POST,
        threadId: THREAD,
        ownerId: OWNER,
        dueAt: DUE,
        caseId: null,
        taskId: null,
        taskStatus: null,
        createdBy: ACTOR,
        createdAt: T0,
      },
    ]);
    expect(db.calls.map((c) => [c.fn, c.args])).toEqual([
      ['bank_ws_threads_list', { p_bank_ws: WS, p_actor: ACTOR }],
      ['bank_ws_posts_list', { p_thread: THREAD, p_actor: ACTOR }],
      ['bank_ws_actions_list', { p_bank_ws: WS, p_actor: ACTOR }],
    ]);
  });

  it('a non-member gets zero rows: every list is empty, not an error', async () => {
    const empty = { data: [] };
    const { s } = store({
      bank_ws_list: empty,
      bank_ws_cases: empty,
      bank_ws_pins_list: empty,
      bank_ws_threads_list: empty,
      bank_ws_posts_list: { data: null },
      bank_ws_actions_list: empty,
    });
    expect(await s.list(ACTOR, ACCOUNT)).toEqual([]);
    expect(await s.cases(WS, ACTOR)).toEqual([]);
    expect(await s.pins(WS, ACTOR, { history: true })).toEqual([]);
    expect(await s.threads(WS, ACTOR)).toEqual([]);
    expect(await s.posts(THREAD, ACTOR)).toEqual([]);
    expect(await s.actions(WS, ACTOR)).toEqual([]);
  });
});

describe('BankWorkspaceStore: summary (131)', () => {
  it('sends the workspace and actor and maps the jsonb', async () => {
    const { db, s } = store({
      bank_ws_summary: {
        data: {
          open_cases: 4,
          members: { agents: 2, coordinators: 1, team_leads: 1, total: 4 },
          open_actions: 3,
          my_role: 'team_lead',
        },
      },
    });
    expect(await s.summary(WS, ACTOR)).toEqual({
      openCases: 4,
      members: { agents: 2, coordinators: 1, teamLeads: 1, total: 4 },
      openActions: 3,
      myRole: 'team_lead',
    });
    expect(db.calls).toEqual([
      { fn: 'bank_ws_summary', args: { p_bank_ws: WS, p_actor: ACTOR } },
    ]);
  });

  it('SQL NULL (no access) is null; bad keys become defaults', async () => {
    expect(await store({ bank_ws_summary: {} }).s.summary(WS, ACTOR)).toBe(
      null
    );
    expect(
      await store({
        bank_ws_summary: {
          data: { open_cases: 'x', members: null, my_role: 'owner' },
        },
      }).s.summary(WS, ACTOR)
    ).toEqual({
      openCases: 0,
      members: { agents: 0, coordinators: 0, teamLeads: 0, total: 0 },
      openActions: 0,
      myRole: null,
    });
  });
});

describe('BankWorkspaceStore: refusals', () => {
  it.each(BANK_WS_REFUSALS)(
    'hint %s -> BankWorkspaceRefusedError',
    async (hint) => {
      const { s } = store({
        bank_ws_post_add: { error: { message: 'x', code: 'P0001', hint } },
      });
      const err = await s
        .addPost({ threadId: THREAD, actor: ACTOR, body: 'x' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BankWorkspaceRefusedError);
      expect(err.reason).toBe(hint);
    }
  );

  it('a case hint raised underneath (the action task) is a CaseRefusedError', async () => {
    const { s } = store({
      bank_ws_action_mark: {
        error: { message: 'x', code: 'P0001', hint: 'CASE_CLOSED' },
      },
    });
    const err = await s
      .markAction({
        threadId: THREAD,
        actor: ACTOR,
        ownerId: OWNER,
        dueAt: DUE,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CaseRefusedError);
    expect(err.reason).toBe('CASE_CLOSED');
  });

  it('anything else is a CaseStoreError without the database text', async () => {
    const { s } = store({
      bank_ws_threads_list: {
        error: { message: 'secret detail', code: '42501' },
      },
    });
    const err = await s.threads(WS, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(CaseStoreError);
    expect(err).toMatchObject({ fn: 'bank_ws_threads_list', code: '42501' });
    expect(String(err.message)).not.toContain('secret');
  });
});

describe('bank workspace refusals cover migration 126', () => {
  it('every HINT 126 raises is a BankWorkspaceRefusedError reason', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/126_bank_workspaces.sql'),
      'utf8'
    );
    const hints = [...sql.matchAll(/HINT = '([A-Z_]+)'/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThan(10);
    for (const h of hints) expect(BANK_WS_REFUSALS).toContain(h);
  });
});
