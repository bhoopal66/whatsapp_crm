import { describe, expect, it, vi } from 'vitest';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound';
import type { HandleResult } from '../runner';
import type { Action } from '../types';
import { DEFAULT_COPY, mergeCopy } from './copy';
import { fakeDb, type Reply } from './fake-db';
import { dispatchInboundToJourney, journeyEventFor } from './inbound';
import { SHIPPED_WORKFLOW_KEY as KEY } from './tick';

const msg = (
  over: Partial<NormalizedInboundMessage> = {}
): NormalizedInboundMessage => ({
  id: 'wamid.1',
  from: '971500000001',
  chatId: '971500000001',
  fromName: 'Asha',
  timestamp: '1760000000',
  type: 'text',
  text: 'hello',
  media: null,
  location: null,
  reaction: null,
  contacts: null,
  interactiveReplyId: null,
  interactiveReplyTitle: null,
  contextMessageId: null,
  forwarded: false,
  fromMe: false,
  isGroup: false,
  freeEntry: false,
  ...over,
});
const AT = new Date(1760000000 * 1000).toISOString();
const NOW = new Date('2026-10-12T10:00:00Z');

const ok = (state: string, actions: Action[] = []): HandleResult =>
  ({
    status: 'ok',
    result: { file: { state }, actions, warnings: [] },
    drain: { delivered: actions.length, pending: 0 },
  }) as unknown as HandleResult;

const settings = (over: Record<string, unknown> = {}): Reply => ({
  data: {
    enabled: true,
    workflow_key: KEY,
    start_on_first_inbound: false,
    copy: {},
    ...over,
  },
});

function run(
  message: NormalizedInboundMessage,
  replies: Reply[],
  results: HandleResult[]
) {
  const { db, queries } = fakeDb(...replies);
  const handle = vi.fn<(event: unknown, now: string) => Promise<HandleResult>>(
    async () => results.shift() ?? ok('S_MENU')
  );
  const out = dispatchInboundToJourney(
    {
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      message,
    },
    { now: () => NOW, runnerFor: () => ({ handle }) }
  );
  return { out, handle, queries };
}

describe('journeyEventFor', () => {
  const copy = mergeCopy({ titles: { LOAN: 'Finance please' } });
  it('maps text, replies, media and nothing else', () => {
    expect(journeyEventFor(msg({ freeEntry: true }), copy, AT)).toEqual({
      type: 'INBOUND_TEXT',
      text: 'hello',
      at: AT,
      freeEntry: true,
    });
    const tap = (id: string | null, title: string | null) =>
      journeyEventFor(
        msg({
          type: 'interactive',
          interactiveReplyId: id,
          interactiveReplyTitle: title,
        }),
        copy,
        AT
      );
    expect(tap('POS', 'POS terminal')).toEqual({
      type: 'BUTTON',
      payload: 'POS',
      at: AT,
    });
    // A template quick reply carries its title: the account's, then the default.
    expect(tap('Finance please', 'Finance please')).toMatchObject({
      payload: 'LOAN',
    });
    expect(tap(null, DEFAULT_COPY.titles.ACCOUNT)).toMatchObject({
      payload: 'ACCOUNT',
    });
    expect(tap('Something else', 'Something else')).toEqual({
      type: 'INBOUND_TEXT',
      text: 'Something else',
      at: AT,
      freeEntry: false,
    });
    expect(
      journeyEventFor(msg({ type: 'document', text: null }), copy, AT)
    ).toEqual({ type: 'MEDIA', count: 1, at: AT });
    expect(journeyEventFor(msg({ type: 'location' }), copy, AT)).toBeNull();
    expect(journeyEventFor(msg({ text: '  ' }), copy, AT)).toBeNull();
  });
});

