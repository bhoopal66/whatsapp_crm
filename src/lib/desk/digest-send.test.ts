import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  check: vi.fn(),
  loadChannels: vi.fn(),
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  contact: {} as Record<string, unknown>,
}));

vi.mock('@/lib/team-activity/auto-guard', () => ({
  checkAutoStartAllowed: h.check,
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  loadChannels: h.loadChannels,
  resolveSendChannel: vi.fn(),
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  sendText: h.sendText,
  sendTemplate: h.sendTemplate,
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  renderTemplateBody: () => 'body',
  resolveTemplateRow: async () => ({
    row: { status: 'APPROVED', category: 'Utility', body_text: '{{1}} {{2}}' },
  }),
}));

import { sendDeskDigest } from './digest-send';

const CLAIM = {
  id: 'o1',
  accountId: 'a1',
  contactId: 'c1',
  conversationId: 'v1',
  appNumber: 'TC-26-00001',
  summary: 'All banks: Ejari',
  templateName: 'desk_digest',
  language: 'en',
};
const CHANNEL = { id: 'n1', provider: 'openwa', isPersonal: false };
const CONV = {
  id: 'v1',
  contact_id: 'c1',
  channel_id: 'n1',
  send_channel_id: null,
  personal_owner_id: null,
};

// Rows carry only the columns asked for, as PostgREST's would.
function db(failing: string | null = null) {
  const from = (table: string) => {
    const row: Record<string, unknown> =
      table === 'contacts'
        ? h.contact
        : table === 'messages'
          ? { id: 'm1' }
          : CONV;
    let cols: string[] = [];
    const read = async () =>
      table === failing
        ? { data: null, error: { code: '57014' } }
        : {
            data: Object.fromEntries(
              Object.entries(row).filter(([k]) => cols.includes(k))
            ),
            error: null,
          };
    const q = {
      select: (c: string) => {
        cols = c.split(',').map((x) => x.trim());
        return q;
      },
      eq: () => q,
      insert: () => q,
      update: () => q,
      maybeSingle: read,
      single: read,
    };
    return q;
  };
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.contact = {
    id: 'c1',
    phone: '+971501234567',
    opted_out_at: null,
    do_not_contact_at: null,
  };
  h.loadChannels.mockResolvedValue([CHANNEL]);
  h.sendText.mockResolvedValue({ messageId: 'w1' });
  h.check.mockResolvedValue({ blocked: false });
});

describe('sendDeskDigest', () => {
  it("asks the number's limit right before the gateway, then sends once", async () => {
    const d = db();
    expect(await sendDeskDigest(d, CLAIM)).toMatchObject({
      providerMessageId: 'w1',
    });
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.check).toHaveBeenCalledWith(d, 'a1', 'v1', CHANNEL);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.check.mock.invocationCallOrder[0]!).toBeLessThan(
      h.sendText.mock.invocationCallOrder[0]!
    );
  });

  it('sends nothing on a number at its daily limit', async () => {
    h.check.mockResolvedValue({ blocked: true });
    await expect(sendDeskDigest(db(), CLAIM)).rejects.toMatchObject({
      name: 'DigestRefusal',
      code: 'number_daily_limit',
    });
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it.each(['opted_out_at', 'do_not_contact_at'])(
    'refuses a contact with %s set since the claim',
    async (col) => {
      h.contact[col] = '2026-11-23T08:00:00Z';
      await expect(sendDeskDigest(db(), CLAIM)).rejects.toMatchObject({
        name: 'DigestRefusal',
        code: 'opted_out',
      });
      expect(h.sendText).not.toHaveBeenCalled();
    }
  );

  it.each(['conversations', 'contacts'])(
    'a failed read of %s is not a bad number',
    async (table) => {
      await expect(sendDeskDigest(db(table), CLAIM)).rejects.toMatchObject({
        name: 'DigestRefusal',
        code: 'read_failed',
      });
      expect(h.sendText).not.toHaveBeenCalled();
    }
  );

  it('logs a sent digest that could not be recorded', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendDeskDigest(db('messages'), CLAIM)).toEqual({
      providerMessageId: 'w1',
      messageId: null,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('57014'));
    log.mockRestore();
  });
});
