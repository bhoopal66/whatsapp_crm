import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentPort, JourneyStore, OutboxItem } from '../ports';
import { drain } from '../runner';
import type { Action, JourneyFile } from '../types';
import { fakeDb, type Reply } from './fake-db';
import {
  JourneyDeliveryInFlightError,
  createJourneySink,
  taskTitle,
  withFailureRecording,
} from './sink';

const h = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendButtons: vi.fn(),
  sendList: vi.fn(),
  sendTemplate: vi.fn(),
  botChannel: vi.fn(),
  templateRow: vi.fn(),
  createTask: vi.fn(),
  owner: vi.fn(),
  ensureOpenFile: vi.fn(),
}));

vi.mock('@/lib/flows/channel-send', () => ({
  engineSendText: h.sendText,
  engineSendInteractiveButtons: h.sendButtons,
  engineSendInteractiveList: h.sendList,
}));
vi.mock('@/lib/automations/channel-send', () => ({
  engineSendTemplate: h.sendTemplate,
}));
vi.mock('@/lib/whatsapp/channels', () => ({ resolveBotChannel: h.botChannel }));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: h.templateRow,
}));
vi.mock('@/lib/tasks/system', () => ({
  createSystemTask: h.createTask,
  resolveTaskOwner: h.owner,
}));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureOpenFile: h.ensureOpenFile,
}));

const NOW = new Date('2026-10-12T09:30:00Z');
const FILE: Reply = {
  data: {
    account_id: 'a1',
    contact_id: 'c1',
    conversation_id: 'cv1',
    workflow_key: 'taamul_welcome_to_close.v1',
  },
};
const item = (action: Action, id = 'it-1'): OutboxItem => ({
  id,
  fileId: 'f1',
  seq: 1,
  action,
  status: 'pending',
});
const send = (
  template: string,
  category: 'MARKETING' | 'UTILITY' | 'SESSION',
  variant?: string
): Action => ({
  type: 'SEND',
  template,
  category,
  billable: category !== 'SESSION',
  ...(variant ? { variant } : {}),
});
const sink = (...replies: Reply[]) => {
  const f = fakeDb(...replies);
  return { ...f, sink: createJourneySink({ db: f.db, now: () => NOW }) };
};
const outboxUpdates = (queries: unknown[][]) =>
  queries
    .filter((q) => JSON.stringify(q[0]) === '["from","journey_outbox"]')
    .map(
      (q) =>
        (
          q.find((c) => (c as unknown[])[0] === 'update') as
            unknown[] | undefined
        )?.[1]
    );

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.sendText.mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
  h.sendButtons.mockResolvedValue({ whatsapp_message_id: 'wamid.btn' });
  h.sendList.mockResolvedValue({ whatsapp_message_id: 'wamid.list' });
  h.sendTemplate.mockResolvedValue({ whatsapp_message_id: 'wamid.tpl' });
  h.templateRow.mockResolvedValue({ row: { status: 'APPROVED' } });
  h.botChannel.mockResolvedValue({ id: 'ch1', provider: 'meta' });
  h.createTask.mockResolvedValue({ id: 't1', created: true });
  h.owner.mockResolvedValue('u-owner');
});

