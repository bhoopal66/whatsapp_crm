import { readFileSync } from 'node:fs';
// What a delivery pass does between the first send and the last:
// opt-outs and quiet hours that begin meanwhile, and sends whose outcome
// nobody knows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeDb, type Row } from './broadcast.fake';

const sendTemplate = vi.fn();
// The secrets come through the service role (migration 285).
vi.mock('@/lib/whatsapp/channel-secrets', () => ({
  withChannelSecrets: async (rows: Array<{ id: string }>) =>
    rows.map((r) => ({ access_token: 'tok', app_secret: null, ...r })),
}));
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
  finalizeBroadcastStatus,
  OPTED_OUT_REASON,
  type BroadcastPlan,
} from './broadcast-core';
import { runBroadcastPass } from './broadcast-pass';
import { markBroadcastSending, planBroadcastResume } from './broadcast-resume';
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

describe('do-not-contact', () => {
  const DNC = 'Customer is marked do-not-contact';

  it('skips a customer marked after the plan was built', async () => {
    const w = world(2);
    w.contacts[1].do_not_contact_at = '2026-11-23T08:00:01Z';
    await deliverBroadcast(fakeDb(w), planFor(w));

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(w.broadcast_recipients[1]).toMatchObject({
      status: 'failed',
      error_message: DNC,
    });
  });

  it('leaves them out of a resume', async () => {
    const w = world(3);
    (w.broadcast_recipients[0].contact as Row).opted_out_at = '2026';
    (w.broadcast_recipients[1].contact as Row).do_not_contact_at = '2026';
    const { plan, remaining, optedOut } = await resume(fakeDb(w));

    expect(plan.planned.map((r) => r.recipientRowId)).toEqual(['r00002']);
    expect([optedOut, plan.skippedOptedOut, remaining]).toEqual([2, 2, 0]);
    expect(w.broadcast_recipients.map((r) => r.error_message)).toEqual([
      OPTED_OUT_REASON,
      DNC,
      null,
    ]);
  });
});

