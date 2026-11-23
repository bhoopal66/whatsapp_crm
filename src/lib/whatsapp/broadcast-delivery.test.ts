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
