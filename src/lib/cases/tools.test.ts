// The case tool stores and the missing-documents request on a fake
// supabase-js client: what each wrapper sends, how hints map, and the
// send-then-mark order. The SQL is 123/124's (verify-case-*.sql).
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
} from '@/lib/submission-groups/service';

import { CaseBankContactsStore } from './bank-contacts';
import { evaluateCaseSla } from './cron';
import {
  draftMissingDocumentsRequest,
  MISSING_DOCUMENTS_TEMPLATE,
  PRIVACY_NOTICE_TEMPLATE,
  requestMissingDocuments,
} from './documents';
import { CaseNotesStore } from './notes';
import { CaseSlaStore } from './sla';
import { CaseRefusedError, CaseStoreError } from './store';
import { CaseToolsStore } from './tools';

type Args = Record<string, unknown>;
type Answer = {
  data?: unknown;
  error?: { message: string; code?: string; hint?: string };
};

class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  readonly log: string[] = [];
  constructor(
    readonly script: Record<string, Answer> = {},
    readonly tables: Record<string, Args[]> = {}
  ) {}
  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    this.log.push(fn);
    const a = this.script[fn];
    if (!a) throw new Error(`unscripted rpc ${fn}`);
    return { data: a.data ?? null, error: a.error ?? null };
  }
  from(table: string) {
    const eqs: [string, unknown][] = [];
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => (eqs.push([k, v]), b),
      order: () => b,
      then: (ok: (v: unknown) => unknown) =>
        ok({
          data: (this.tables[table] ?? []).filter((r) =>
            eqs.every(([k, v]) => r[k] === v)
          ),
          error: null,
        }),
    };
    return b;
  }
  args(fn: string) {
    return this.calls.find((c) => c.fn === fn)?.args;
  }
  get client() {
    return this as unknown as SupabaseClient;
  }
}

const CASE = '11111111-1111-4111-8111-111111111111';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const OWNER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const GROUP = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-19T08:00:00.000Z');
const clock = () => T0;
const refusal = (hint: string): Answer => ({
  error: { message: 'x', code: 'P0001', hint },
});

