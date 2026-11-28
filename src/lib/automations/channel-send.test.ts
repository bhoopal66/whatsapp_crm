import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  resolveBotChannel: vi.fn(),
  assertAutoStart: vi.fn(),
  checkSend: vi.fn(),
  refund: vi.fn(),
  isDefinite: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
}));

vi.mock('@/lib/whatsapp/provider', () => ({
  sendText: h.sendText,
  sendTemplate: h.sendTemplate,
  isDefiniteSendRefusal: h.isDefinite,
}));
vi.mock('@/lib/whatsapp/meta-health/check-send', () => ({
  checkSend: h.checkSend,
  refundSendReservation: h.refund,
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: () =>
    Promise.resolve({
      row: { name: 'promo', category: 'Marketing', body_text: 'Hi' },
      malformed: false,
      language: 'en_US',
    }),
  templateContentText: () => 'Hi',
}));
vi.mock('@/lib/flows/channel-send', () => ({
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  resolveBotChannel: h.resolveBotChannel,
}));
vi.mock('@/lib/team-activity/auto-guard', () => ({
  assertAutoStartAllowed: h.assertAutoStart,
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

import {
  engineSendText,
  engineSendTemplate,
  templateSendKind,
} from './channel-send';

const OPENWA = { id: 'ch-openwa', provider: 'openwa' };

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'Hello',
};

beforeEach(() => {
  h.inserts = [];
  h.sendText.mockResolvedValue({ messageId: 'wamid-1' });
  h.resolveBotChannel.mockResolvedValue(OPENWA);
  h.assertAutoStart.mockResolvedValue(undefined);
  h.sendTemplate.mockReset();
  h.sendTemplate.mockResolvedValue({ messageId: 'wamid-t' });
  h.checkSend.mockReset();
  h.checkSend.mockResolvedValue({
    allow: true,
    reason: 'ALLOWED',
    enforced: false,
  });
  h.refund.mockReset();
  h.refund.mockResolvedValue(true);
  h.isDefinite.mockReset();
  h.isDefinite.mockReturnValue(false);
});

describe('automation engineSendText and the number daily limit (migration 204)', () => {
  it('asks before sending, and sends when allowed', async () => {
    await engineSendText(ARGS);
    expect(h.assertAutoStart).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'conv-1',
      OPENWA,
      'automations'
    );
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });

  it('sends and records nothing when the start is refused', async () => {
    h.assertAutoStart.mockRejectedValue(new Error('at its daily limit'));
    await expect(engineSendText(ARGS)).rejects.toThrow('at its daily limit');
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });
});

const TEMPLATE_ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  templateName: 'promo',
  params: [],
};

const RESERVATION = {
  accountId: 'acct-1',
  scope: 'wa.marketing.daily',
  day: '2026-11-28',
  micros: 5000,
};

describe('automation template sends and the send guard', () => {
  it('maps the title-case category to the guard kind, unknown as marketing', () => {
    expect(templateSendKind('Marketing')).toBe('MARKETING');
    expect(templateSendKind('Utility')).toBe('UTILITY');
    expect(templateSendKind('Authentication')).toBe('AUTHENTICATION');
    expect(templateSendKind(null)).toBe('MARKETING');
  });

  it('asks the guard with the channel, contact, template and kind; watch mode sends as before', async () => {
    const r = await engineSendTemplate(TEMPLATE_ARGS);
    expect(h.checkSend).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct-1',
      configId: 'ch-openwa',
      contactId: 'contact-1',
      kind: 'MARKETING',
      templateName: 'promo',
    });
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
    expect(r.whatsapp_message_id).toBe('wamid-t');
    expect(h.inserts.map((i) => i.table)).toEqual(['messages']);
  });

  it('does not send or record a message when the guard refuses, and says why', async () => {
    h.checkSend.mockResolvedValue({
      allow: false,
      reason: 'RAMP_CAP_REACHED',
      deferUntil: '2026-11-29T00:00:00.000Z',
      enforced: true,
    });
    await expect(engineSendTemplate(TEMPLATE_ARGS)).rejects.toThrow(
      'send protection refused the send (RAMP_CAP_REACHED, retry after 2026-11-29T00:00:00.000Z)'
    );
    expect(h.sendTemplate).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it('refunds the held spend when the gateway certainly refused the send', async () => {
    h.checkSend.mockResolvedValue({
      allow: true,
      reason: 'ALLOWED',
      enforced: true,
      reservation: RESERVATION,
    });
    const refusal = new Error('HTTP 400: bad template');
    h.sendTemplate.mockRejectedValue(refusal);
    h.isDefinite.mockReturnValue(true);
    await expect(engineSendTemplate(TEMPLATE_ARGS)).rejects.toThrow(
      'bad template'
    );
    expect(h.isDefinite).toHaveBeenCalledWith(refusal);
    expect(h.refund).toHaveBeenCalledWith(expect.anything(), RESERVATION);
  });

  it('keeps the spend when the send outcome is unconfirmed', async () => {
    h.checkSend.mockResolvedValue({
      allow: true,
      reason: 'ALLOWED',
      enforced: true,
      reservation: RESERVATION,
    });
    h.sendTemplate.mockRejectedValue(new Error('HTTP 504: timeout'));
    h.isDefinite.mockReturnValue(false);
    await expect(engineSendTemplate(TEMPLATE_ARGS)).rejects.toThrow('timeout');
    expect(h.refund).not.toHaveBeenCalled();
  });

  it('never asks the guard for a free-text send', async () => {
    await engineSendText(ARGS);
    expect(h.checkSend).not.toHaveBeenCalled();
  });
});
