import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine's refusals, against a small in-memory database: a parked
// wait of a switched-off automation, a message to a contact who opted
// out, the time-of-day zone, and a write the database refused.

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  /** `<table>.<insert|update|upsert|select:<columns>>` to refuse. */
  refuse: new Set<string>(),
  writes: [] as { table: string; type: string; payload: unknown }[],
  text: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  template: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  interactive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}));

const RAW = 'violates row-level security policy for table "secret"';

vi.mock('./admin-client', () => {
  function builder(table: string) {
    let type = 'select';
    let columns = '*';
    let payload: Row = {};
    const tests: ((r: Row) => boolean)[] = [];
    const run = (many: boolean) => {
      const op = type === 'select' ? `select:${columns}` : type;
      if (h.refuse.has(`${table}.${op}`))
        return { data: null, error: { code: '42501', message: RAW } };
      const rows = (h.db[table] ??= []);
      if (type === 'insert' || type === 'upsert') {
        const row = { id: `${table}-${rows.length + 1}`, ...payload };
        rows.push(row);
        h.writes.push({ table, type, payload });
        return { data: row, error: null };
      }
      const hit = rows.filter((r) => tests.every((t) => t(r)));
      if (type === 'update') {
        hit.forEach((r) => Object.assign(r, payload));
        h.writes.push({ table, type, payload });
      }
      return { data: many ? hit : (hit[0] ?? null), error: null };
    };
    const b: Record<string, unknown> = {
      select: (c = '*') => (type === 'select' && (columns = c), b),
      insert: (p: Row) => ((type = 'insert'), (payload = p), b),
      update: (p: Row) => ((type = 'update'), (payload = p), b),
      upsert: (p: Row) => ((type = 'upsert'), (payload = p), b),
      eq: (k: string, v: unknown) => (tests.push((r) => r[k] === v), b),
      is: (k: string, v: unknown) => (
        tests.push((r) => (r[k] ?? null) === v),
        b
      ),
      gte: (k: string, v: number) => (tests.push((r) => Number(r[k]) >= v), b),
      order: () => b,
      limit: () => b,
      single: async () => run(false),
      maybeSingle: async () => run(false),
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve(run(true)).then(ok),
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: builder,
      rpc: async () => ({ data: null, error: null }),
    }),
  };
});

vi.mock('./channel-send', () => ({
  engineSendText: h.text,
  engineSendTemplate: h.template,
  engineSendInteractive: h.interactive,
}));

import { resumePendingExecution, runAutomationsForTrigger } from './engine';
import type { AutomationTriggerType } from '@/types';

const ACCOUNT = 'acct-1';
const sends = () =>
  h.text.mock.calls.length +
  h.template.mock.calls.length +
  h.interactive.mock.calls.length;
const log = () =>
  h.db.automation_logs[0] as {
    status: string;
    error_message?: string | null;
    steps_executed: { step_type: string; status: string; detail?: string }[];
  };
const contact = () => h.db.contacts[0] as Row;

const TEXT = ['send_message', { text: 'hello' }] as const;
const CLOSE = ['close_conversation', {}] as const;
const BUTTONS = [
  'send_buttons',
  { kind: 'buttons', body: 'Pick', buttons: [{ id: 'a', title: 'A' }] },
] as const;
const LIST = [
  'send_list',
  {
    kind: 'list',
    body: 'Pick',
    button_label: 'Open',
    sections: [{ title: 'S', rows: [{ id: 'a', title: 'A' }] }],
  },
] as const;
const TEMPLATE = ['send_template', { template_name: 'offer' }] as const;

function steps(...list: (readonly [string, Row])[]) {
  h.db.automation_steps = list.map(([step_type, step_config], position) => ({
    id: `s${position}`,
    automation_id: 'a1',
    parent_step_id: null,
    position,
    step_type,
    step_config,
  }));
}

function trigger(type: AutomationTriggerType, extra: Row = {}) {
  h.db.automations[0].trigger_type = type;
  return runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType: type,
    contactId: 'c1',
    context: { message_text: 'hi', chat_tag_id: 'tag-1' },
    ...extra,
  });
}

function resume() {
  return resumePendingExecution({
    id: 'p1',
    automation_id: 'a1',
    user_id: 'u1',
    account_id: ACCOUNT,
    contact_id: 'c1',
    log_id: 'log-1',
    parent_step_id: null,
    branch: null,
    next_step_position: 0,
    context: { message_text: 'hi' },
  });
}