describe('journey sink: SEND claims', () => {
  it("'claimed': sends, then stores the WhatsApp message id as delivery_ref", async () => {
    const { sink: s, queries } = sink(FILE, { data: 'claimed' });
    await s.deliver(item(send('pos_quote', 'UTILITY')));
    expect(queries[1]).toEqual([
      ['rpc', 'journey_claim_delivery', { p_item_id: 'it-1' }],
      ['await'],
    ]);
    expect(h.templateRow).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      'pos_quote'
    );
    expect(h.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'a1',
        contactId: 'c1',
        conversationId: 'cv1',
        templateName: 'pos_quote',
      })
    );
    expect(outboxUpdates(queries)).toEqual([{ delivery_ref: 'wamid.tpl' }]);
    expect(queries.at(-1)).toContainEqual(['eq', 'id', 'it-1']);
  });

  it("'delivered' / 'dropped': nothing is sent again", async () => {
    for (const state of [
      'delivered',
      [{ journey_claim_delivery: 'dropped' }],
    ]) {
      const { sink: s, queries } = sink(FILE, { data: state });
      await s.deliver(item(send('welcome_menu', 'SESSION')));
      expect(queries).toHaveLength(2);
    }
    expect(h.sendButtons).not.toHaveBeenCalled();
  });

  it("'in_flight': throws so the drain stops and retries later", async () => {
    const { sink: s } = sink(FILE, { data: 'in_flight' });
    await expect(
      s.deliver(item(send('pos_quote', 'UTILITY')))
    ).rejects.toBeInstanceOf(JourneyDeliveryInFlightError);
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it("'stale': never resends; records delivery_ref 'unconfirmed' and warns", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sink: s, queries } = sink(FILE, { data: 'stale' });
    await s.deliver(item(send('pos_quote', 'UTILITY')));
    expect(h.sendTemplate).not.toHaveBeenCalled();
    expect(h.templateRow).not.toHaveBeenCalled();
    expect(outboxUpdates(queries)).toEqual([{ delivery_ref: 'unconfirmed' }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('stale delivery claim')
    );
    warn.mockRestore();
  });

  it('a failed send keeps the claim, records last_error and rethrows', async () => {
    h.sendTemplate.mockRejectedValue(new Error('Whapi 500'));
    const { sink: s, queries } = sink(FILE, { data: 'claimed' });
    await expect(s.deliver(item(send('pos_quote', 'UTILITY')))).rejects.toThrow(
      'Whapi 500'
    );
    expect(outboxUpdates(queries)).toEqual([{ last_error: 'Whapi 500' }]);
  });

  it("falls back to the contact's latest conversation; drops when there is none", async () => {
    const noConv = {
      data: { ...(FILE.data as object), conversation_id: null },
    };
    const a = sink(noConv, { data: { id: 'cv9' } }, { data: 'claimed' });
    await a.sink.deliver(item(send('pos_quote', 'UTILITY')));
    expect(a.queries[1]).toEqual([
      ['from', 'conversations'],
      ['select', 'id'],
      ['eq', 'account_id', 'a1'],
      ['eq', 'contact_id', 'c1'],
      ['order', 'last_message_at', { ascending: false, nullsFirst: false }],
      ['limit', 1],
      ['maybeSingle'],
    ]);
    expect(h.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv9' })
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = sink(noConv, { data: null });
    await b.sink.deliver(item(send('pos_quote', 'UTILITY')));
    expect(outboxUpdates(b.queries)).toEqual([
      { status: 'dropped', drop_reason: 'NO_CONVERSATION' },
    ]);
    expect(b.queries.flat(1)).not.toContainEqual([
      'rpc',
      'journey_claim_delivery',
      expect.anything(),
    ]);
    warn.mockRestore();
  });
});

