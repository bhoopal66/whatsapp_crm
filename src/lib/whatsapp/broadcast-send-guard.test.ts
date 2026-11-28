// The send guard (meta-health/check-send.ts) asked before each campaign
// recipient: watch mode changes nothing, an enforced refusal fails the
// one recipient, the daily ramp stops the pass for a Resume, and held
// marketing spend is given back when the message certainly did not go.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeDb, type Row } from './broadcast.fake';
import type * as CheckSendModule from './meta-health/check-send';

const sendTemplate = vi.fn();
vi.mock('@/lib/whatsapp/channel-secrets', () => ({
  withChannelSecrets: async (rows: Array<{ id: string }>) =>
    rows.map((r) => ({ access_token: 'tok', app_secret: null, ...r })),
}));
vi.mock('./provider', async (orig) => ({
  ...(await orig<typeof import('./provider')>()),
  sendTemplate: (...args: unknown[]) => sendTemplate(...args),
}));
vi.mock('./encryption', () => ({ decrypt: (v: string) => v }));
// Every RPC answers 0, so the guard's settings read as enforce off.
const adminRpc = vi.fn<
  (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>
>(async () => ({ data: 0, error: null }));
const admin = { rpc: adminRpc };
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => admin }));

const checkSend = vi.fn();
const refund = vi.fn<(...args: unknown[]) => Promise<boolean>>(
  async () => true
);
vi.mock('./meta-health/check-send', async (orig) => {
  return {
    ...(await orig<typeof CheckSendModule>()),
    checkSend: (...args: unknown[]) => checkSend(...args),
    refundSendReservation: (...args: unknown[]) => refund(...args),
  };
});

import {
  deliverBroadcast,
  SEND_PROTECTION_RAMP_MESSAGE,
  sendProtectionReason,
  type BroadcastPlan,
} from './broadcast-core';
import { planBroadcastResume } from './broadcast-resume';
import { MetaError } from './meta-api';
import { SEND_UNCONFIRMED_REASON } from '@/lib/broadcasts/unconfirmed-send';

function world(n: number) {
  const recipients: Row[] = Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    broadcast_id: 'bc-1',
    contact_id: `c${i}`,
    status: 'pending',
    error_message: null,
    created_at: '2026-11-23T00:00:00Z',
    template_params: [],
    contact: { phone: `97150100000${i}`, opted_out_at: null },
  }));
  return {
    contacts: recipients.map((r) => ({
      id: r.contact_id,
      account_id: 'acct-1',
      opted_out_at: null,
    })),
    broadcast_recipients: recipients,
    broadcasts: [
      {
        id: 'bc-1',
        account_id: 'acct-1',
        status: 'sending',
        template_name: 'promo',
        template_language: 'en_US',
        quiet_hours: null,
        delivery_locked_at: null,
      },
    ] as Row[],
    whatsapp_config: [
      {
        id: 'cfg-1',
        account_id: 'acct-1',
        provider: 'meta',
        phone_number_id: 'pn-1',
        access_token: 'tok',
        is_primary: true,
        status: 'connected',
      },
    ] as Row[],
    message_templates: [
      {
        id: 't-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        name: 'promo',
        language: 'en_US',
        category: 'Marketing',
        body_text: 'Hi',
        status: 'APPROVED',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ] as Row[],
  };
}

function planFor(
  w: ReturnType<typeof world>,
  category = 'Marketing'
): BroadcastPlan {
  return {
    broadcastId: 'bc-1',
    templateName: 'promo',
    templateLanguage: 'en_US',
    channelId: 'pn-1',
    channel: {
      id: 'cfg-1',
      accountId: 'acct-1',
      provider: 'meta',
    } as BroadcastPlan['channel'],
    templateRow: { name: 'promo', category } as BroadcastPlan['templateRow'],
    planned: w.broadcast_recipients.map((r) => ({
      recipientRowId: r.id as string,
      contactId: r.contact_id as string,
      phone: (r.contact as Row).phone as string,
      params: [],
    })),
    rejected: 0,
    skippedOptedOut: 0,
  };
}

const statuses = (w: ReturnType<typeof world>) =>
  w.broadcast_recipients.map((r) => r.status);

const HELD = {
  accountId: 'acct-1',
  scope: 'wa.marketing.daily' as const,
  day: '2026-11-23',
  micros: 5000,
};
const allowHeld = {
  allow: true,
  reason: 'ALLOWED',
  enforced: true,
  reservation: HELD,
};

