// What a delivery pass does between the first send and the last:
// opt-outs and quiet hours that begin meanwhile, and sends whose outcome
// nobody knows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeDb, type Row } from './broadcast.fake';

const sendTemplate = vi.fn();
vi.mock('./provider', async (orig) => ({
  ...(await orig<typeof import('./provider')>()),
  sendTemplate: (...args: unknown[]) => sendTemplate(...args),
}));
vi.mock('./encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: async () => ({ data: 0, error: null }) }),
}));

import {
  deliverBroadcast,
  OPTED_OUT_REASON,
  type BroadcastPlan,
} from './broadcast-core';
import { planBroadcastResume } from './broadcast-resume';
import { MetaError } from './meta-api';
import {
  SEND_UNCONFIRMED_REASON,
  SENT_NOT_RECORDED_REASON,
} from '@/lib/broadcasts/unconfirmed-send';

const QUIET = { start: '21:00', end: '08:00', tz: 'Asia/Dubai' };
const NOON = new Date('2026-11-23T08:00:00Z'); // 12:00 Dubai
const NIGHT = new Date('2026-11-23T17:00:00Z'); // 21:00 Dubai

function world(n: number, broadcast: Row = {}) {
  const pad = (i: number) => String(i).padStart(5, '0');
  const recipients: Row[] = Array.from({ length: n }, (_, i) => ({
    id: `r${pad(i)}`,
    broadcast_id: 'bc-1',
    contact_id: `c${pad(i)}`,
    status: 'pending',
    error_message: null,
    created_at: '2026-11-23T00:00:00Z',
    template_params: [],
    contact: { phone: `9715010${pad(i)}`, opted_out_at: null },
  }));
  const contacts: Row[] = recipients.map((r) => ({
    id: r.contact_id,
    account_id: 'acct-1',
    opted_out_at: null,
  }));
  const broadcasts: Row[] = [
    {
      id: 'bc-1',
      account_id: 'acct-1',
      status: 'sending',
      template_name: 'promo',
      template_language: 'en_US',
      quiet_hours: null,
      delivery_locked_at: null,
      ...broadcast,
    },
  ];
  const whatsapp_config: Row[] = [
    {
      id: 'cfg-1',
      account_id: 'acct-1',
      provider: 'meta',
      phone_number_id: 'pn-1',
      access_token: 'tok',
      is_primary: true,
      status: 'connected',
    },
  ];
  const message_templates: Row[] = [
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
  ];
  return {
    contacts,
    broadcast_recipients: recipients,
    broadcasts,
    whatsapp_config,
    message_templates,
  };
}

function planFor(
  w: ReturnType<typeof world>,
  extra: Partial<BroadcastPlan> = {}
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
    templateRow: { name: 'promo' } as BroadcastPlan['templateRow'],
    planned: w.broadcast_recipients.map((r) => ({
      recipientRowId: r.id as string,
      contactId: r.contact_id as string,
      phone: (r.contact as Row).phone as string,
      params: [],
    })),
    rejected: 0,
    skippedOptedOut: 0,
    ...extra,
  };
}

const statuses = (w: ReturnType<typeof world>) =>
  w.broadcast_recipients.map((r) => r.status);
const resume = (
  db: ReturnType<typeof fakeDb>,
  scope: 'pending' | 'failed' = 'pending'
) => planBroadcastResume(db, 'acct-1', 'bc-1', scope);