describe('journey sink: templates', () => {
  it('a missing template drops the item and opens one task per template per day', async () => {
    h.templateRow.mockResolvedValue({ row: null });
    for (const id of ['it-1', 'it-2']) {
      const { sink: s, queries } = sink(FILE, { data: 'claimed' });
      await s.deliver(item(send('pos_quote', 'UTILITY'), id));
      expect(outboxUpdates(queries)).toEqual([
        { status: 'dropped', drop_reason: 'TEMPLATE_UNAVAILABLE' },
      ]);
    }
    expect(h.sendTemplate).not.toHaveBeenCalled();
    expect(h.createTask).toHaveBeenCalledTimes(2);
    const refs = h.createTask.mock.calls.map((c) => c[1].sourceRef);
    // The tasks table is UNIQUE on (account, source, source_ref): one task.
    expect(refs).toEqual([
      'tpl:pos_quote:2026-10-12',
      'tpl:pos_quote:2026-10-12',
    ]);
    expect(h.createTask.mock.calls[0][1]).toMatchObject({
      accountId: 'a1',
      kind: 'journey',
      source: 'journey',
      title: 'WhatsApp template "pos_quote" is not available',
    });
  });

  it('an unapproved template is dropped on a Meta number and sent on Whapi', async () => {
    h.templateRow.mockResolvedValue({ row: { status: 'PENDING' } });
    const meta = sink(FILE, { data: 'claimed' });
    await meta.sink.deliver(item(send('pos_intro_offer', 'MARKETING')));
    expect(h.botChannel).toHaveBeenCalledWith(
      expect.anything(),
      'a1',
      'automation',
      'cv1'
    );
    expect(outboxUpdates(meta.queries)).toEqual([
      { status: 'dropped', drop_reason: 'TEMPLATE_UNAVAILABLE' },
    ]);
    expect(h.sendTemplate).not.toHaveBeenCalled();

    h.botChannel.mockResolvedValue({ id: 'ch2', provider: 'whapi' });
    const whapi = sink(FILE, { data: 'claimed' });
    await whapi.sink.deliver(item(send('pos_intro_offer', 'MARKETING')));
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
    expect(outboxUpdates(whapi.queries)).toEqual([
      { delivery_ref: 'wamid.tpl' },
    ]);
  });

  it('a task failure is logged and the item still drops', async () => {
    h.templateRow.mockResolvedValue({ row: null });
    h.createTask.mockRejectedValue(new Error('tasks: boom'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sink: s, queries } = sink(FILE, { data: 'claimed' });
    await s.deliver(item(send('pos_quote', 'UTILITY')));
    expect(outboxUpdates(queries)).toEqual([
      { status: 'dropped', drop_reason: 'TEMPLATE_UNAVAILABLE' },
    ]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('journey sink: SESSION messages', () => {
  it('welcome_menu goes out as reply buttons carrying the payload ids', async () => {
    const { sink: s, queries } = sink(
      FILE,
      { data: 'claimed' },
      { data: { copy: { titles: { LOAN: 'Finance' } } } }
    );
    await s.deliver(item(send('welcome_menu', 'SESSION')));
    expect(queries[2].slice(0, 3)).toEqual([
      ['from', 'journey_settings'],
      ['select', 'copy'],
      ['eq', 'account_id', 'a1'],
    ]);
    expect(h.sendButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'a1',
        conversationId: 'cv1',
        contactId: 'c1',
        buttons: [
          { id: 'POS', title: 'POS terminal' },
          { id: 'ACCOUNT', title: 'Business account' },
          { id: 'LOAN', title: 'Finance' },
        ],
      })
    );
    expect(outboxUpdates(queries)).toEqual([{ delivery_ref: 'wamid.btn' }]);
    expect(h.templateRow).not.toHaveBeenCalled();
  });

  it('pos_pitch_in_window goes out as a list whose row ids are the payload ids', async () => {
    const { sink: s } = sink(FILE, { data: 'claimed' });
    await s.deliver(item(send('pos_pitch_in_window', 'SESSION')));
    const args = h.sendList.mock.calls[0][0];
    expect(args.sections[0].rows.map((r: { id: string }) => r.id)).toEqual([
      'QUOTE',
      'COMPARE',
      'ADVISOR',
      'NOT_NOW',
      'CALL_ME_BACK',
    ]);
    expect(args.buttonLabel).toBe('Choose an option');
  });

  it('callback_ack is text worded by its variant', async () => {
    for (const [variant, text] of [
      ['IN_HOURS', 'An advisor will call you shortly.'],
      ['OUT_OF_HOURS', 'An advisor will call you tomorrow from 9 am.'],
    ]) {
      const { sink: s } = sink(FILE, { data: 'claimed' });
      await s.deliver(item(send('callback_ack', 'SESSION', variant)));
      expect(h.sendText).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text,
          surface: 'flow',
          conversationId: 'cv1',
        })
      );
    }
  });
});

describe('journey sink: the other actions', () => {
  it('ADVISOR_TASK opens a task keyed on the item id, owned by the contact owner', async () => {
    const { sink: s } = sink(FILE);
    await s.deliver(
      item({
        type: 'ADVISOR_TASK',
        kind: 'CALLBACK_BLOCKED_DNC',
        dueAt: '2026-10-12T10:00:00Z',
        note: 'n',
      })
    );
    expect(h.owner).toHaveBeenCalledWith(expect.anything(), 'a1', {
      contactId: 'c1',
      conversationId: 'cv1',
    });
    expect(h.createTask).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'a1',
      kind: 'callback',
      title: 'Callback requested by a do-not-contact customer',
      note: 'n',
      contactId: 'c1',
      conversationId: 'cv1',
      assignedTo: 'u-owner',
      dueAt: '2026-10-12T10:00:00Z',
      source: 'journey',
      sourceRef: 'it-1',
      meta: { journeyFileId: 'f1', kind: 'CALLBACK_BLOCKED_DNC' },
    });
    await sink(FILE).sink.deliver(
      item({
        type: 'ADVISOR_TASK',
        kind: 'REISSUE_OFFER',
        dueAt: '2026-10-12T10:00:00Z',
        note: '',
      })
    );
    expect(h.createTask.mock.calls[1][1]).toMatchObject({
      kind: 'journey',
      title: 'Re-issue the expired quote/offer',
      note: null,
    });
    expect(taskTitle('ADVISOR_NUDGE')).toBe(
      'Nudge the customer (free-text, within 24 h)'
    );
    expect(taskTitle('WINDOW_CLOSED')).toBe('Window closed — send a template');
    expect(taskTitle('CALLBACK')).toBe('Call the customer back');
    expect(taskTitle('DOCS_OVERDUE')).toBe('Docs overdue');
  });

  it('REQUEST_CALLBACK queues one callback request per outbox item', async () => {
    const { sink: s, queries } = sink(FILE);
    await s.deliver(
      item({
        type: 'REQUEST_CALLBACK',
        contactId: 'c1',
        fileId: 'f1',
        notBefore: '2026-10-13T05:00:00Z',
      })
    );
    expect(queries[1]).toEqual([
      ['from', 'callback_requests'],
      [
        'upsert',
        {
          account_id: 'a1',
          contact_id: 'c1',
          conversation_id: 'cv1',
          journey_file_id: 'f1',
          source: 'journey',
          not_before: '2026-10-13T05:00:00Z',
          assigned_to: 'u-owner',
          outbox_item_id: 'it-1',
        },
        { onConflict: 'outbox_item_id', ignoreDuplicates: true },
      ],
      ['await'],
    ]);
  });

  it('SET_OPT_OUT re-applies the committed decision through journey_set_opt_out, by item id', async () => {
    const { sink: s, queries } = sink({ data: true });
    await s.deliver(item({ type: 'SET_OPT_OUT', optedOut: true }));
    // journey_commit applied it with the decision; the item holds its value and time.
    expect(queries).toEqual([
      [['rpc', 'journey_set_opt_out', { p_item_id: 'it-1' }], ['await']],
    ]);
    const e = await sink({ error: { message: 'denied', code: '42501' } })
      .sink.deliver(item({ type: 'SET_OPT_OUT', optedOut: false }))
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ source: 'journey_set_opt_out', code: '42501' });
  });

  it("START_NEW_JOURNEY opens the next file and records it as the item's delivery_ref", async () => {
    h.ensureOpenFile.mockResolvedValue('f2');
    const { sink: s, queries } = sink(FILE);
    await s.deliver(
      item({
        type: 'START_NEW_JOURNEY',
        contactId: 'c1',
        entry: 'INBOUND',
        cause: 'button CROSS_SELL',
      })
    );
    expect(h.ensureOpenFile).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'a1',
      contactId: 'c1',
      conversationId: 'cv1',
      workflowKey: 'taamul_welcome_to_close.v1',
    });
    expect(outboxUpdates(queries)).toEqual([{ delivery_ref: 'f2' }]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.ensureOpenFile.mockResolvedValue('f1');
    const same = sink(FILE);
    await same.sink.deliver(
      item({
        type: 'START_NEW_JOURNEY',
        contactId: 'c1',
        entry: 'INBOUND',
        cause: 'x',
      })
    );
    expect(outboxUpdates(same.queries)).toEqual([]);
    warn.mockRestore();
  });

  it('SET_TIMER, CANCEL_TIMERS, CLOSE, LOG_COST and MARK_OPTIN_WELCOME_SENT touch nothing', async () => {
    const { sink: s, queries } = sink();
    for (const a of [
      { type: 'SET_TIMER', kind: 'k', fireAt: '2026-10-12T10:00:00Z' },
      { type: 'CANCEL_TIMERS', all: true },
      { type: 'CANCEL_TIMERS', kinds: ['k'] },
      { type: 'CLOSE', outcome: 'WON', reason: 'r' },
      { type: 'LOG_COST', template: 't', category: 'UTILITY' },
      { type: 'MARK_OPTIN_WELCOME_SENT', contactId: 'c1' },
    ] as Action[])
      await s.deliver(item(a));
    expect(queries).toEqual([]);
  });
});

