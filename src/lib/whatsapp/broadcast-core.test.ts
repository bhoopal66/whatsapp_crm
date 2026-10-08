import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  reconcileBroadcastStatuses,
  settleBroadcastAfterLateFailure,
  BroadcastError,
  type BroadcastPlan,
} from './broadcast-core';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));
const sendTemplate = vi.fn(async (_args: unknown) => ({
  messageId: 'wamid.1',
  provider: 'whapi',
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  sendTemplate: (args: unknown) => sendTemplate(args),
  describeSendFailure: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  // A channel-wide failure is marked on the thrown error by the tests.
  isChannelLevelFailure: (e: unknown) =>
    (e as { channelDown?: boolean } | null)?.channelDown === true,
}));
// The reconcile RPC (migration 066) goes through the service-role client.
const rpc = vi.fn<
  (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>
>(async () => ({ data: 0, error: null }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (name: string, args: unknown) => rpc(name, args),
  }),
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(
  rpcResult: { data: unknown; error: unknown },
  opts: {
    provider?: 'whapi' | 'meta';
    template?: Record<string, unknown>;
    /** Contact ids whose `opted_out_at` is set (migration 076). */
    optedOut?: string[];
  } = {}
) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        // `channels.ts` reads every channel on the account and picks
        // (migration 046), terminating on .order() rather than
        // .single(). One Whapi channel here, so the `broadcast` surface
        // resolves to it exactly as before.
        return {
          select: () => ({
            eq: () => ({
              order: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'cfg-1',
                      account_id: 'acct-1',
                      provider: opts.provider ?? 'whapi',
                      label: 'Support',
                      phone_number_id: 'pn-1',
                      waba_id: null,
                      access_token: 'enc',
                      app_secret: null,
                      is_primary: true,
                      mirror_inbound_media: true,
                      status: 'connected',
                    },
                  ],
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'whatsapp_routes') {
        // No explicit route -> the primary channel is used.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        // Under Whapi the template row IS the broadcast message, so a
        // plan can't be built without one.
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
            resolve({
              data: [
                {
                  id: 'tpl-1',
                  user_id: 'u-1',
                  name: 'welcome',
                  language: 'en_US',
                  body_text: 'Hello {{1}}',
                  ...opts.template,
                },
              ],
              error: null,
            }),
        };
        return chain;
      }
      if (table === 'contacts') {
        // The opted-out lookup: honours the id list and the
        // `opted_out_at IS NOT NULL` filter it is given.
        let ids: string[] = [];
        let notNull = false;
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: (_col: string, vals: string[]) => {
            ids = vals;
            return chain;
          },
          not: (col: string, op: string, val: unknown) => {
            notNull = col === 'opted_out_at' && op === 'is' && val === null;
            return chain;
          },
          then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
            resolve({
              data: ids
                .filter((id) => !notNull || (opts.optedOut ?? []).includes(id))
                .map((id) => ({ id })),
              error: null,
            }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Recipient numbers follow the contact-entry rule (validateContactPhone),
// not bare E.164: a 9-digit local UAE mobile passes /^\+?[1-9]\d{6,14}$/,
// is accepted by the gateway as 'sent' to nobody, and becomes a dead
// contact that later takes the customer's real inbound.
// ============================================================

describe('createBroadcast recipient numbers', () => {
  const created = {
    data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
    error: null,
  };

  it('rejects a local number and sends the valid one normalized', async () => {
    vi.mocked(findOrCreateContact).mockClear();
    const { db, calls } = makeDb(created);

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '504555843' }, { to: '+971 050 123 4567' }],
    });

    expect(plan.rejected).toBe(1);
    // No contact for the local number; the trunk 0 after +971 is gone.
    expect(findOrCreateContact).toHaveBeenCalledTimes(1);
    expect(findOrCreateContact).toHaveBeenCalledWith(db, 'acc', 'user', {
      phone: '971501234567',
    });
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '971501234567', params: [] },
    ]);
    expect(calls.rpc).toHaveLength(1);
  });

  it.each(['0501234567', '9.71505E+11', '+9715012345'])(
    'counts %s as rejected',
    async (to) => {
      const { db } = makeDb(created);
      const plan = await createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to }, { to: '+14155550123' }],
      });
      expect(plan.rejected).toBe(1);
    }
  );

  it('says what to fix when every recipient is rejected', async () => {
    vi.mocked(findOrCreateContact).mockClear();
    const { db, calls } = makeDb(created);

    const err = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '504555843' }, { to: '0501234567' }],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ code: 'bad_request', status: 400 });
    expect((err as Error).message).toBe(
      `No recipient had a valid phone number. 'recipients[0].to' "504555843" is too short. Include the country code, e.g. +971 50 123 4567`
    );
    expect(findOrCreateContact).not.toHaveBeenCalled();
    expect(calls.rpc).toHaveLength(0);
  });
});