beforeEach(() => {
  vi.useFakeTimers({ now: NOON, shouldAdvanceTime: true });
  sendTemplate.mockReset();
  sendTemplate.mockImplementation(async () => ({ messageId: 'wamid.1' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('opt-out during a pass', () => {
  it('skips a customer who opted out after the plan was built', async () => {
    const w = world(3);
    sendTemplate.mockImplementationOnce(async () => {
      w.contacts[1].opted_out_at = '2026-11-23T08:00:01Z';
      return { messageId: 'wamid.1' };
    });
    await deliverBroadcast(fakeDb(w), planFor(w));

    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(statuses(w)).toEqual(['sent', 'failed', 'sent']);
    expect(w.broadcast_recipients[1].error_message).toBe(OPTED_OUT_REASON);
  });

  it('stops with the rest pending when the opt-out cannot be read', async () => {
    const w = world(3);
    let reads = 0;
    const db = fakeDb(w, {
      fail: ({ table }) =>
        table === 'contacts' && ++reads === 2 ? 'timeout' : null,
    });
    await deliverBroadcast(db, planFor(w));

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(statuses(w)).toEqual(['sent', 'pending', 'pending']);
    expect(w.broadcasts[0].status).toBe('sending');
  });
});

describe('quiet hours', () => {
  it('stops a pass they begin in, resumable', async () => {
    const w = world(3);
    sendTemplate.mockImplementationOnce(async () => {
      vi.setSystemTime(NIGHT);
      return { messageId: 'wamid.1' };
    });
    await deliverBroadcast(fakeDb(w), planFor(w, { quietHours: QUIET }));

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(statuses(w)).toEqual(['sent', 'pending', 'pending']);
    expect(w.broadcasts[0].status).toBe('sending');
    expect(w.broadcast_recipients[1].error_message).toContain('quiet hours');
  });

  it('refuses a Resume inside them, and carries them into the plan', async () => {
    const w = world(2, { quiet_hours: QUIET });
    const { plan } = await resume(fakeDb(w));
    expect(plan.quietHours).toEqual(QUIET);

    vi.setSystemTime(NIGHT);
    await expect(resume(fakeDb(w))).rejects.toMatchObject({
      code: 'quiet_hours',
      status: 400,
    });
  });
});

describe('sends whose outcome nobody knows', () => {
  it('fails an unanswered send, tries no other variant, and never retries it', async () => {
    const w = world(3);
    // The one error a second variant of the number is worth trying on.
    sendTemplate
      .mockRejectedValueOnce(new MetaError('not in allowed list', 504, 131030))
      .mockRejectedValueOnce(new MetaError('no such number', 400, 131026));
    const db = fakeDb(w);
    await deliverBroadcast(db, planFor(w));

    expect(sendTemplate).toHaveBeenCalledTimes(3);
    expect(statuses(w)).toEqual(['failed', 'failed', 'sent']);
    expect(w.broadcast_recipients[0].error_message).toBe(
      SEND_UNCONFIRMED_REASON
    );
    // Retry failed takes the refusal, not the unconfirmed send.
    const { plan } = await resume(db, 'failed');
    expect(plan.planned.map((r) => r.recipientRowId)).toEqual(['r00001']);
  });

  it('marks the row before the gateway is asked, and clears it after', async () => {
    const w = world(1);
    let duringSend: unknown;
    sendTemplate.mockImplementationOnce(async () => {
      duringSend = { ...w.broadcast_recipients[0] };
      return { messageId: 'wamid.1' };
    });
    await deliverBroadcast(fakeDb(w), planFor(w));

    expect(duringSend).toMatchObject({
      status: 'pending',
      error_message: SEND_UNCONFIRMED_REASON,
    });
    expect(w.broadcast_recipients[0]).toMatchObject({
      status: 'sent',
      error_message: null,
    });
  });

  it('never resends a row a restart caught mid-send', async () => {
    const w = world(2);
    w.broadcast_recipients[0].error_message = SEND_UNCONFIRMED_REASON;
    const { plan } = await resume(fakeDb(w));

    expect(plan.planned.map((r) => r.recipientRowId)).toEqual(['r00001']);
    expect(statuses(w)).toEqual(['failed', 'pending']);
  });

  it('refuses to plan when those rows cannot be settled', async () => {
    const w = world(2);
    const db = fakeDb(w, {
      fail: ({ table, patch }) =>
        table === 'broadcast_recipients' && patch ? 'timeout' : null,
    });
    await expect(resume(db)).rejects.toMatchObject({ code: 'internal' });
  });

  it('does not send when the mark cannot be written', async () => {
    const w = world(2);
    const db = fakeDb(w, {
      fail: ({ table, patch }) =>
        table === 'broadcast_recipients' && patch ? 'timeout' : null,
    });
    await deliverBroadcast(db, planFor(w));

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(statuses(w)).toEqual(['pending', 'pending']);
  });

  it('skips a row another pass sent, or is sending', async () => {
    const w = world(3);
    const plan = planFor(w);
    w.broadcast_recipients[0].status = 'sent';
    w.broadcast_recipients[1].error_message = SEND_UNCONFIRMED_REASON;
    await deliverBroadcast(fakeDb(w), plan);

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(statuses(w)).toEqual(['sent', 'pending', 'sent']);
  });

  it('stamps sent on the third try', async () => {
    const w = world(1);
    let tries = 0;
    const db = fakeDb(w, {
      fail: ({ table, patch }) =>
        table === 'broadcast_recipients' &&
        patch?.status === 'sent' &&
        ++tries < 3
          ? 'timeout'
          : null,
    });
    await deliverBroadcast(db, planFor(w));

    expect(tries).toBe(3);
    expect(w.broadcast_recipients[0]).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid.1',
    });
  });

  it('stops, and never resends, when a send cannot be recorded', async () => {
    const w = world(2);
    const db = fakeDb(w, {
      fail: ({ table, patch }) =>
        table === 'broadcast_recipients' && patch?.status === 'sent'
          ? 'timeout'
          : null,
    });
    await deliverBroadcast(db, planFor(w));

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(w.broadcast_recipients[0]).toMatchObject({
      status: 'failed',
      error_message: SENT_NOT_RECORDED_REASON,
    });
    expect(w.broadcast_recipients[0].whatsapp_message_id).toBeUndefined();
    expect(w.broadcast_recipients[1].status).toBe('pending');
    await expect(resume(db, 'failed')).rejects.toMatchObject({
      code: 'nothing_to_resume',
    });
  });
});
