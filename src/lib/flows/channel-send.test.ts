import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendText: vi.fn(),
  loadChannels: vi.fn(),
  resolveBotChannel: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
}));

vi.mock('@/lib/whatsapp/provider', () => ({
  sendText: h.sendText,
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
  sendMedia: vi.fn(),
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  loadChannels: h.loadChannels,
  resolveBotChannel: h.resolveBotChannel,
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: { id: 'contact-1', phone: '+971501234567' },
            error: null,
          }),
        insert: (row: Record<string, unknown>) => {
          h.inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(ok),
      };
      return chain;
    },
  }),
}));

import { engineSendText } from './channel-send';

const WHAPI = { id: 'ch-whapi', provider: 'whapi' };
const META = { id: 'ch-meta', provider: 'meta' };

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'Hello',
  surface: 'ai_reply' as const,
};

beforeEach(() => {
  h.inserts = [];
  h.sendText.mockResolvedValue({ messageId: 'wamid-1' });
  h.loadChannels.mockResolvedValue([META, WHAPI]);
  h.resolveBotChannel.mockResolvedValue(META);
});

describe('engineSendText channel', () => {
  it('resolves the surface route when no channelId is given', async () => {
    await engineSendText(ARGS);
    expect(h.resolveBotChannel).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'ai_reply',
      'conv-1'
    );
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ channel: META })
    );
  });

  it('sends on exactly the given channel, bypassing the route (079)', async () => {
    await engineSendText({ ...ARGS, channelId: 'ch-whapi' });
    expect(h.resolveBotChannel).not.toHaveBeenCalled();
    expect(h.loadChannels).toHaveBeenCalledWith(expect.anything(), 'acct-1');
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ channel: WHAPI })
    );
    expect(h.inserts.find((i) => i.table === 'messages')?.row).toMatchObject({
      provider: 'whapi',
      channel_id: 'ch-whapi',
    });
  });

  it('throws, sending nothing, for a channel that is not the account’s', async () => {
    await expect(
      engineSendText({ ...ARGS, channelId: 'ch-elsewhere' })
    ).rejects.toThrow(/ch-elsewhere is not a connected number/);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });
});
