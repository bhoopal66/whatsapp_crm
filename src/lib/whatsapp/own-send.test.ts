import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findOrCreateContact: vi.fn(),
  findOrCreatePersonalChat: vi.fn(),
}));

vi.mock('./inbound-pipeline', () => ({
  findOrCreateContact: h.findOrCreateContact,
  findOrCreatePersonalChat: h.findOrCreatePersonalChat,
}));

import type { WhatsAppChannel } from './channels';
import { persistOwnSend } from './own-send';

const CHANNEL = {
  id: 'cfg-1',
  accountId: 'acct-1',
  provider: 'openwa',
  isPersonal: true,
  personalUserId: 'owner-1',
} as unknown as WhatsAppChannel;

const SEND = {
  id: 'wamid-1',
  peerPhone: '971501234567',
  text: 'typed on the phone',
  timestamp: '1793174400',
};

const state = {
  existing: [] as { id: string }[],
  onNumber: [] as { id: string }[],
  summaryFilters: [] as string[],
  inserted: [{ id: 'm1' }] as { id: string }[],
  upserts: [] as { row: Record<string, unknown>; opts: unknown }[],
  updates: [] as Record<string, unknown>[],
  reads: [] as Record<string, unknown>[],
};

function fakeDb() {
  return {
    from: (table: string) => {
      if (table === 'messages') {
        return {
          select: () => {
            const filters: Record<string, unknown> = {};
            const b = {
              eq: (c: string, v: unknown) => {
                filters[c] = v;
                return b;
              },
              limit: async () => {
                state.reads.push(filters);
                return {
                  data:
                    'channel_id' in filters ? state.onNumber : state.existing,
                  error: null,
                };
              },
            };
            return b;
          },
          upsert: (row: Record<string, unknown>, opts: unknown) => {
            state.upserts.push({ row, opts });
            return {
              select: async () => ({ data: state.inserted, error: null }),
            };
          },
        };
      }
      return {
        update: (patch: Record<string, unknown>) => {
          state.updates.push(patch);
          return {
            eq: () => ({
              or: async (f: string) => {
                state.summaryFilters.push(f);
                return { error: null };
              },
            }),
          };
        },
      };
    },
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  state.existing = [];
  state.onNumber = [];
  state.summaryFilters = [];
  state.inserted = [{ id: 'm1' }];
  state.upserts = [];
  state.updates = [];
  state.reads = [];
  h.findOrCreateContact.mockResolvedValue({ contact: { id: 'contact-1' } });
  h.findOrCreatePersonalChat.mockResolvedValue({
    conversation: { id: 'conv-1' },
  });
});

describe('persistOwnSend', () => {
  it('skips a channel that is not a personal number', async () => {
    const out = await persistOwnSend(
      fakeDb(),
      {
        ...CHANNEL,
        isPersonal: false,
        personalUserId: null,
      } as WhatsAppChannel,
      SEND
    );
    expect(out).toBe('skipped');
    expect(h.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('never renames a contact: findOrCreateContact gets rename:false', async () => {
    await persistOwnSend(fakeDb(), CHANNEL, SEND);
    expect(h.findOrCreateContact).toHaveBeenCalledWith(
      'acct-1',
      'owner-1',
      '971501234567',
      '971501234567',
      { rename: false }
    );
  });

  it('returns exists, without inserting, when the id is already a row', async () => {
    state.existing = [{ id: 'old' }];
    const out = await persistOwnSend(fakeDb(), CHANNEL, SEND);
    expect(out).toBe('exists');
    expect(state.reads[1]).toEqual({
      conversation_id: 'conv-1',
      message_id: 'wamid-1',
    });
    expect(state.upserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('inserts the owner’s message with the phone’s timestamp', async () => {
    const out = await persistOwnSend(fakeDb(), CHANNEL, SEND);
    expect(out).toBe('inserted');
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].row).toEqual({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      sender_id: 'owner-1',
      content_type: 'text',
      content_text: 'typed on the phone',
      message_id: 'wamid-1',
      status: 'sent',
      provider: 'openwa',
      channel_id: 'cfg-1',
      created_at: new Date(1793174400 * 1000).toISOString(),
    });
    expect(state.upserts[0].opts).toEqual({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    });
  });

  it('updates only the chat summary, never unread or status', async () => {
    await persistOwnSend(fakeDb(), CHANNEL, SEND);
    expect(state.updates).toHaveLength(1);
    expect(Object.keys(state.updates[0]).sort()).toEqual([
      'last_message_at',
      'last_message_text',
      'updated_at',
    ]);
    expect(state.updates[0].last_message_text).toBe('typed on the phone');
    expect(state.updates[0].last_message_at).toBe(
      new Date(1793174400 * 1000).toISOString()
    );
  });

  it('returns exists before any contact lookup when the number already holds the id', async () => {
    state.onNumber = [{ id: 'filed-elsewhere' }];
    const out = await persistOwnSend(fakeDb(), CHANNEL, SEND);
    expect(out).toBe('exists');
    expect(state.reads[0]).toEqual({
      channel_id: 'cfg-1',
      message_id: 'wamid-1',
    });
    expect(h.findOrCreateContact).not.toHaveBeenCalled();
    expect(state.upserts).toHaveLength(0);
  });

  it('moves the summary forward only', async () => {
    await persistOwnSend(fakeDb(), CHANNEL, SEND);
    const at = new Date(1793174400 * 1000).toISOString();
    expect(state.summaryFilters).toEqual([
      `last_message_at.is.null,last_message_at.lt.${at}`,
    ]);
  });

  it('returns exists and leaves the summary when the upsert lost a race', async () => {
    state.inserted = [];
    const out = await persistOwnSend(fakeDb(), CHANNEL, SEND);
    expect(out).toBe('exists');
    expect(state.updates).toHaveLength(0);
  });
});