describe('the opt-in welcome through the runner', () => {
  it('MARK is a no-op, so the SEND claims the welcome with its own item id and goes out', async () => {
    const items: OutboxItem[] = [
      {
        id: 'mark-1',
        fileId: 'f1',
        seq: 1,
        status: 'pending',
        action: { type: 'MARK_OPTIN_WELCOME_SENT', contactId: 'c1' },
      },
      {
        id: 'send-1',
        fileId: 'f1',
        seq: 2,
        status: 'pending',
        action: send('taamul_optin_welcome', 'MARKETING'),
      },
    ];
    const store = {
      load: async () => ({ id: 'f1', contactId: 'c1' }) as JourneyFile,
      pendingOutbox: async () => items.filter((i) => i.status === 'pending'),
      markDelivered: async (id: string) => {
        items.find((i) => i.id === id)!.status = 'delivered';
      },
      markDropped: async (id: string) => {
        items.find((i) => i.id === id)!.status = 'dropped';
      },
      pendingOptOut: async () => null,
    } as unknown as JourneyStore;
    const claims: [string, string][] = [];
    const consent: ConsentPort = {
      hasMarketingOptIn: async () => true,
      isOptedOut: async () => false,
      hasReceivedOptinWelcome: async () => true,
      claimOptinWelcome: async (contactId, claimId) => {
        claims.push([contactId, claimId]);
        return claims.every(([, id]) => id === claimId);
      },
    };
    const { sink: s } = sink(FILE, { data: 'claimed' });
    const r = await drain({ store, sink: s, consent }, 'f1', NOW.toISOString());
    expect(r).toMatchObject({ delivered: 2, pending: 0 });
    expect(claims).toEqual([['c1', 'send-1']]);
    expect(h.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'taamul_optin_welcome' })
    );
  });
});

