import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  check: vi.fn(),
  loadChannels: vi.fn(),
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  contact: {} as Record<string, unknown>,
  failing: '',
  handoff: vi.fn(),
  inserted: [] as Record<string, unknown>[],
  definite: false,
  checkSend: vi.fn(),
  refund: vi.fn(),
}));

vi.mock('@/lib/team-activity/auto-guard', () => ({
  checkAutoStartAllowed: h.check,
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  loadChannels: h.loadChannels,
  resolveSendChannel: vi.fn(),
  ChannelError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('@/lib/whatsapp/meta-health/check-send', () => ({
  checkSend: h.checkSend,
  refundSendReservation: h.refund,
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  sendText: h.sendText,
  sendTemplate: h.sendTemplate,
  isDefiniteSendRefusal: () => h.definite,
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  renderTemplateBody: () => 'body',
  resolveTemplateRow: async () => ({
    row: { status: 'APPROVED', category: 'Utility', body_text: '{{1}} {{2}}' },
  }),
}));

import { ChannelError } from '@/lib/whatsapp/channels';

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
  claimedAt: '2026-11-22T08:00:00.000Z',
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
      order: () => q,
      limit: () => q,
      insert: (v: Record<string, unknown>) => {
        h.inserted.push(v);
        return q;
      },
      update: () => q,
      maybeSingle: read,
      single: read,
    };
    return q;
  };
  return { from, rpc: h.handoff } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.failing = '';
  h.definite = false;
  h.inserted = [];
  h.handoff.mockReset().mockResolvedValue({ data: true, error: null });
  h.contact = {
    id: 'c1',
    phone: '+971501234567',
    opted_out_at: null,
    do_not_contact_at: null,
  };
  h.loadChannels.mockResolvedValue([CHANNEL]);
  h.sendText.mockResolvedValue({ messageId: 'w1' });
  h.check.mockResolvedValue({ blocked: false });
  h.sendTemplate.mockResolvedValue({ messageId: 'w2' });
  h.checkSend.mockResolvedValue({
    allow: true,
    reason: 'ALLOWED',
    enforced: false,
  });
  h.refund.mockResolvedValue(true);
});