describe('dispatchInboundToJourney', () => {
  it('does nothing for an account without the bot enabled', async () => {
    const r = run(msg(), [settings({ enabled: false })], []);
    expect(await r.out).toEqual({ consumed: false });
    expect(r.handle).not.toHaveBeenCalled();
    expect(r.queries).toHaveLength(1);
  });

  it("runs the open file's event as wa:<message id> and reports a change", async () => {
    const r = run(
      msg(),
      [settings(), { data: { id: 'f1', state: 'P_PITCH' } }],
      [ok('P_QUOTE_WAIT')]
    );
    expect(await r.out).toEqual({ consumed: true });
    expect(r.handle).toHaveBeenCalledWith(
      {
        type: 'INBOUND_TEXT',
        text: 'hello',
        at: AT,
        freeEntry: false,
        id: 'wa:wamid.1',
        fileId: 'f1',
      },
      NOW.toISOString()
    );
    expect(r.queries[1]).toEqual([
      ['from', 'journey_files'],
      ['select', 'id, state'],
      ['eq', 'account_id', 'acct-1'],
      ['eq', 'contact_id', 'contact-1'],
      ['is', 'closed_at', null],
      ['maybeSingle'],
    ]);
  });

  it('an event the file ignores (same state, no actions) is not consumed', async () => {
    const r = run(
      msg(),
      [settings(), { data: { id: 'f1', state: 'DOCS' } }],
      [ok('DOCS')]
    );
    expect(await r.out).toEqual({ consumed: false });
    const rejected = run(
      msg(),
      [settings(), { data: { id: 'f1', state: 'DOCS' } }],
      [{ status: 'rejected', error: { code: 'X', message: 'x' } }]
    );
    expect(await rejected.out).toEqual({ consumed: false });
  });

  it('with no open file, starts one only when start_on_first_inbound is on', async () => {
    const off = run(msg(), [settings(), { data: null }], []);
    expect(await off.out).toEqual({ consumed: false });
    expect(off.handle).not.toHaveBeenCalled();

    const on = run(
      msg(),
      [settings({ start_on_first_inbound: true }), { data: null }, {}, {}],
      [ok('S_MENU', [{ type: 'CANCEL_TIMERS', all: true }])]
    );
    expect(await on.out).toEqual({ consumed: true });
    const insert = on.queries[3].find((c) => c[0] === 'insert');
    expect(insert?.[1]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      workflow_key: KEY,
      state: 'NEW',
    });
    const fileId = (insert?.[1] as { id: string }).id;
    expect(on.handle.mock.calls[0][0]).toMatchObject({ fileId });
  });

  it('re-runs the event on the file a delivered START_NEW_JOURNEY opened', async () => {
    const start: Action = {
      type: 'START_NEW_JOURNEY',
      contactId: 'contact-1',
      entry: 'INBOUND',
      cause: 'REFER',
    };
    const r = run(
      msg({
        type: 'interactive',
        interactiveReplyId: 'CROSS_SELL',
        interactiveReplyTitle: 'Other products',
      }),
      [
        settings(),
        { data: { id: 'f1', state: 'WON' } },
        { data: { id: 'f2', state: 'NEW' } },
        { data: [{ delivery_ref: 'f2' }] },
      ],
      [ok('WON', [start]), ok('S_MENU')]
    );
    expect(await r.out).toEqual({ consumed: true });
    expect(r.handle.mock.calls.map((c) => c[0])).toEqual([
      {
        type: 'BUTTON',
        payload: 'CROSS_SELL',
        at: AT,
        id: 'wa:wamid.1',
        fileId: 'f1',
      },
      {
        type: 'BUTTON',
        payload: 'CROSS_SELL',
        at: AT,
        id: 'wa:wamid.1:new',
        fileId: 'f2',
      },
    ]);
    expect(r.queries[3]).toContainEqual([
      'eq',
      'action->>type',
      'START_NEW_JOURNEY',
    ]);
  });

  it('never throws: a database error reads as not consumed', async () => {
    const r = run(msg(), [{ error: { message: 'down' } }], []);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await r.out).toEqual({ consumed: false });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