// ============================================================
// Opt-outs (migration 076): a customer who asked not to be messaged
// gets no recipient row, so no pass of this campaign can reach them.
// ============================================================

describe('createBroadcast opted-out customers', () => {
  const byPhone: Record<string, string> = {
    '14155550123': 'c-ok',
    '14155550124': 'c-out',
  };
  // Back to the file-wide stub, even when a case fails midway.
  afterEach(() => {
    vi.mocked(findOrCreateContact).mockImplementation(async () => ({
      id: 'c1',
      created: false,
    }));
  });

  it('leaves an opted-out contact out of the recipients and counts it', async () => {
    vi.mocked(findOrCreateContact).mockImplementation(
      async (_db, _acc, _user, { phone }) => ({
        id: byPhone[phone],
        created: false,
      })
    );
    const { db, calls } = makeDb(
      {
        data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c-ok' }],
        error: null,
      },
      { optedOut: ['c-out'] }
    );

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
    });

    expect(calls.rpc[0].args).toMatchObject({
      p_total_recipients: 1,
      p_contact_ids: ['c-ok'],
    });
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
    expect(plan.skippedOptedOut).toBe(1);
    expect(plan.rejected).toBe(0);
  });

  it('refuses, persisting nothing, when every recipient opted out', async () => {
    vi.mocked(findOrCreateContact).mockImplementation(
      async () => ({ id: 'c-out', created: false })
    );
    const { db, calls } = makeDb(
      { data: [], error: null },
      { optedOut: ['c-out'] }
    );

    const err = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550124' }],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ code: 'bad_request', status: 400 });
    expect((err as Error).message).toMatch(/opted out/);
    expect(calls.rpc).toHaveLength(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});

describe('deliverBroadcast', () => {
  it('passes the campaign header media URL to every send (migration 053)', async () => {
    sendTemplate.mockClear();
    const updates: Record<string, unknown>[] = [];
    const db = {
      from: () => ({
        update: (payload: Record<string, unknown>) => {
          updates.push(payload);
          return { eq: async () => ({ error: null }) };
        },
        select: () => ({
          eq: () => ({
            eq: async () => ({ count: 0 }),
            then: (r: (v: { count: number }) => void) => r({ count: 1 }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const plan: BroadcastPlan = {
      broadcastId: 'bc-1',
      templateName: 'promo',
      templateLanguage: 'en_US',
      channelId: 'ch-1',
      channel: {
        id: 'ch-1',
        provider: 'whapi',
        phoneNumberId: 'ch-1',
        accessToken: 'tok',
      } as BroadcastPlan['channel'],
      templateRow: { name: 'promo', language: 'en_US' } as BroadcastPlan['templateRow'],
      headerMediaUrl: 'https://cdn.example.com/promo.jpg',
      planned: [{ recipientRowId: 'r1', phone: '15551234567', params: ['A'] }],
      rejected: 0,
      skippedOptedOut: 0,
    };

    await deliverBroadcast(db, plan);

    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '15551234567',
        bodyParams: ['A'],
        headerMediaUrl: 'https://cdn.example.com/promo.jpg',
      })
    );
    // error_message: null clears a reason an earlier stopped pass left.
    expect(updates[0]).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid.1',
      error_message: null,
    });
  });
});

describe('createBroadcast header media (Meta)', () => {
  const VIDEO = { header_type: 'video', name: 'pos_intro_offer_video', language: 'en' };

  it('refuses a media template with no media before anything is persisted', async () => {
    const { db, calls } = makeDb(
      { data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }], error: null },
      { provider: 'meta', template: VIDEO }
    );
    const err = await createBroadcast(db, 'acc', 'user', {
      templateName: 'pos_intro_offer_video',
      recipients: [{ to: '+14155550123' }],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ code: 'template_media_missing', status: 400 });
    expect((err as Error).message).toContain(
      'Template pos_intro_offer_video (en) has a video header but no media.'
    );
    // Once, at launch — not 1 000 identical per-recipient failures.
    expect(calls.rpc).toHaveLength(0);
  });

  it('lets it through when the template carries its media', async () => {
    const { db, calls } = makeDb(
      { data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }], error: null },
      {
        provider: 'meta',
        template: { ...VIDEO, header_media_url: 'https://cdn.example.com/v.mp4' },
      }
    );
    await createBroadcast(db, 'acc', 'user', {
      templateName: 'pos_intro_offer_video',
      recipients: [{ to: '+14155550123' }],
    });
    expect(calls.rpc).toHaveLength(1);
  });

  it('does not apply to Whapi, which renders the template as text', async () => {
    const { db, calls } = makeDb(
      { data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }], error: null },
      { provider: 'whapi', template: VIDEO }
    );
    await createBroadcast(db, 'acc', 'user', {
      templateName: 'pos_intro_offer_video',
      recipients: [{ to: '+14155550123' }],
    });
    expect(calls.rpc).toHaveLength(1);
  });
});