/** The state the cron leaves: a claimed row and the log's "waiting". */
function park() {
  h.db.automation_pending_executions = [{ id: 'p1', status: 'running' }];
  h.db.automation_logs = [
    {
      id: 'log-1',
      status: 'partial',
      steps_executed: [
        { step_type: 'wait', status: 'success', detail: 'waiting 3 days' },
      ],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.refuse.clear();
  h.writes = [];
  h.db = {
    contacts: [{ id: 'c1', account_id: ACCOUNT, opted_out_at: null }],
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, contact_id: 'c1' }],
    accounts: [{ id: ACCOUNT, default_currency: 'AED' }],
    custom_fields: [{ id: 'f1', account_id: ACCOUNT }],
    automations: [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        trigger_type: 'new_message_received',
        trigger_config: { keywords: ['hi'], chat_tag_id: 'tag-1' },
        is_active: true,
      },
    ],
    automation_steps: [],
    automation_logs: [],
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a parked wait', () => {
  beforeEach(() => {
    park();
    steps(TEXT, CLOSE);
  });

  it('runs nothing once the automation is switched off, and says so', async () => {
    h.db.automations[0].is_active = false;
    await resume();
    expect(sends()).toBe(0);
    expect(h.db.conversations[0].status).toBeUndefined();
    // Statuses migration 006's CHECKs allow.
    expect(h.db.automation_pending_executions[0].status).toBe('failed');
    expect(log().status).toBe('partial');
    expect(log().error_message).toBe(
      'stopped: the automation was switched off'
    );
    expect(log().steps_executed).toHaveLength(1);
  });

  it('runs nothing once the automation is deleted', async () => {
    h.db.automations = [];
    await resume();
    expect(sends()).toBe(0);
    expect(h.db.automation_pending_executions[0].status).toBe('failed');
    expect(log().error_message).toBe(
      'stopped: the automation was switched off'
    );
  });

  it('does not blame the switch when the automation could not be read', async () => {
    h.refuse.add('automations.select:*');
    await resume();
    expect(sends()).toBe(0);
    // Nothing was sent: the next tick tries again (269).
    expect(h.db.automation_pending_executions[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      claimed_at: null,
    });
    expect(log()).toMatchObject({ status: 'partial' });
    expect(log().error_message).toBeUndefined();
  });

  it('still resumes while the automation is on', async () => {
    await resume();
    expect(sends()).toBe(1);
    expect(h.db.automation_pending_executions[0].status).toBe('done');
    expect(log().status).toBe('success');
  });
});

describe('a contact who opted out', () => {
  beforeEach(() => {
    contact().opted_out_at = '2026-11-01T00:00:00Z';
  });

  it.each([
    ['send_message', TEXT],
    ['send_template', TEMPLATE],
    ['send_buttons', BUTTONS],
    ['send_list', LIST],
  ])('%s is skipped after a tag, and the rest runs', async (type, step) => {
    steps(step, CLOSE);
    await trigger('chat_tag_set');
    expect(sends()).toBe(0);
    expect(log().steps_executed.map((s) => [s.step_type, s.status])).toEqual([
      [type, 'skipped'],
      ['close_conversation', 'success'],
    ]);
    expect(log().steps_executed[0].detail).toBe(
      'skipped: the customer opted out'
    );
    expect(h.db.conversations[0].status).toBe('closed');
    expect(log().status).toBe('success');
  });

  it('is sent nothing by a resumed wait, which is never a direct answer', async () => {
    park();
    steps(TEXT);
    await resume();
    expect(sends()).toBe(0);
    expect(log().steps_executed.at(-1)?.detail).toBe(
      'skipped: the customer opted out'
    );
  });

  it('is sent nothing by an inbound trigger posted by hand', async () => {
    steps(TEXT);
    await trigger('new_message_received', {
      // The manual route's body: the context cannot claim an inbound.
      context: { message_text: 'hi', customerJustWrote: true },
    });
    expect(sends()).toBe(0);
  });

  it('is sent nothing by a message inside a condition branch', async () => {
    steps(['condition', { subject: 'message_content', value: 'hi' }]);
    h.db.automation_steps.push({
      id: 'child',
      automation_id: 'a1',
      parent_step_id: 's0',
      branch: 'yes',
      position: 0,
      step_type: 'send_message',
      step_config: { text: 'hello' },
    });
    await trigger('chat_tag_set');
    expect(sends()).toBe(0);
    await trigger('keyword_match', { customerJustWrote: true });
    expect(sends()).toBe(1);
  });

  it.each(['keyword_match', 'new_message_received'] as const)(
    'is answered by %s, because they just wrote',
    async (type) => {
      steps(TEXT);
      await trigger(type, { customerJustWrote: true });
      expect(sends()).toBe(1);
    }
  );

  it('is not messaged when the flag cannot be read', async () => {
    contact().opted_out_at = null;
    h.refuse.add('contacts.select:opted_out_at');
    steps(TEXT, CLOSE);
    await trigger('chat_tag_set');
    expect(sends()).toBe(0);
    expect(log().steps_executed[0]).toMatchObject({ status: 'skipped' });
    expect(JSON.stringify(log())).not.toContain('secret');
    expect(h.db.conversations[0].status).toBe('closed');
  });

  it('control: a contact who did not opt out is messaged as before', async () => {
    contact().opted_out_at = null;
    steps(TEXT);
    await trigger('chat_tag_set');
    expect(sends()).toBe(1);
  });
});