describe('frequency cap at delivery', () => {
  /** A row of another campaign for the second customer. */
  const other = (w: ReturnType<typeof world>, row: Row) =>
    w.broadcast_recipients.push({
      id: 'other',
      broadcast_id: 'bc-2',
      contact_id: 'c00001',
      ...row,
    });
  const capped = async (row: Row, skipRecentDays: number | null = 7) => {
    const w = world(2, { skip_recent_days: skipRecentDays });
    const { plan } = await resume(fakeDb(w));
    other(w, row);
    await deliverBroadcast(fakeDb(w), plan);
    return w.broadcast_recipients.slice(0, 2);
  };

  it('skips a customer another campaign messaged after this one was built', async () => {
    const rows = await capped({
      status: 'delivered',
      sent_at: '2026-11-17T08:00:00.000Z',
    });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.status)).toEqual(['sent', 'failed']);
    expect(rows[1].error_message).toBe(
      'Skipped: messaged by another campaign in the last 7 days'
    );
  });

  it.each([
    ['before the window', 'sent', '2026-11-16T07:59:59.000Z', 7],
    ['failed', 'failed', '2026-11-22T08:00:00.000Z', 7],
    ['pending', 'pending', null, 7],
    ['a campaign without a cap', 'sent', '2026-11-22T08:00:00.000Z', null],
  ])('sends: %s', async (_name, status, sent_at, days) => {
    const rows = await capped({ status, sent_at }, days);
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('does not count what this campaign sent itself', async () => {
    const rows = await capped({
      broadcast_id: 'bc-1',
      status: 'sent',
      sent_at: '2026-11-22T08:00:00.000Z',
    });
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('stops with the rest pending when it cannot be read', async () => {
    const w = world(2);
    let reads = 0;
    const db = fakeDb(w, {
      fail: ({ table, patch }) =>
        table === 'broadcast_recipients' && !patch && ++reads === 1
          ? 'timeout'
          : null,
    });
    await deliverBroadcast(db, planFor(w, { skipRecentDays: 7 }));

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(statuses(w)).toEqual(['pending', 'pending']);
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
    // Kept, so that its receipt can correct the row (migration 291).
    expect(w.broadcast_recipients[0].whatsapp_message_id).toBe('wamid.1');
    expect(w.broadcast_recipients[1].status).toBe('pending');
    await expect(resume(db, 'failed')).rejects.toMatchObject({
      code: 'nothing_to_resume',
    });
  });
});

describe('finalizing on unreadable counts', () => {
  it.each([1, 2, 3])(
    'leaves the status alone when count %i fails',
    async (n) => {
      const w = world(2);
      for (const r of w.broadcast_recipients) r.status = 'sent';
      let reads = 0;
      const db = fakeDb(w, {
        fail: ({ table }) =>
          table === 'broadcast_recipients' && ++reads === n ? 'timeout' : null,
      });
      await finalizeBroadcastStatus(db, 'bc-1');
      expect(w.broadcasts[0].status).toBe('sending');

      await finalizeBroadcastStatus(db, 'bc-1');
      expect(w.broadcasts[0].status).toBe('sent');
    }
  );

  it('leaves the status alone when a count is missing', async () => {
    const w = world(2);
    const real = fakeDb(w);
    const db = {
      from: (table: string) =>
        table === 'broadcasts'
          ? real.from(table)
          : {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              then: (ok: (r: unknown) => unknown) =>
                ok({ count: null, error: null }),
            },
    } as unknown as ReturnType<typeof fakeDb>;
    await finalizeBroadcastStatus(db, 'bc-1');
    expect(w.broadcasts[0].status).toBe('sending');
  });
});

describe('more than 1,000 recipients', () => {
  it('reports what one load cannot see as remaining', async () => {
    const w = world(2300);
    const { plan, remaining } = await resume(fakeDb(w));
    expect(plan.planned).toHaveLength(1000);
    expect(remaining).toBe(1300);
  });

  it('reads on past a first page that all opted out', async () => {
    const w = world(2300);
    for (const r of w.broadcast_recipients.slice(0, 1000)) {
      (r.contact as Row).opted_out_at = '2026-11-22T00:00:00Z';
    }
    (w.broadcast_recipients[1000].contact as Row).phone = null;
    const { plan, remaining, optedOut, unsendable } = await resume(fakeDb(w));

    expect(plan.planned).toHaveLength(1000);
    expect(plan.planned[0].recipientRowId).toBe('r01001');
    expect(new Set(plan.planned.map((r) => r.recipientRowId)).size).toBe(1000);
    expect([optedOut, unsendable, remaining]).toEqual([1000, 1, 299]);
    expect(statuses(w).filter((s) => s === 'failed')).toHaveLength(1001);
  });

  it('refuses to plan on an unreadable count', async () => {
    const w = world(2);
    let asked = 0;
    const db = fakeDb(w, {
      // 1 is the sweep of unconfirmed sends.
      fail: ({ table }) =>
        table === 'broadcast_recipients' && ++asked === 2 ? 'timeout' : null,
    });
    await expect(resume(db)).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('keeping the delivery lock', () => {
  const TOKEN = '2026-11-23T07:59:59.000Z';
  const OTHER = '2026-11-23T08:00:00.500Z';

  /** Runs a pass holding TOKEN; the sends made when the lock was written. */
  async function pass(
    w: ReturnType<typeof world>,
    fail?: (patch: Row | null) => string | null
  ) {
    const lockWrites: [sends: number, value: unknown][] = [];
    const db = fakeDb(w, {
      fail: ({ patch }) => fail?.(patch) ?? null,
      onUpdate: (table, patch) => {
        if (table === 'broadcasts' && 'delivery_locked_at' in patch) {
          lockWrites.push([
            sendTemplate.mock.calls.length,
            patch.delivery_locked_at,
          ]);
        }
      },
    });
    await runBroadcastPass(db, planFor(w), TOKEN);
    return lockWrites;
  }
  const held = (n: number) => world(n, { delivery_locked_at: TOKEN });

  it('refreshes it every 20 sends, and releases what it last wrote', async () => {
    const w = held(45);
    const writes = await pass(w);

    expect(writes.map(([sends]) => sends)).toEqual([20, 40, 45]);
    expect(writes.map(([, value]) => value)).toEqual([
      expect.any(String),
      expect.any(String),
      null,
    ]);
    expect(w.broadcasts[0]).toMatchObject({
      status: 'sent',
      delivery_locked_at: null,
    });
  });

  it('refreshes it after 5 minutes, however few were sent', async () => {
    const w = held(3);
    sendTemplate.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
      return { messageId: 'wamid.1' };
    });
    const writes = await pass(w);
    expect(writes.map(([sends]) => sends)).toEqual([1, 3]);
  });

  it('stops at a lock another pass took, and leaves it the campaign', async () => {
    const w = held(22);
    sendTemplate.mockImplementation(async () => {
      if (sendTemplate.mock.calls.length === 20) {
        w.broadcasts[0].delivery_locked_at = OTHER;
        // The other pass has sent the rest: finalizing would settle it.
        for (const r of w.broadcast_recipients.slice(20)) r.status = 'sent';
      }
      return { messageId: 'wamid.1' };
    });
    expect(await pass(w)).toEqual([]);

    expect(sendTemplate).toHaveBeenCalledTimes(20);
    expect(w.broadcasts[0]).toMatchObject({
      status: 'sending',
      delivery_locked_at: OTHER,
    });
  });

  it('stops when a refresh cannot be confirmed', async () => {
    const w = held(22);
    await pass(w, (patch) => (patch?.delivery_locked_at ? 'timeout' : null));

    expect(sendTemplate).toHaveBeenCalledTimes(20);
    expect(statuses(w).slice(20)).toEqual(['pending', 'pending']);
    expect(w.broadcasts[0].status).toBe('sending');
  });

  it('never releases a lock another pass holds', async () => {
    const w = held(1);
    sendTemplate.mockImplementationOnce(async () => {
      w.broadcasts[0].delivery_locked_at = OTHER;
      return { messageId: 'wamid.1' };
    });
    await pass(w);
    expect(w.broadcasts[0].delivery_locked_at).toBe(OTHER);
  });
});

describe('planning while the database does not answer', () => {
  it.each(['broadcasts', 'whatsapp_config'])(
    'says internal when %s cannot be read',
    async (broken) => {
      const db = fakeDb(world(1), {
        fail: ({ table }) => (table === broken ? 'timeout' : null),
      });
      await expect(resume(db)).rejects.toMatchObject({ code: 'internal' });
    }
  );
});

describe('Stop (migration 301)', () => {
  beforeEach(() => {
    sendTemplate.mockReset();
  });

  it('holds for a pass already running: the rest stay pending', async () => {
    const w = world(3);
    sendTemplate.mockImplementation(async () => {
      w.broadcasts[0].status = 'stopped';
      return { messageId: 'wamid.1' };
    });
    await deliverBroadcast(fakeDb(w), planFor(w));
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(w.broadcast_recipients.map((r) => r.status)).toEqual([
      'sent',
      'pending',
      'pending',
    ]);
    expect(w.broadcast_recipients[1].error_message).toBeNull();
    expect(w.broadcasts[0].status).toBe('stopped');
  });

  it.each([
    ['finished meanwhile', 'sent', null],
    ['not readable', 'sending', 'timeout'],
  ])(
    'ends the pass when nothing could be marked and it is %s',
    async (_, status, failRead) => {
      const w = world(4);
      let marking = false;
      const db = fakeDb(w, {
        fail: ({ table }) => {
          if (table !== 'broadcasts' || !marking) return null;
          return failRead;
        },
      });
      const marked: string[] = [];
      const from = db.from.bind(db);
      // Every mark matches nothing: the trigger of 301, or another pass.
      db.from = ((table: string) => {
        const q = from(table) as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        if (table !== 'broadcast_recipients') return q;
        const update = q.update.bind(q);
        q.update = (patch: unknown) => {
          const text = (patch as Row).error_message;
          if (typeof text === 'string' && text.startsWith('May have been')) {
            marking = true;
            marked.push(text);
            w.broadcasts[0].status = status;
            return (update({ ...(patch as Row) }) as typeof q).eq('id', 'none');
          }
          return update(patch);
        };
        return q;
      }) as unknown as typeof db.from;
      await deliverBroadcast(db, planFor(w));
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(marked).toHaveLength(1);
    }
  );

  it('is undone by its own Resume only', async () => {
    const w = world(2, { status: 'stopped' });
    const db = fakeDb(w);
    const refused = { code: 'campaign_stopped', status: 400 };
    await expect(
      planBroadcastResume(db, 'acct-1', 'bc-1', 'pending')
    ).rejects.toMatchObject(refused);
    // Stopped after the plan was made.
    await expect(markBroadcastSending(db, 'bc-1')).rejects.toMatchObject(
      refused
    );
    expect(w.broadcasts[0].status).toBe('stopped');

    const opts = { resumeStopped: true };
    const { plan } = await planBroadcastResume(
      db,
      'acct-1',
      'bc-1',
      'pending',
      opts
    );
    expect(plan.planned).toHaveLength(2);
    await markBroadcastSending(db, 'bc-1', opts);
    expect(w.broadcasts[0].status).toBe('sending');
  });

  it('the SQL guard names the write-ahead mark', () => {
    const sql = readFileSync(
      'supabase/migrations/301_campaign_stop.sql',
      'utf8'
    );
    expect(sql).toContain(`NEW.error_message = '${SEND_UNCONFIRMED_REASON}'`);
  });
});