describe('CaseToolsStore', () => {
  it('createTask sends every argument snake_case, the owner and due included', async () => {
    const db = new FakeDb({ case_task_create: { data: 'task-1' } });
    const id = await new CaseToolsStore(db.client, clock).createTask({
      caseId: CASE,
      actor: ACTOR,
      templateKey: 'collect_docs',
      ownerId: OWNER,
      dueAt: new Date('2026-10-20T00:00:00.000Z'),
    });
    expect(id).toBe('task-1');
    expect(db.args('case_task_create')).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_template_key: 'collect_docs',
      p_owner: OWNER,
      p_due_at: '2026-10-20T00:00:00.000Z',
      p_now: T0.toISOString(),
    });
  });

  it.each([
    'TEMPLATE_NOT_FOUND',
    'OWNER_INVALID',
    'DUE_INVALID',
    'NOT_ALLOWED',
    'CASE_NOT_FOUND',
  ])('the hint %s is a CaseRefusedError', async (hint) => {
    const db = new FakeDb({ case_task_create: refusal(hint) });
    const err = await new CaseToolsStore(db.client)
      .createTask({ caseId: CASE, actor: ACTOR, templateKey: 'k' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseRefusedError);
    expect((err as CaseRefusedError).reason).toBe(hint);
  });

  it('an unknown hint is a CaseStoreError with the function name only', async () => {
    const db = new FakeDb({
      case_task_set_status: { error: { message: 'secret', code: '23505' } },
    });
    const err = await new CaseToolsStore(db.client)
      .setTaskStatus('t', ACTOR, 'done')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStoreError);
    expect((err as CaseStoreError).fn).toBe('case_task_set_status');
    expect(String(err)).not.toContain('secret');
  });

  it('setTaskStatus, overdueTasks, setDocStatus and the config RPCs send their arguments', async () => {
    const db = new FakeDb({
      case_task_set_status: {
        data: [{ changed: true, from_status: 'open', to_status: 'done' }],
      },
      case_task_overdue: {
        data: [
          {
            task_id: 't',
            case_id: CASE,
            title: 'T',
            owner_id: OWNER,
            due_at: '2026-10-18T00:00:00Z',
            status: 'open',
          },
        ],
      },
      case_doc_set_status: { data: 'received' },
      case_task_template_upsert: {
        data: {
          account_id: ACCOUNT,
          bank_code: 'ADCB',
          template_key: 'k',
          title: 'T',
          position: 2,
          due_hours: null,
        },
      },
      case_doc_requirement_delete: { data: true },
    });
    const s = new CaseToolsStore(db.client, clock);
    expect(await s.setTaskStatus('t', ACTOR, 'done')).toEqual({
      changed: true,
      fromStatus: 'open',
      toStatus: 'done',
    });
    expect(db.args('case_task_set_status')).toEqual({
      p_task: 't',
      p_actor: ACTOR,
      p_status: 'done',
      p_now: T0.toISOString(),
    });
    const [o] = await s.overdueTasks(ACTOR, 'acct-1');
    expect(o).toMatchObject({
      taskId: 't',
      dueAt: new Date('2026-10-18T00:00:00Z'),
    });
    expect(db.args('case_task_overdue')).toEqual({
      p_actor: ACTOR,
      p_account: 'acct-1',
      p_now: T0.toISOString(),
    });
    await s.setDocStatus({
      caseId: CASE,
      actor: ACTOR,
      docKey: 'eid',
      status: 'received',
      fileRef: 'f1',
    });
    expect(db.args('case_doc_set_status')).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_doc_key: 'eid',
      p_status: 'received',
      p_file_ref: 'f1',
      p_now: T0.toISOString(),
    });
    expect(
      await s.upsertTaskTemplate(ACTOR, {
        accountId: ACCOUNT,
        bankCode: 'ADCB',
        templateKey: 'k',
        title: 'T',
        position: 2,
      })
    ).toMatchObject({ position: 2, dueHours: null });
    expect(db.args('case_task_template_upsert')).toEqual({
      p_actor: ACTOR,
      p_account: ACCOUNT,
      p_bank_code: 'ADCB',
      p_template_key: 'k',
      p_title: 'T',
      p_position: 2,
      p_due_hours: null,
    });
    expect(
      await s.deleteDocRequirement(ACTOR, ACCOUNT, 'ADCB', 'Loan', 'eid')
    ).toBe(true);
    expect(db.args('case_doc_requirement_delete')).toEqual({
      p_actor: ACTOR,
      p_account: ACCOUNT,
      p_bank_code: 'ADCB',
      p_product: 'Loan',
      p_doc_key: 'eid',
    });
  });

  it('listTasks attaches each task its latest status change', async () => {
    const db = new FakeDb(
      {},
      {
        case_tasks: [
          {
            id: 'a',
            case_id: CASE,
            template_key: 'k',
            title: 'A',
            owner_id: OWNER,
            due_at: null,
            status: 'done',
            created_by: ACTOR,
            created_at: '2026-10-19T00:00:00Z',
            updated_at: '2026-10-19T01:00:00Z',
          },
        ],
        case_task_status_log: [
          {
            id: 1,
            task_id: 'a',
            case_id: CASE,
            from_status: null,
            to_status: 'open',
            actor_id: ACTOR,
            actor_role: 'agent',
            changed_at: '2026-10-19T00:00:00Z',
          },
          {
            id: 2,
            task_id: 'a',
            case_id: CASE,
            from_status: 'open',
            to_status: 'done',
            actor_id: OWNER,
            actor_role: 'coordinator',
            changed_at: '2026-10-19T01:00:00Z',
          },
        ],
      }
    );
    const [t] = await new CaseToolsStore(db.client).listTasks(CASE);
    expect(t.status).toBe('done');
    expect(t.lastChange).toMatchObject({
      fromStatus: 'open',
      toStatus: 'done',
      actorId: OWNER,
    });
  });

  it('checklist matches the product case-insensitively and lists what is missing', async () => {
    const db = new FakeDb(
      {},
      {
        cases: [
          {
            id: CASE,
            account_id: ACCOUNT,
            bank_code: 'ADCB',
            product: ' loan',
          },
        ],
        case_doc_requirements: [
          {
            account_id: ACCOUNT,
            bank_code: 'ADCB',
            product: 'Loan',
            doc_key: 'eid',
            label: 'Emirates ID',
            position: 1,
          },
          {
            account_id: ACCOUNT,
            bank_code: 'ADCB',
            product: 'Loan',
            doc_key: 'stmt',
            label: 'Statements',
            position: 2,
          },
          {
            account_id: ACCOUNT,
            bank_code: 'ADCB',
            product: 'Card',
            doc_key: 'x',
            label: 'X',
            position: 1,
          },
        ],
        case_documents: [
          {
            case_id: CASE,
            doc_key: 'eid',
            status: 'received',
            file_ref: 'f1',
            updated_by: ACTOR,
            updated_at: '2026-10-19T00:00:00Z',
          },
        ],
      }
    );
    const c = await new CaseToolsStore(db.client).checklist(CASE);
    expect(c.items.map((i) => [i.docKey, i.status])).toEqual([
      ['eid', 'received'],
      ['stmt', null],
    ]);
    expect(c.missing).toEqual(['stmt']);
  });
});