const META = { id: 'n1', provider: 'meta', isPersonal: false };
const HELD = {
  accountId: 'a1',
  scope: 'wa.marketing.daily',
  day: '2026-11-22',
  micros: 5,
};

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

  it('stamps the row right before the gateway, for its own claim', async () => {
    await sendCaseCsat(db(), CLAIM);
    expect(h.handoff).toHaveBeenCalledWith('case_csat_handoff', {
      p_id: 'r1',
      p_claimed_at: CLAIM.claimedAt,
    });
    expect(h.check.mock.invocationCallOrder[0]!).toBeLessThan(
      h.handoff.mock.invocationCallOrder[0]!
    );
    expect(h.handoff.mock.invocationCallOrder[0]!).toBeLessThan(
      h.sendText.mock.invocationCallOrder[0]!
    );
  });

  it('sends nothing for a claim lost meanwhile', async () => {
    h.handoff.mockResolvedValue({ data: false, error: null });
    expect(await sendCaseCsat(db(), CLAIM)).toEqual({ outcome: 'lost' });
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('holds, sending nothing, when the stamp fails twice', async () => {
    h.handoff.mockResolvedValue({ data: null, error: { code: '57014' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendCaseCsat(db(), CLAIM)).toEqual({
      outcome: 'held',
      reason: 'lookup_failed',
    });
    log.mockRestore();
    expect(h.handoff).toHaveBeenCalledTimes(2);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('sends without a stamp before 281', async () => {
    h.handoff.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    expect(await sendCaseCsat(db(), CLAIM)).toMatchObject({ outcome: 'sent' });
  });

  it('a timeout is unconfirmed with its message row, and not tried again', async () => {
    h.sendText.mockRejectedValue(new TypeError('timed out'));
    expect(await sendCaseCsat(db(), CLAIM)).toEqual({
      outcome: 'unconfirmed',
      via: 'text',
      messageId: 'm1',
      reason: 'typeerror',
    });
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      message_id: null,
      status: 'sending',
      sender_type: 'bot',
    });
  });

  it('a definite refusal is a refusal, with no message row', async () => {
    h.definite = true;
    h.sendText.mockRejectedValue(new TypeError('bad token'));
    await expect(sendCaseCsat(db(), CLAIM)).rejects.toMatchObject({
      name: 'CsatRefusal',
      code: 'typeerror',
    });
    expect(h.inserted).toEqual([]);
  });

  it('holds when the numbers cannot be read; refuses one not connected', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.loadChannels.mockRejectedValue(
      new ChannelError('channel_lookup_failed', '', 500)
    );
    expect(await sendCaseCsat(db(), CLAIM)).toMatchObject({ outcome: 'held' });
    log.mockRestore();
    h.loadChannels.mockResolvedValue([]);
    await expect(sendCaseCsat(db(), CLAIM)).rejects.toMatchObject({
      code: 'not_connected',
    });
  });
});

describe('sendCaseCsat send guard', () => {
  beforeEach(() => {
    h.loadChannels.mockResolvedValue([META]);
  });

  it('asks the guard for the utility template, then sends while enforce is off', async () => {
    const d = db();
    // Watch mode: the guard would refuse, but only `allow` counts.
    h.checkSend.mockResolvedValue({
      allow: true,
      reason: 'TEMPLATE_PAUSED',
      enforced: false,
    });
    expect(await sendCaseCsat(d, CLAIM)).toMatchObject({
      outcome: 'sent',
      via: 'template',
      providerMessageId: 'w2',
    });
    expect(h.checkSend).toHaveBeenCalledWith(d, {
      accountId: 'a1',
      configId: 'n1',
      contactId: 'c1',
      kind: 'UTILITY',
      templateName: 'case_csat_approved',
    });
    expect(h.checkSend.mock.invocationCallOrder[0]!).toBeLessThan(
      h.handoff.mock.invocationCallOrder[0]!
    );
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('does not ask the guard for a text request', async () => {
    h.loadChannels.mockResolvedValue([CHANNEL]);
    await sendCaseCsat(db(), CLAIM);
    expect(h.checkSend).not.toHaveBeenCalled();
  });

  it('holds a paused template with the guard reason, sending and stamping nothing', async () => {
    h.checkSend.mockResolvedValue({
      allow: false,
      reason: 'TEMPLATE_PAUSED',
      enforced: true,
    });
    expect(await sendCaseCsat(db(), CLAIM)).toEqual({
      outcome: 'held',
      reason: 'template_paused',
    });
    expect(h.handoff).not.toHaveBeenCalled();
    expect(h.sendTemplate).not.toHaveBeenCalled();
    expect(h.inserted).toEqual([]);
  });

  it.each([
    ['OPTED_OUT', 'opted_out'],
    ['TOTAL_BLOCK', 'total_block'],
  ])('refuses on %s, sending nothing', async (reason, code) => {
    h.checkSend.mockResolvedValue({ allow: false, reason, enforced: true });
    await expect(sendCaseCsat(db(), CLAIM)).rejects.toMatchObject({
      name: 'CsatRefusal',
      code,
    });
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it('gives held spend back on a definite refusal only', async () => {
    h.checkSend.mockResolvedValue({
      allow: true,
      reason: 'ALLOWED',
      enforced: true,
      reservation: HELD,
    });
    h.definite = true;
    h.sendTemplate.mockRejectedValue(new TypeError('bad token'));
    await expect(sendCaseCsat(db(), CLAIM)).rejects.toMatchObject({
      name: 'CsatRefusal',
    });
    expect(h.refund).toHaveBeenCalledWith(expect.anything(), HELD);
    h.refund.mockClear();
    h.definite = false;
    h.sendTemplate.mockRejectedValue(new Error('timeout'));
    expect(await sendCaseCsat(db(), CLAIM)).toMatchObject({
      outcome: 'unconfirmed',
    });
    expect(h.refund).not.toHaveBeenCalled();
  });
});