describe('withFailureRecording', () => {
  const failing = (err: unknown) => ({
    deliver: vi.fn(async () => {
      throw err;
    }),
  });
  const LOG = item({ type: 'LOG_COST', template: 't', category: 'UTILITY' });

  it('records a failed delivery on its item and rethrows the original error', async () => {
    const boom = new Error('Whapi 500');
    const { db, queries } = fakeDb({ data: true });
    await expect(
      withFailureRecording(failing(boom), db).deliver(LOG)
    ).rejects.toBe(boom);
    expect(queries).toEqual([
      [
        [
          'rpc',
          'journey_outbox_failed',
          { p_item_id: 'it-1', p_error: 'Whapi 500' },
        ],
        ['await'],
      ],
    ]);
  });

  it('passes a successful delivery through untouched, recording nothing', async () => {
    const inner = { deliver: vi.fn(async () => undefined) };
    const { db, queries } = fakeDb();
    await withFailureRecording(inner, db).deliver(LOG);
    expect(inner.deliver).toHaveBeenCalledWith(LOG);
    expect(queries).toEqual([]);
  });

  it('records a non-Error throw as text, cut to 500 characters', async () => {
    const { db, queries } = fakeDb();
    await expect(
      withFailureRecording(failing('x'.repeat(600)), db).deliver(LOG)
    ).rejects.toBe('x'.repeat(600));
    expect(queries[0][0][2]).toEqual({
      p_item_id: 'it-1',
      p_error: 'x'.repeat(500),
    });
  });

  it('still rethrows the delivery error when recording it fails, and logs that', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inFlight = new JourneyDeliveryInFlightError('it-1');
    const { db } = fakeDb({ error: { message: 'db down' } });
    await expect(
      withFailureRecording(failing(inFlight), db).deliver(LOG)
    ).rejects.toBe(inFlight);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not record the failed delivery'),
      expect.stringContaining('db down')
    );
    error.mockRestore();
  });
});