describe('notes, bank contacts and SLA', () => {
  it('notes.add sends the body as written and returns mentions and ignored handles', async () => {
    const db = new FakeDb({
      case_note_add: {
        data: [{ note_id: 'n1', mentioned: [OWNER], ignored: ['@bob'] }],
      },
    });
    const r = await new CaseNotesStore(db.client, clock).add(
      CASE,
      ACTOR,
      `hi @${OWNER} @bob`
    );
    expect(r).toEqual({ noteId: 'n1', mentioned: [OWNER], ignored: ['@bob'] });
    expect(db.args('case_note_add')).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_body: `hi @${OWNER} @bob`,
      p_now: T0.toISOString(),
    });
  });

  it.each(['NOTE_EMPTY', 'NOTE_TOO_LONG'])(
    'notes: %s is refused',
    async (hint) => {
      const db = new FakeDb({ case_note_add: refusal(hint) });
      await expect(
        new CaseNotesStore(db.client).add(CASE, ACTOR, ' ')
      ).rejects.toMatchObject({ reason: hint });
    }
  );

  it('bank contact add sends every column; CONTACT_INCOMPLETE is refused', async () => {
    const db = new FakeDb({ case_bank_contact_add: { data: 'b1' } });
    await new CaseBankContactsStore(db.client, clock).add({
      caseId: CASE,
      actor: ACTOR,
      contactName: 'Sara (ADCB)',
      contactedAt: T0,
      summary: 'asked for salary cert',
    });
    expect(db.args('case_bank_contact_add')).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_contact_name: 'Sara (ADCB)',
      p_contacted_at: T0.toISOString(),
      p_summary: 'asked for salary cert',
      p_next_action: null,
      p_next_action_at: null,
      p_now: T0.toISOString(),
    });
    const bad = new FakeDb({
      case_bank_contact_add: refusal('CONTACT_INCOMPLETE'),
    });
    await expect(
      new CaseBankContactsStore(bad.client).add({
        caseId: CASE,
        actor: ACTOR,
        contactName: ' ',
        contactedAt: T0,
        summary: 's',
      })
    ).rejects.toMatchObject({ reason: 'CONTACT_INCOMPLETE' });
  });

  it('SLA timer, event, system event, evaluate and config send their arguments', async () => {
    const db = new FakeDb({
      case_sla_timer: { data: 'on_track' },
      case_sla_event: { data: null },
      case_sla_event_system: { data: 'due_soon' },
      case_sla_evaluate: {
        data: [
          {
            case_id: CASE,
            timer: 'bank_response',
            from_state: 'on_track',
            to_state: 'overdue',
          },
        ],
      },
      case_sla_config_upsert: {
        data: {
          account_id: ACCOUNT,
          bank_code: 'ADCB',
          stage: 'Submitted',
          timer: 'bank_response',
          amount: 2,
          unit: 'days',
          due_soon_pct: 20,
          due_soon_minutes: null,
        },
      },
    });
    const s = new CaseSlaStore(db.client, clock);
    expect(await s.timer(CASE, ACTOR, 'bank_response', 'start')).toBe(
      'on_track'
    );
    expect(db.args('case_sla_timer')).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_timer: 'bank_response',
      p_action: 'start',
      p_now: T0.toISOString(),
    });
    expect(await s.event(CASE, ACTOR, 'bank_response')).toBeNull();
    expect(db.args('case_sla_event')).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_event: 'bank_response',
      p_now: T0.toISOString(),
    });
    expect(await s.customerMessageSystem(CASE)).toBe('due_soon');
    expect(db.args('case_sla_event_system')).toEqual({
      p_case: CASE,
      p_event: 'customer_message',
      p_now: T0.toISOString(),
    });
    const later = new Date('2026-10-21T00:00:00.000Z');
    expect(await evaluateCaseSla({ store: s, now: () => later })).toEqual([
      {
        caseId: CASE,
        timer: 'bank_response',
        fromState: 'on_track',
        toState: 'overdue',
      },
    ]);
    expect(db.args('case_sla_evaluate')).toEqual({
      p_now: later.toISOString(),
      p_case: null,
    });
    await s.upsertConfig(ACTOR, {
      accountId: ACCOUNT,
      bankCode: 'ADCB',
      stage: 'Submitted',
      timer: 'bank_response',
      amount: 2,
      unit: 'days',
    });
    expect(db.args('case_sla_config_upsert')).toEqual({
      p_actor: ACTOR,
      p_account: ACCOUNT,
      p_bank_code: 'ADCB',
      p_stage: 'Submitted',
      p_timer: 'bank_response',
      p_amount: 2,
      p_unit: 'days',
      p_due_soon_pct: 20,
      p_due_soon_minutes: null,
    });
  });

  it.each([
    'SLA_NOT_CONFIGURED',
    'TIMER_INVALID',
    'ACTION_INVALID',
    'NOW_REQUIRED',
  ])('SLA: %s is refused', async (hint) => {
    const db = new FakeDb({ case_sla_timer: refusal(hint) });
    await expect(
      new CaseSlaStore(db.client).timer(CASE, ACTOR, 'bank_response', 'start')
    ).rejects.toMatchObject({ reason: hint });
  });
});

