import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  check: vi.fn(),
  loadChannels: vi.fn(),
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  contact: {} as Record<string, unknown>,
  failing: '',
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

import { sendCaseCsat } from './csat-send';

const CLAIM = {
  id: 'r1',
  accountId: 'a1',
  caseId: 'k1',
  trigger: 'approved' as const,
  contactId: 'c1',
  conversationId: 'v1',
  contactName: 'Asha',
  bankName: 'RAKBANK',
  product: 'Business account',
  templateName: 'case_csat_approved',
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

const FAILED = { data: null, error: { code: '57014', message: 'x' } };

// Rows carry only the columns asked for, as PostgREST's would.
function db() {
  const from = (table: string) => {
    const row: Record<string, unknown> =
      table === 'contacts'
        ? h.contact
        : table === 'messages'
          ? { id: 'm1' }
          : CONV;
    let cols: string[] = [];
    const read = async () =>
      table === h.failing
        ? FAILED
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
  h.failing = '';
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

describe('sendCaseCsat', () => {
  it("asks the number's limit right before the gateway, then sends once", async () => {
    const d = db();
    expect(await sendCaseCsat(d, CLAIM)).toMatchObject({
      outcome: 'sent',
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
    expect(await sendCaseCsat(db(), CLAIM)).toEqual({
      outcome: 'held',
      reason: 'number_daily_limit',
    });
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it.each(['opted_out_at', 'do_not_contact_at'])(
    'refuses a contact with %s set since the claim',
    async (col) => {
      h.contact[col] = '2026-11-23T08:00:00Z';
      await expect(sendCaseCsat(db(), CLAIM)).rejects.toMatchObject({
        name: 'CsatRefusal',
        code: 'opted_out',
      });
      expect(h.sendText).not.toHaveBeenCalled();
    }
  );

  it.each(['conversations', 'contacts'])(
    'holds the request, sending nothing, when %s cannot be read',
    async (table) => {
      h.failing = table;
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await sendCaseCsat(db(), CLAIM);
      log.mockRestore();
      expect(res).toEqual({ outcome: 'held', reason: 'lookup_failed' });
      expect(h.sendText).not.toHaveBeenCalled();
    }
  );

  it('logs a message that could not be saved, and stays sent', async () => {
    h.failing = 'messages';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await sendCaseCsat(db(), CLAIM);
    const logged = log.mock.calls;
    log.mockRestore();
    expect(res).toMatchObject({ outcome: 'sent', messageId: null });
    expect(logged).toEqual([['[cases] csat message not saved', '57014']]);
  });
});