// ============================================================
// Delivery pass: circuit breaker and the receipt reconcile.
// ============================================================

function deliverDb(pending: number, events: string[]) {
  const recipientUpdates: {
    id: unknown;
    payload: Record<string, unknown>;
    /** The update's own status filter, when it has one. */
    whereStatus?: unknown;
  }[] = [];
  const db = {
    from(table: string) {
      let status: string | null = null;
      let payload: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (row: Record<string, unknown>) => {
          payload = row;
          return b;
        },
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          if (payload && table === 'broadcast_recipients' && col === 'id') {
            recipientUpdates.push({ id: val, payload });
          }
          if (payload && table === 'broadcast_recipients' && col === 'status') {
            recipientUpdates[recipientUpdates.length - 1].whereStatus = val;
          }
          if (payload && table === 'broadcasts') events.push('finalize');
          return b;
        },
        in: (col: string, vals: unknown) => {
          if (payload && table === 'broadcast_recipients' && col === 'status') {
            recipientUpdates[recipientUpdates.length - 1].whereStatus = vals;
          }
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === 'pending' ? pending : status === 'failed' ? 0 : 3,
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, recipientUpdates };
}

function plan3(): BroadcastPlan {
  return {
    broadcastId: 'bc-1',
    templateName: 'promo',
    templateLanguage: 'en_US',
    channelId: 'ch-1',
    channel: {
      id: 'ch-1',
      provider: 'whapi',
      phoneNumberId: 'ch-1',
      accessToken: 'tok',
    } as BroadcastPlan['channel'],
    templateRow: { name: 'promo', language: 'en_US' } as BroadcastPlan['templateRow'],
    planned: [
      { recipientRowId: 'r1', phone: '15551234567', params: [] },
      { recipientRowId: 'r2', phone: '15551234568', params: [] },
      { recipientRowId: 'r3', phone: '15551234569', params: [] },
    ],
    rejected: 0,
    skippedOptedOut: 0,
  };
}

describe('deliverBroadcast — channel-level failure', () => {
  it('stops the pass and leaves this and every later recipient pending', async () => {
    sendTemplate.mockReset();
    sendTemplate
      .mockResolvedValueOnce({ messageId: 'wamid.a', provider: 'whapi' })
      .mockRejectedValueOnce(
        Object.assign(new Error('HTTP 401: logged out'), { channelDown: true })
      );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: string[] = [];
    const { db, recipientUpdates } = deliverDb(2, events);

    await deliverBroadcast(db, plan3());

    // One gateway call for the failing number, none after it.
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    // r1 is stamped sent; r2 and r3 stay 'pending' for Resume, and r2,
    // the row that tripped the breaker, carries the reason (no status).
    expect(recipientUpdates).toEqual([
      { id: 'r1', payload: expect.objectContaining({ status: 'sent' }) },
      {
        id: 'r2',
        payload: { error_message: 'HTTP 401: logged out' },
        // 'failed' too: a Retry failed pass plans rows still 'failed',
        // and a pending-only filter recorded nothing when it stopped.
        // Never 'sent', which a concurrent pass may have stamped.
        whereStatus: ['pending', 'failed'],
      },
    ]);
    // Pending rows remain, so the campaign stays 'sending'.
    expect(events).not.toContain('finalize');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain('stopped after 1 of 3');
    logged.mockRestore();
    sendTemplate.mockReset();
    sendTemplate.mockResolvedValue({ messageId: 'wamid.1', provider: 'whapi' });
  });

  it('still marks a recipient failed for a per-recipient rejection', async () => {
    sendTemplate.mockReset();
    sendTemplate
      .mockRejectedValueOnce(new Error('Invalid parameter'))
      .mockResolvedValue({ messageId: 'wamid.b', provider: 'whapi' });
    const { db, recipientUpdates } = deliverDb(0, []);

    await deliverBroadcast(db, plan3());

    expect(sendTemplate).toHaveBeenCalledTimes(3);
    expect(recipientUpdates.map((u) => u.payload.status)).toEqual([
      'failed',
      'sent',
      'sent',
    ]);
    sendTemplate.mockReset();
    sendTemplate.mockResolvedValue({ messageId: 'wamid.1', provider: 'whapi' });
  });

  it('reconciles lost receipts for this campaign before finalizing', async () => {
    rpc.mockClear();
    const events: string[] = [];
    rpc.mockImplementationOnce(async () => {
      events.push('reconcile');
      return { data: 0, error: null };
    });
    const { db } = deliverDb(0, events);

    await deliverBroadcast(db, plan3());

    expect(rpc).toHaveBeenCalledWith('reconcile_broadcast_recipient_statuses', {
      p_broadcast_id: 'bc-1',
    });
    expect(events).toEqual(['reconcile', 'finalize']);
  });
});

describe('reconcileBroadcastStatuses', () => {
  it('returns the number of rows the function changed', async () => {
    rpc.mockResolvedValueOnce({ data: 7, error: null });
    expect(await reconcileBroadcastStatuses()).toBe(7);
    expect(rpc).toHaveBeenLastCalledWith(
      'reconcile_broadcast_recipient_statuses',
      { p_broadcast_id: null }
    );
  });

  it('passes a wider window through when asked', async () => {
    rpc.mockResolvedValueOnce({ data: 0, error: null });
    await reconcileBroadcastStatuses({ since: '30 days' });
    expect(rpc).toHaveBeenLastCalledWith(
      'reconcile_broadcast_recipient_statuses',
      { p_broadcast_id: null, p_since: '30 days' }
    );
  });

  it('skips quietly while migration 066 is not applied', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function does not exist' },
    });
    expect(await reconcileBroadcastStatuses()).toBeNull();
    expect(await reconcileBroadcastStatuses()).toBeNull();
    // One line per process, not one per tick.
    expect(warned.mock.calls.length).toBeLessThanOrEqual(1);
    expect(errored).not.toHaveBeenCalled();
    warned.mockRestore();
    errored.mockRestore();
  });

  it('never throws, whatever the RPC does', async () => {
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'boom' } });
    expect(await reconcileBroadcastStatuses()).toBeNull();
    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await reconcileBroadcastStatuses()).toBeNull();
    expect(errored).toHaveBeenCalledTimes(2);
    errored.mockRestore();
  });
});

