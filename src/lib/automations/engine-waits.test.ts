import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs that wait, against a small in-memory database: what a wait holds
// back, where a parked run continues, and what it must never repeat.

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  /** Tables whose reads fail. */
  unreadable: new Set<string>(),
  sent: [] as string[],
}));

vi.mock('./admin-client', () => {
  function builder(table: string) {
    let type = 'select';
    let payload: Row = {};
    const tests: ((r: Row) => boolean)[] = [];
    const run = (many: boolean) => {
      const rows = (h.db[table] ??= []);
      if (type === 'select' && h.unreadable.has(table))
        return { data: null, error: { message: 'fetch failed' } };
      if (type === 'insert') {
        const row = { id: `${table}-${rows.length + 1}`, ...payload };
        rows.push(row);
        return { data: row, error: null };
      }
      const hit = rows.filter((r) => tests.every((t) => t(r)));
      if (type === 'update') hit.forEach((r) => Object.assign(r, payload));
      if (table === 'automation_steps')
        hit.sort((x, y) => Number(x.position) - Number(y.position));
      return { data: many ? [...hit] : (hit[0] ?? null), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row) => ((type = 'insert'), (payload = p), b),
      update: (p: Row) => ((type = 'update'), (payload = p), b),
      eq: (k: string, v: unknown) => (tests.push((r) => r[k] === v), b),
      is: (k: string, v: unknown) => (
        tests.push((r) => (r[k] ?? null) === v),
        b
      ),
      lt: (k: string, v: string) => (
        tests.push((r) => r[k] != null && String(r[k]) < v),
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
  engineSendText: async ({ text }: { text: string }) => {
    h.sent.push(text);
    return { whatsapp_message_id: 'm1' };
  },
  engineSendTemplate: vi.fn(),
  engineSendInteractive: vi.fn(),
}));

import { resumePendingExecution, runAutomationsForTrigger } from './engine';

type Pending = Parameters<typeof resumePendingExecution>[0];
const pendings = () => h.db.automation_pending_executions as Row[];
const log = () =>
  h.db.automation_logs[0] as {
    status: string;
    error_message?: string | null;
    steps_executed: Row[];
  };

function step(
  id: string,
  step_type: string,
  position: number,
  parent: string | null = null,
  branch: string | null = null
) {
  const config: Record<string, Row> = {
    send_message: { text: id },
    wait: { amount: 1, unit: 'hours' },
    condition: { subject: 'message_content', value: 'hi' },
  };
  const row = {
    id,
    automation_id: 'a1',
    parent_step_id: parent,
    branch,
    position,
    step_type,
    step_config: config[step_type],
  };
  h.db.automation_steps.push(row);
  return row;
}

/** C1 [ before, C2 [ W, inner ], middle ], after */
function nested() {
  step('C1', 'condition', 0);
  step('before', 'send_message', 0, 'C1', 'yes');
  step('C2', 'condition', 1, 'C1', 'yes');
  step('W', 'wait', 0, 'C2', 'yes');
  step('inner', 'send_message', 1, 'C2', 'yes');
  step('middle', 'send_message', 2, 'C1', 'yes');
  step('other branch', 'send_message', 0, 'C1', 'no');
  step('after', 'send_message', 1);
}

const fire = () =>
  runAutomationsForTrigger({
    accountId: 'acct-1',
    triggerType: 'new_message_received',
    contactId: 'c1',
    context: { message_text: 'hi' },
  });

/** What the cron does with the newest parked row: claim, resume. */
function resume() {
  const row = pendings().findLast((r) => r.status === 'pending')!;
  row.status = 'running';
  return resumePendingExecution({ ...row } as unknown as Pending);
}

/** A row of the build before 269. */
function parkOld(extra: Row) {
  h.db.automation_logs = [{ id: 'l1', status: 'partial', steps_executed: [] }];
  pendings().push({
    id: 'old',
    automation_id: 'a1',
    account_id: 'acct-1',
    user_id: 'u1',
    contact_id: 'c1',
    log_id: 'l1',
    parent_step_id: null,
    branch: null,
    next_step_position: 1,
    context: { message_text: 'hi' },
    status: 'pending',
    ...extra,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.unreadable.clear();
  h.sent = [];
  h.db = {
    contacts: [{ id: 'c1', account_id: 'acct-1', opted_out_at: null }],
    conversations: [{ id: 'cv', account_id: 'acct-1', contact_id: 'c1' }],
    automations: [
      {
        id: 'a1',
        account_id: 'acct-1',
        user_id: 'u1',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ],
    automation_steps: [],
    automation_logs: [],
    automation_pending_executions: [],
  };
});

afterEach(() => vi.restoreAllMocks());

describe('a wait inside a condition branch', () => {
  it('suspends the whole run, at any depth', async () => {
    nested();
    await fire();
    expect(h.sent).toEqual(['before']);
    expect(pendings()).toHaveLength(1);
    expect(pendings()[0]).toMatchObject({ wait_step_id: 'W', branch: 'yes' });
    expect(log().status).toBe('partial');
  });

  it('then runs the rest of each list outwards, once', async () => {
    nested();
    await fire();
    await resume();
    expect(h.sent).toEqual(['before', 'inner', 'middle', 'after']);
    expect(pendings()[0].status).toBe('done');
    expect(log().status).toBe('success');
  });

  it('a second wait in the parent list parks the run again', async () => {
    nested();
    step('W2', 'wait', 3, 'C1', 'yes');
    await fire();
    await resume();
    expect(h.sent).toEqual(['before', 'inner', 'middle']);
    expect(log().status).toBe('partial');
    await resume();
    expect(h.sent).toEqual(['before', 'inner', 'middle', 'after']);
    expect(log().status).toBe('success');
  });

  it('a step that fails in a branch fails the run', async () => {
    step('C1', 'condition', 0);
    step('bad', 'send_message', 0, 'C1', 'yes').step_config = { text: '' };
    step('after', 'send_message', 1);
    await fire();
    expect(h.sent).toEqual([]);
    expect(log().status).toBe('failed');
  });
});

describe('a row parked before 269', () => {
  it('finishes its own branch only: the rest already ran', async () => {
    nested();
    parkOld({ parent_step_id: 'C2', branch: 'yes' });
    await resume();
    expect(h.sent).toEqual(['inner']);
    expect(pendings()[0].status).toBe('done');
  });

  it('at the root continues at its position', async () => {
    step('first', 'send_message', 0);
    step('second', 'send_message', 1);
    parkOld({});
    await resume();
    expect(h.sent).toEqual(['second']);
  });

  it('whose condition is gone never resumes at the root', async () => {
    step('first', 'send_message', 0);
    step('second', 'send_message', 1);
    parkOld({ parent_step_id: null, branch: 'yes', next_step_position: 0 });
    await resume();
    expect(h.sent).toEqual([]);
    expect(pendings()[0].status).toBe('failed');
    expect(log()).toMatchObject({
      status: 'failed',
      error_message: 'stopped: automation changed while waiting',
    });
  });
});

describe('an automation edited while a run waits', () => {
  beforeEach(async () => {
    step('one', 'send_message', 0);
    step('W', 'wait', 1);
    step('two', 'send_message', 2);
    await fire();
    expect(h.sent).toEqual(['one']);
  });
  const row = (id: string) => h.db.automation_steps.find((s) => s.id === id)!;

  it('ends the run when its wait is gone', async () => {
    h.db.automation_steps = h.db.automation_steps.filter((s) => s.id !== 'W');
    await resume();
    expect(h.sent).toEqual(['one']);
    expect(pendings()[0].status).toBe('failed');
    expect(log().error_message).toBe(
      'stopped: automation changed while waiting'
    );
  });

  it('follows the wait to its new position', async () => {
    step('new first', 'send_message', 0);
    row('one').position = 1;
    row('W').position = 2;
    row('two').position = 3;
    await resume();
    expect(h.sent).toEqual(['one', 'two']);
  });

  it('never repeats a step when the wait was moved above it', async () => {
    row('W').position = 0;
    row('one').position = 1;
    await resume();
    expect(h.sent).toEqual(['one', 'two']);
  });
});
