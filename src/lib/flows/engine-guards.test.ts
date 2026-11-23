import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// The runner against a small stateful database: filters are applied, so
// a conditional update that should lose really changes nothing.

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  fail: new Set<string>(),
  sends: [] as { kind: string; text: string }[],
  sendError: null as Error | null,
  onSend: null as null | (() => void),
  notify: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
}));

vi.mock('./admin-client', () => {
  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    const run = () => {
      if (h.fail.has(`${table}.${op}`)) {
        return { data: null, error: { message: 'boom' }, count: null };
      }
      const rows = (h.db[table] ??= []);
      if (op === 'insert') {
        const row = {
          id: `${table}-${rows.length + 1}`,
          vars: {},
          reprompt_count: 0,
          last_advanced_at: new Date().toISOString(),
          ...patch,
        };
        rows.push(row);
        return { data: [{ ...row }], error: null, count: 1 };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') hit.forEach((r) => Object.assign(r, patch));
      return {
        data: hit.map((r) => ({ ...r })),
        error: null,
        count: hit.length,
      };
    };
    const b: Row = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      is: (c: string, v: unknown) => (
        filters.push((r) => (r[c] ?? null) === v),
        b
      ),
      in: (c: string, v: unknown[]) => (
        filters.push((r) => v.includes(r[c])),
        b
      ),
      filter: (_c: string, _o: string, v: unknown) => (
        filters.push((r) => (r.payload as Row)?.meta_message_id === v),
        b
      ),
      update: (row: Row) => ((op = 'update'), (patch = row), b),
      insert: (row: Row) => ((op = 'insert'), (patch = row), b),
      maybeSingle: async () => {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (ok: (r: unknown) => unknown, no: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(ok, no),
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({ from, rpc: async () => ({ error: null }) }),
  };
});

vi.mock('./channel-send', () => {
  const send = (kind: string) => async (a: Row) => {
    if (h.sendError) throw h.sendError;
    h.onSend?.();
    h.sends.push({ kind, text: String(a.bodyText ?? a.text) });
    return { whatsapp_message_id: `wamid.${h.sends.length}` };
  };
  return {
    engineSendText: send('text'),
    engineSendMedia: send('media'),
    engineSendInteractiveButtons: send('buttons'),
    engineSendInteractiveList: send('list'),
  };
});
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => 'skipped'),
  notifyHandoff: (...a: unknown[]) => h.notify(...a),
}));

import { dispatchInboundToFlows } from './engine';

const node = (node_key: string, node_type: string, config: Row) => ({
  flow_id: 'f1',
  node_key,
  node_type,
  config,
});
const menu = (key: string, reply: string, next: string) =>
  node(key, 'send_buttons', {
    text: key,
    buttons: [{ reply_id: reply, title: reply, next_node_key: next }],
  });

const run = () => h.db.flow_runs[0];
const conv = () => h.db.conversations[0];
let mid = 0;
const send = (
  message: { text: string } | { tap: string },
  conversationId = 'cv1'
) =>
  dispatchInboundToFlows({
    accountId: 'a1',
    userId: 'u1',
    contactId: 'c1',
    conversationId,
    isFirstInboundMessage: false,
    message:
      'tap' in message
        ? {
            kind: 'interactive_reply',
            reply_id: message.tap,
            reply_title: message.tap,
            meta_message_id: `m${++mid}`,
          }
        : { kind: 'text', text: message.text, meta_message_id: `m${++mid}` },
  });

const OLD = '2026-01-01T00:00:00.000Z';
function activeRun(current_node_key: string | null, last_advanced_at = OLD) {
  h.db.flow_runs = [
    {
      id: 'r1',
      flow_id: 'f1',
      account_id: 'a1',
      user_id: 'u1',
      contact_id: 'c1',
      conversation_id: 'cv1',
      status: 'active',
      current_node_key,
      last_advanced_at,
      vars: { kept: 'yes' },
      reprompt_count: 0,
    },
  ];
}