// ============================================================
// A failure receipt after the pass that finalized the campaign.
// ============================================================

function settleDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown>; filters: Record<string, unknown> }
) {
  return {
    from(table: string) {
      let status: string | null = null;
      let updating = false;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (updating) writes.filters[col] = val;
          else if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') {
            writes.update = row;
            updating = true;
          }
          return b;
        },
        then: (resolve: (r: { count?: number; error: null }) => unknown) =>
          resolve(
            updating
              ? { error: null }
              : { count: status === null ? total : (counts[status] ?? 0), error: null }
          ),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('settleBroadcastAfterLateFailure', () => {
  it("fails a 'sent' campaign once every recipient has failed", async () => {
    const writes = { filters: {} as Record<string, unknown> } as {
      update?: Record<string, unknown>;
      filters: Record<string, unknown>;
    };
    await settleBroadcastAfterLateFailure(
      settleDb({ pending: 0, failed: 12 }, 12, writes),
      'b-1'
    );
    expect(writes.update?.status).toBe('failed');
    // Only from 'sent': a campaign still sending or scheduled is not
    // this receipt's to settle.
    expect(writes.filters).toEqual({ id: 'b-1', status: 'sent' });
  });

  it('leaves a campaign where anyone was reached', async () => {
    const writes = { filters: {} } as {
      update?: Record<string, unknown>;
      filters: Record<string, unknown>;
    };
    await settleBroadcastAfterLateFailure(
      settleDb({ pending: 0, failed: 11 }, 12, writes),
      'b-1'
    );
    expect(writes.update).toBeUndefined();
  });

  it('leaves a campaign with recipients still pending', async () => {
    const writes = { filters: {} } as {
      update?: Record<string, unknown>;
      filters: Record<string, unknown>;
    };
    await settleBroadcastAfterLateFailure(
      settleDb({ pending: 1, failed: 11 }, 12, writes),
      'b-1'
    );
    expect(writes.update).toBeUndefined();
  });

  it('never throws on the webhook path', async () => {
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      from() {
        throw new Error('db down');
      },
    } as unknown as SupabaseClient;
    await expect(
      settleBroadcastAfterLateFailure(broken, 'b-1')
    ).resolves.toBeUndefined();
    errored.mockRestore();
  });
});