describe('requestMissingDocuments', () => {
  const BEGIN = {
    account_id: ACCOUNT,
    group_id: GROUP,
    submission_ref: 'S-1',
    bank_name: 'Bank One',
    doc_keys: ['eid', 'stmt'],
    doc_labels: ['Emirates ID', 'Bank statements (6 months)'],
  };
  const setup = (
    send: (i: {
      groupId: string;
      userId: string;
      text: string;
    }) => Promise<unknown>,
    begin = BEGIN
  ) => {
    const db = new FakeDb({
      case_doc_request_begin: { data: [begin] },
      case_doc_mark_requested: { data: 2 },
    });
    const texts: string[] = [];
    const sender = {
      sendFromCrm: async (i: {
        groupId: string;
        userId: string;
        text: string;
      }) => {
        db.log.push('send');
        texts.push(i.text);
        expect(i).toMatchObject({ groupId: GROUP, userId: ACTOR });
        return send(i) as ReturnType<
          import('@/lib/submission-groups/service').SubmissionGroupService['sendFromCrm']
        >;
      },
    };
    const tools = new CaseToolsStore(db.client, clock);
    const run = () =>
      requestMissingDocuments(
        { tools, sender },
        { caseId: CASE, actor: ACTOR }
      );
    return { db, texts, run };
  };
  const ok = async () => ({
    messageId: 'm1',
    prefixedBody: 'Ali (Agent): x',
    waMessageId: 'w1',
  });

  it('sends one message naming the bank and every missing label, then marks them requested', async () => {
    const s = setup(ok);
    const r = await s.run();
    expect(r).toMatchObject({
      sent: true,
      docKeys: ['eid', 'stmt'],
      messageId: 'm1',
      recorded: true,
      marked: 2,
    });
    expect(s.texts).toEqual([
      'To continue your Bank One application we still need the following documents: Emirates ID, Bank statements (6 months). Please share them in this chat.',
    ]);
    expect(s.db.log).toEqual([
      'case_doc_request_begin',
      'send',
      'case_doc_mark_requested',
    ]);
    expect(s.db.args('case_doc_mark_requested')).toEqual({
      p_case: CASE,
      p_actor: ACTOR,
      p_doc_keys: ['eid', 'stmt'],
      p_now: T0.toISOString(),
    });
  });

  it.each([
    ['BLOCKED', new SubmissionGroupSendBlockedError('opted_out')],
    ['REFUSED', new SubmissionGroupSendRefusedError('SEND_NOT_ALLOWED')],
    ['SEND_FAILED', new Error('gateway down')],
  ])('%s: marks nothing', async (reason, err) => {
    const s = setup(async () => {
      throw err;
    });
    expect(await s.run()).toMatchObject({ sent: false, reason });
    expect(s.db.log).not.toContain('case_doc_mark_requested');
  });

  it('sent but not recorded counts as sent: the documents are marked', async () => {
    const s = setup(async () => {
      throw new SubmissionGroupSentNotRecordedError('m2', 'w2', new Error('x'));
    });
    expect(await s.run()).toMatchObject({
      sent: true,
      messageId: 'm2',
      waMessageId: 'w2',
      recorded: false,
      marked: 2,
    });
    expect(s.db.log).toContain('case_doc_mark_requested');
  });

  it('nothing missing: sends nothing', async () => {
    const s = setup(ok, { ...BEGIN, doc_keys: [], doc_labels: [] });
    expect(await s.run()).toEqual({ sent: false, reason: 'NOTHING_MISSING' });
    expect(s.texts).toEqual([]);
  });

  it('a refused begin throws before any send', async () => {
    const db = new FakeDb({ case_doc_request_begin: refusal('NOT_ALLOWED') });
    let sends = 0;
    const sender = {
      sendFromCrm: async () => {
        sends++;
        return { messageId: '', prefixedBody: '', waMessageId: '' };
      },
    };
    await expect(
      requestMissingDocuments(
        { tools: new CaseToolsStore(db.client), sender },
        { caseId: CASE, actor: ACTOR }
      )
    ).rejects.toBeInstanceOf(CaseRefusedError);
    expect(sends).toBe(0);
  });

  it('the draft inserts the bank and labels literally; the privacy notice awaits legal review', () => {
    const text = draftMissingDocumentsRequest('Bank $& One', ['US$$', "c$'d"]);
    expect(text).toContain('Bank $& One application');
    expect(text).toContain("US$$, c$'d.");
    expect(MISSING_DOCUMENTS_TEMPLATE.status).toBe('IN_USE');
    expect(PRIVACY_NOTICE_TEMPLATE.status).toBe('PENDING_LEGAL_REVIEW');
    expect(PRIVACY_NOTICE_TEMPLATE.text).toMatch(/PENDING LEGAL REVIEW/);
  });
});