beforeEach(() => {
  h.fail.clear();
  h.sends = [];
  h.sendError = null;
  h.onSend = null;
  h.notify = vi.fn(async () => undefined);
  h.db = {
    flow_runs: [],
    flow_run_events: [],
    messages: [],
    contacts: [{ id: 'c1', account_id: 'a1' }],
    conversations: [{ id: 'cv1', assigned_agent_id: null, status: 'open' }],
    profiles: [
      { user_id: 'u2', account_id: 'a1', account_role: 'agent' },
      {
        user_id: 'gone',
        account_id: 'a1',
        account_role: 'agent',
        deactivated_at: OLD,
      },
    ],
    flows: [
      {
        id: 'f1',
        account_id: 'a1',
        user_id: 'u1',
        name: 'F',
        status: 'active',
        trigger_type: 'keyword',
        trigger_config: { keywords: ['menu'] },
        entry_node_id: 'start',
      },
    ],
    flow_nodes: [
      node('start', 'start', { next_node_key: 'one' }),
      menu('one', 'go', 'two'),
      menu('two', 'finish', 'end'),
      node('name', 'collect_input', {
        prompt_text: 'name?',
        var_key: 'name',
        next_node_key: 'two',
      }),
      node('hand', 'handoff', { assign_to: 'u2' }),
      node('end', 'end', {}),
    ],
  };
});

describe('a menu that cannot be sent', () => {
  it.each(['send_buttons', 'send_list'])('%s ends the run', async (type) => {
    h.db.flow_nodes[1] = node('one', type, {
      text: 'x',
      buttons: [],
      sections: [],
    });
    h.sendError = new Error('gateway down');
    expect(await send({ text: 'menu' })).toMatchObject({
      consumed: false,
      outcome: 'failed',
    });
    expect(run()).toMatchObject({
      status: 'failed',
      end_reason: 'send_interactive_failed',
    });
  });

  it('a run stuck on a node that asks nothing hands the message back', async () => {
    activeRun('start');
    expect(await send({ text: 'hello' })).toMatchObject({ consumed: false });
    expect(run()).toMatchObject({
      status: 'failed',
      end_reason: 'current_node_not_waiting',
    });
  });

  it('a failed send after a claim is never re-sent', async () => {
    activeRun('one');
    h.sendError = new Error('gateway down');
    expect(await send({ tap: 'go' })).toMatchObject({ consumed: false });
    expect(run().status).toBe('failed');
    h.sendError = null;
    await send({ tap: 'go' });
    expect(h.sends).toEqual([]);
  });
});

describe('a flow switched off', () => {
  it('ends its run and lets the message start another flow', async () => {
    activeRun('one');
    h.db.flows[0].status = 'draft';
    h.db.flows.push({ ...h.db.flows[0], id: 'f2', status: 'active' });
    h.db.flow_nodes.push({ ...menu('start', 'x', 'end'), flow_id: 'f2' });
    const res = await send({ text: 'menu' });
    expect(run()).toMatchObject({
      status: 'failed',
      end_reason: 'flow_switched_off',
    });
    expect(res).toMatchObject({ consumed: true, outcome: 'started' });
    expect(h.db.flow_runs[1].flow_id).toBe('f2');
  });
});