describe('time_of_day', () => {
  it.each([
    ['2026-01-15T05:30:00Z', '09:00-18:00', 'yes'], // 09:30 in Dubai
    ['2026-01-15T14:30:00Z', '09:00-18:00', 'no'], // 18:30 in Dubai
    ['2026-01-15T15:00:00Z', '18:00-09:00', 'yes'], // 19:00 in Dubai
    ['2026-01-15T05:30:00Z', '18:00-09:00', 'no'],
  ])('%s in %s: %s', async (now, operand, branch) => {
    vi.stubEnv('TZ', 'UTC');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
    steps(['condition', { subject: 'time_of_day', operand }]);
    await trigger('new_message_received');
    expect(log().steps_executed[0].detail).toBe(`branch=${branch}`);
  });
});

describe('a write the database refuses fails its step', () => {
  it.each([
    [
      'deals.insert',
      'create_deal',
      { pipeline_id: 'p', stage_id: 's', title: 'x' },
    ],
    [
      'contacts.update',
      'update_contact_field',
      { field: 'company', value: 'x' },
    ],
    [
      'contact_custom_values.upsert',
      'update_contact_field',
      { field: 'custom:f1', value: 'x' },
    ],
    [
      'custom_fields.select:id',
      'update_contact_field',
      { field: 'custom:f1', value: 'x' },
    ],
    [
      'conversations.update',
      'assign_conversation',
      { mode: 'specific', agent_id: 'u2' },
    ],
    ['conversations.update', 'close_conversation', {}],
    [
      'automation_pending_executions.insert',
      'wait',
      { amount: 3, unit: 'days' },
    ],
  ])('%s: %s', async (refused, type, config) => {
    h.refuse.add(refused);
    steps([type, config], TEXT);
    await trigger('new_message_received', { customerJustWrote: true });
    // Failed, and the run stops there as it does for any failed step.
    expect(log().status).toBe('failed');
    expect(log().steps_executed).toHaveLength(1);
    expect(log().steps_executed[0]).toMatchObject({
      step_type: type,
      status: 'failed',
    });
    expect(log().error_message).toBe(log().steps_executed[0].detail);
    expect(log().error_message).toContain(`${type}: `);
    expect(JSON.stringify(log())).not.toContain('waiting');
    expect(JSON.stringify(log())).not.toContain('secret');
    expect(sends()).toBe(0);
  });

  it('control: a saved wait parks the run and says so', async () => {
    steps(['wait', { amount: 3, unit: 'days' }], TEXT);
    await trigger('new_message_received', { customerJustWrote: true });
    expect(log().status).toBe('partial');
    expect(log().steps_executed[0].detail).toBe('waiting 3 days');
    expect(h.db.automation_pending_executions[0]).toMatchObject({
      status: 'pending',
      next_step_position: 1,
    });
    // A parked run carries no claim that the customer just wrote.
    expect(JSON.stringify(h.db.automation_pending_executions)).not.toContain(
      'customerJustWrote'
    );
    expect(sends()).toBe(0);
  });
});

describe('a chat that is not a sales chat', () => {
  const chat = (notSales: string | null, error: string | null = null) =>
    vi.fn(async () => ({ personal: false, notSales, error }));

  it.each([
    ['send_message', TEXT],
    ['send_buttons', BUTTONS],
    ['send_list', LIST],
    ['send_template', TEMPLATE],
  ])('%s is skipped and the rest runs', async (type, step) => {
    steps(step, CLOSE);
    await trigger('new_message_received', {
      customerJustWrote: true,
      salesChat: chat('This is an HR chat.'),
    });
    expect(sends()).toBe(0);
    expect(log().steps_executed.map((s) => [s.step_type, s.status])).toEqual([
      [type, 'skipped'],
      ['close_conversation', 'success'],
    ]);
    expect(log().steps_executed[0].detail).toBe('skipped: This is an HR chat.');
    expect(h.db.conversations[0].status).toBe('closed');
  });

  it('a check that could not be read skips the message step', async () => {
    steps(TEXT);
    await trigger('first_inbound_message', {
      customerJustWrote: true,
      salesChat: chat(null, 'boom'),
    });
    expect(sends()).toBe(0);
  });

  it('a sales chat is answered, and internal steps ask nothing', async () => {
    const salesChat = chat(null);
    steps(CLOSE);
    await trigger('new_message_received', { salesChat });
    expect(salesChat).not.toHaveBeenCalled();
    steps(TEXT);
    await trigger('new_message_received', {
      customerJustWrote: true,
      salesChat,
    });
    expect(sends()).toBe(1);
  });

  it('a wait keeps the answer for the resumed run', async () => {
    steps(['wait', { amount: 1, unit: 'hours' }], TEXT);
    await trigger('new_message_received', {
      customerJustWrote: true,
      salesChat: chat('This is an HR chat.'),
    });
    const parked = h.db.automation_pending_executions.at(-1) as {
      context: Record<string, unknown>;
    };
    expect(parked.context.sales_answers_off).toBe('This is an HR chat.');

    steps(TEXT);
    park();
    await resumePendingExecution({
      id: 'p1',
      automation_id: 'a1',
      user_id: 'u1',
      account_id: ACCOUNT,
      contact_id: 'c1',
      log_id: 'log-1',
      parent_step_id: null,
      branch: null,
      next_step_position: 0,
      context: parked.context,
    });
    expect(sends()).toBe(0);
  });
});