beforeEach(() => {
  sendTemplate.mockReset();
  sendTemplate.mockImplementation(async () => ({ messageId: 'wamid.1' }));
  checkSend.mockReset();
  refund.mockClear();
  adminRpc.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the send guard before each broadcast recipient', () => {
  it('enforce off: asks the real guard per recipient, sends everyone as before', async () => {
    const real = await vi.importActual<typeof CheckSendModule>(
      './meta-health/check-send'
    );
    checkSend.mockImplementation(real.checkSend);
    const w = world(3);
    await deliverBroadcast(fakeDb(w), planFor(w));

    expect(statuses(w)).toEqual(['sent', 'sent', 'sent']);
    expect(sendTemplate).toHaveBeenCalledTimes(3);
    const logged = adminRpc.mock.calls.filter(
      ([n]) => n === 'send_protection_decision_record'
    );
    expect(logged).toHaveLength(3);
    expect(logged[0][1]).toMatchObject({
      p_account: 'acct-1',
      p_config: 'cfg-1',
      p_contact: 'c0',
      p_kind: 'MARKETING',
      p_template: 'promo',
      p_enforced: false,
    });
  });

  it.each([
    ['Utility', 'UTILITY'],
    ['Authentication', 'AUTHENTICATION'],
    ['Marketing', 'MARKETING'],
  ])('asks for a %s template as %s', async (category, kind) => {
    checkSend.mockResolvedValue({ allow: true, reason: 'ALLOWED' });
    const w = world(1);
    await deliverBroadcast(fakeDb(w), planFor(w, category));
    expect(checkSend).toHaveBeenCalledWith(admin, {
      accountId: 'acct-1',
      configId: 'cfg-1',
      contactId: 'c0',
      kind,
      templateName: 'promo',
    });
  });

  it('an enforced refusal fails that recipient with the reason and goes on', async () => {
    checkSend
      .mockResolvedValueOnce({
        allow: false,
        reason: 'TEMPLATE_PAUSED',
        enforced: true,
      })
      .mockResolvedValue({ allow: true, reason: 'ALLOWED', enforced: true });
    const w = world(3);
    await deliverBroadcast(fakeDb(w), planFor(w));

    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(statuses(w)).toEqual(['failed', 'sent', 'sent']);
    expect(w.broadcast_recipients[0].error_message).toBe(
      sendProtectionReason('TEMPLATE_PAUSED')
    );
  });

  it('the daily ramp stops the pass, the rest pending for Resume', async () => {
    checkSend.mockResolvedValueOnce(allowHeld).mockResolvedValue({
      allow: false,
      reason: 'RAMP_CAP_REACHED',
      deferUntil: '2026-11-24T00:00:00.000Z',
      enforced: true,
    });
    const w = world(3);
    const db = fakeDb(w);
    await deliverBroadcast(db, planFor(w));

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    // Asked once for the stop, not once per remaining recipient.
    expect(checkSend).toHaveBeenCalledTimes(2);
    expect(statuses(w)).toEqual(['sent', 'pending', 'pending']);
    expect(w.broadcast_recipients[1].error_message).toBe(
      SEND_PROTECTION_RAMP_MESSAGE
    );
    expect(w.broadcasts[0].status).toBe('sending');
    const { plan } = await planBroadcastResume(db, 'acct-1', 'bc-1', 'pending');
    expect(plan.planned.map((r) => r.recipientRowId)).toEqual(['r1', 'r2']);
  });

  it('stops with everyone pending when the guard itself throws', async () => {
    checkSend.mockRejectedValue(new Error('boom'));
    const w = world(2);
    await deliverBroadcast(fakeDb(w), planFor(w));
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(statuses(w)).toEqual(['pending', 'pending']);
  });
});

describe('giving held spend back', () => {
  it('keeps it on a send that went out', async () => {
    checkSend.mockResolvedValue(allowHeld);
    const w = world(1);
    await deliverBroadcast(fakeDb(w), planFor(w));
    expect(statuses(w)).toEqual(['sent']);
    expect(refund).not.toHaveBeenCalled();
  });

  it('refunds a definite refusal', async () => {
    checkSend.mockResolvedValue(allowHeld);
    sendTemplate.mockRejectedValueOnce(new MetaError('x', 400, 131026));
    const w = world(1);
    await deliverBroadcast(fakeDb(w), planFor(w));
    expect(statuses(w)).toEqual(['failed']);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(admin, HELD);
  });

  it('keeps it on an unconfirmed send', async () => {
    checkSend.mockResolvedValue(allowHeld);
    sendTemplate.mockRejectedValueOnce(
      new MetaError('not in allowed list', 504, 131030)
    );
    const w = world(1);
    await deliverBroadcast(fakeDb(w), planFor(w));
    expect(w.broadcast_recipients[0].error_message).toBe(
      SEND_UNCONFIRMED_REASON
    );
    expect(refund).not.toHaveBeenCalled();
  });

  it('refunds on a channel failure', async () => {
    checkSend.mockResolvedValue(allowHeld);
    sendTemplate.mockRejectedValue(new MetaError('x', 403, 131031));
    const w = world(2);
    await deliverBroadcast(fakeDb(w), planFor(w));
    expect(statuses(w)).toEqual(['pending', 'pending']);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(admin, HELD);
  });

  it('refunds when the write-ahead mark matches nothing', async () => {
    checkSend.mockResolvedValue(allowHeld);
    const w = world(1);
    // Another pass sent it after this plan was built.
    w.broadcast_recipients[0].status = 'sent';
    await deliverBroadcast(fakeDb(w), planFor(w));
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(admin, HELD);
  });
});