describe('two quick messages', () => {
  it('send the next step once', async () => {
    activeRun('one');
    const res = await Promise.all([send({ tap: 'go' }), send({ tap: 'go' })]);
    expect(res.map((r) => r.consumed)).toEqual([true, true]);
    expect(h.sends).toEqual([{ kind: 'buttons', text: 'two' }]);
    expect(run()).toMatchObject({ status: 'active', current_node_key: 'two' });
    await send({ tap: 'finish' });
    expect(run().status).toBe('completed');
  });

  it('a message during the walk sends nothing and ends nothing', async () => {
    activeRun(null, new Date().toISOString());
    expect(await send({ text: 'hello' })).toMatchObject({ consumed: true });
    expect(h.sends).toEqual([]);
    expect(run().status).toBe('active');
  });

  it('a walk that died is ended and the message handed back', async () => {
    activeRun(null);
    expect(await send({ text: 'hello' })).toMatchObject({ consumed: false });
    expect(run().status).toBe('failed');
  });

  it('collect_input stores the winner only, with the claim', async () => {
    activeRun('name');
    await Promise.all([send({ text: 'Ann' }), send({ text: 'Bob' })]);
    expect(run().vars).toEqual({ kept: 'yes', name: 'Ann' });
    expect(h.sends).toHaveLength(1);
  });

  it('two off-script messages re-send the menu once', async () => {
    activeRun('one');
    await Promise.all([send({ text: 'eh' }), send({ text: 'what' })]);
    expect(h.sends).toEqual([{ kind: 'buttons', text: 'one' }]);
    expect(run().reprompt_count).toBe(1);
  });

  it('does not reopen or overwrite a run that ended meanwhile', async () => {
    activeRun('one');
    h.db.flow_nodes[2] = node('two', 'send_message', {
      text: 'bye',
      next_node_key: 'end',
    });
    h.onSend = () => {
      run().status = 'timed_out';
    };
    await send({ tap: 'go' });
    expect(run().status).toBe('timed_out');
  });
});

describe('a run belongs to its chat', () => {
  it('leaves text on another number alone', async () => {
    activeRun('one');
    expect(await send({ text: 'hello' }, 'cv2')).toMatchObject({
      consumed: false,
      outcome: 'no_match',
    });
    expect(run()).toMatchObject({ status: 'active', reprompt_count: 0 });
    expect(h.sends).toEqual([]);
  });

  it('takes a tap on its own menu wherever it arrives', async () => {
    activeRun('one');
    expect(await send({ tap: 'go' }, 'cv2')).toMatchObject({ consumed: true });
    expect(run().current_node_key).toBe('two');
  });
});

describe('hand-off', () => {
  beforeEach(() => {
    activeRun('one');
    h.db.flow_nodes[1] = menu('one', 'go', 'hand');
  });

  it('assigns active staff to an unassigned chat', async () => {
    await send({ tap: 'go' });
    expect(conv()).toMatchObject({
      status: 'pending',
      assigned_agent_id: 'u2',
    });
    expect(run().status).toBe('handed_off');
  });

  it('never replaces the person already on the chat', async () => {
    conv().assigned_agent_id = 'u9';
    await send({ tap: 'go' });
    expect(conv()).toMatchObject({
      status: 'pending',
      assigned_agent_id: 'u9',
    });
  });

  it.each(['gone', 'stranger'])('skips a %s assignee', async (assign_to) => {
    h.db.flow_nodes[4] = node('hand', 'handoff', { assign_to });
    await send({ tap: 'go' });
    expect(conv().assigned_agent_id).toBeNull();
  });

  it('rings the admins when the chat could not be updated', async () => {
    h.fail.add('conversations.update');
    await send({ tap: 'go' });
    expect(h.notify).toHaveBeenCalled();
    expect(run().status).toBe('handed_off');
  });
});

describe('consent', () => {
  it.each(['opted_out_at', 'do_not_contact_at'])(
    '%s: nothing is sent, the run ends, none starts',
    async (flag) => {
      h.db.contacts[0][flag] = OLD;
      activeRun('one');
      expect(await send({ tap: 'go' })).toMatchObject({ consumed: false });
      expect(run().end_reason).toBe('customer_opted_out');
      expect(await send({ text: 'menu' })).toMatchObject({ consumed: false });
      expect(h.db.flow_runs).toHaveLength(1);
      expect(h.sends).toEqual([]);
    }
  );

  it('an unreadable flag sends nothing and keeps the run', async () => {
    h.fail.add('contacts.select');
    activeRun('one');
    expect(await send({ tap: 'go' })).toMatchObject({ consumed: false });
    expect(run().status).toBe('active');
    expect(h.sends).toEqual([]);
  });
});
