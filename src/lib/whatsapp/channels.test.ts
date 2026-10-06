import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ChannelError,
  describeChannel,
  isRoutingSurface,
  loadChannels,
  loadWhapiChannelsForHealth,
  pickByProvider,
  pickChannelForUser,
  primaryChannel,
  resolveAiReplyChannel,
  resolveBotChannel,
  resolveChannelByProvider,
  resolveChannelForSurface,
  resolveReplyChannel,
  resolveSendChannel,
  isWhatsAppProvider,
  ROUTING_SURFACES,
  type WhatsAppChannel,
} from './channels';
import { encrypt } from './encryption';

// ------------------------------------------------------------
// Chainable Supabase stub scripted per table, in the style of
// resolve-conversation.test.ts. `whatsapp_config` terminates on the
// awaited builder, `whatsapp_routes` and `messages` on maybeSingle().
// ------------------------------------------------------------
interface ConfigRow {
  id: string;
  provider: string;
  is_primary: boolean;
  access_token?: string;
  app_secret?: string | null;
  label?: string | null;
  phone_number_id?: string;
  waba_id?: string | null;
  mirror_inbound_media?: boolean | null;
  status?: string;
  created_at?: string;
}

interface Script {
  configs?: ConfigRow[];
  configError?: { message: string } | null;
  /** whatsapp_routes row for the requested surface. */
  route?: { config_id: string } | null;
  /** messages: provider of the last inbound message on the thread. */
  lastInboundProvider?: string | null;
  /** messages: exact channel of the last inbound message (migration 060). */
  lastInboundChannelId?: string | null;
  /** conversations.channel_id — the number the thread is on. */
  threadChannelId?: string | null;
  /** whatsapp_channel_members config ids for the sending user. */
  allocations?: string[];
  /** conversations.send_channel_id — a person's pin (migration 061). */
  pinnedChannelId?: string | null;
  /** Other people's allocations: { config_id, user_id }. */
  otherAllocations?: Array<{ config_id: string; user_id: string }>;
  /** profiles.account_role of the sender. */
  senderRole?: string;
}

function row(r: ConfigRow) {
  return {
    id: r.id,
    account_id: 'acct-1',
    provider: r.provider,
    label: r.label ?? null,
    phone_number_id: r.phone_number_id ?? `pnid-${r.id}`,
    waba_id: r.waba_id ?? null,
    access_token: r.access_token ?? encrypt(`token-${r.id}`),
    app_secret: r.app_secret === undefined ? null : r.app_secret,
    is_primary: r.is_primary,
    mirror_inbound_media: r.mirror_inbound_media ?? true,
    status: r.status ?? 'connected',
    created_at: r.created_at ?? null,
  };
}

function makeDb(script: Script): SupabaseClient {
  let table = '';
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => {
      if (table === 'whatsapp_config') {
        return Promise.resolve({
          data: script.configError ? null : (script.configs ?? []).map(row),
          error: script.configError ?? null,
        });
      }
      return builder;
    },
    limit: () => builder,
    maybeSingle: () => {
      if (table === 'whatsapp_routes') {
        return Promise.resolve({ data: script.route ?? null, error: null });
      }
      if (table === 'messages') {
        return Promise.resolve({
          data:
            script.lastInboundProvider || script.lastInboundChannelId
              ? {
                  provider: script.lastInboundProvider ?? null,
                  channel_id: script.lastInboundChannelId ?? null,
                }
              : null,
          error: null,
        });
      }
      if (table === 'profiles') {
        return Promise.resolve({
          data: { account_role: script.senderRole ?? 'agent' },
          error: null,
        });
      }
      if (table === 'conversations') {
        return Promise.resolve({
          data: {
            channel_id: script.threadChannelId ?? null,
            send_channel_id: script.pinnedChannelId ?? null,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    // `whatsapp_channel_members` terminates on the awaited builder.
    then: (resolve: (v: unknown) => void) =>
      resolve({
        data:
          table === 'whatsapp_channel_members'
            ? [
                ...(script.allocations ?? []).map((config_id) => ({
                  config_id,
                  user_id: 'user-1',
                })),
                ...(script.otherAllocations ?? []),
              ]
            : null,
        error: null,
      }),
  };
  return {
    from: (t: string) => {
      table = t;
      return builder;
    },
  } as unknown as SupabaseClient;
}

const WHAPI: ConfigRow = {
  id: 'cfg-whapi',
  provider: 'whapi',
  is_primary: true,
};
const META: ConfigRow = { id: 'cfg-meta', provider: 'meta', is_primary: false };

describe('loadChannels', () => {
  it('decrypts credentials so callers never touch encryption', async () => {
    const channels = await loadChannels(makeDb({ configs: [WHAPI] }), 'acct-1');
    expect(channels).toHaveLength(1);
    expect(channels[0].accessToken).toBe('token-cfg-whapi');
  });

  it('decrypts a Meta app secret when one is stored', async () => {
    const channels = await loadChannels(
      makeDb({ configs: [{ ...META, app_secret: encrypt('shh') }] }),
      'acct-1'
    );
    expect(channels[0].appSecret).toBe('shh');
  });

  it('leaves appSecret null for a Whapi row', async () => {
    const channels = await loadChannels(makeDb({ configs: [WHAPI] }), 'acct-1');
    expect(channels[0].appSecret).toBeNull();
  });

  it('treats a NULL mirror flag as enabled — the column postdates old rows', async () => {
    const channels = await loadChannels(
      makeDb({ configs: [{ ...WHAPI, mirror_inbound_media: null }] }),
      'acct-1'
    );
    expect(channels[0].mirrorInboundMedia).toBe(true);
  });

  it('fails loudly when a token will not decrypt, rather than reading as unconfigured', async () => {
    // A row written under a rotated ENCRYPTION_KEY. Returning nothing
    // here would surface as "WhatsApp not configured", which sends an
    // operator hunting in entirely the wrong place.
    const db = makeDb({
      configs: [{ ...WHAPI, access_token: 'not-valid-ciphertext' }],
    });
    await expect(loadChannels(db, 'acct-1')).rejects.toThrow(ChannelError);
    await expect(loadChannels(db, 'acct-1')).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it('surfaces a query failure as a typed error, without the database wording', async () => {
    const db = makeDb({ configError: { message: 'connection reset' } });
    const err = await loadChannels(db, 'acct-1').catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.code).toBe('channel_lookup_failed');
    // The raw text is logged, not returned: it can reach a browser.
    expect(err.message).not.toMatch(/connection reset/);
  });

  it('returns an empty list when nothing is connected', async () => {
    expect(await loadChannels(makeDb({ configs: [] }), 'acct-1')).toEqual([]);
  });
});

describe('loadWhapiChannelsForHealth', () => {
  function adminDb(rows: unknown[], error: { message: string } | null = null) {
    const filters: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        filters.push([col, value]);
        return builder;
      },
      order: () => Promise.resolve({ data: error ? null : rows, error }),
    };
    return {
      db: { from: () => builder } as unknown as SupabaseClient,
      filters,
    };
  }

  it('reads Whapi rows across every account, decrypted', async () => {
    const { db, filters } = adminDb([
      row({ id: 'w1', provider: 'whapi', is_primary: true }),
      {
        ...row({ id: 'w2', provider: 'whapi', is_primary: false }),
        account_id: 'acct-2',
      },
    ]);
    const channels = await loadWhapiChannelsForHealth(db);
    expect(channels.map((c) => [c.id, c.accountId, c.accessToken])).toEqual([
      ['w1', 'acct-1', 'token-w1'],
      ['w2', 'acct-2', 'token-w2'],
    ]);
    // Only Whapi, and no account filter — the monitor sweeps the install.
    expect(filters).toEqual([['provider', 'whapi']]);
  });

  it('skips an undecryptable row instead of failing the sweep', async () => {
    const { db } = adminDb([
      row({
        id: 'w1',
        provider: 'whapi',
        is_primary: true,
        access_token: 'garbage',
      }),
      row({ id: 'w2', provider: 'whapi', is_primary: false }),
    ]);
    const channels = await loadWhapiChannelsForHealth(db);
    expect(channels.map((c) => c.id)).toEqual(['w2']);
  });

  it('returns nothing, without throwing, when every row is unreadable', async () => {
    const { db } = adminDb([
      row({
        id: 'w1',
        provider: 'whapi',
        is_primary: true,
        access_token: 'garbage',
      }),
    ]);
    expect(await loadWhapiChannelsForHealth(db)).toEqual([]);
  });

  it('surfaces a query failure as a typed error', async () => {
    const { db } = adminDb([], { message: 'connection reset' });
    const err = await loadWhapiChannelsForHealth(db).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.message).not.toMatch(/connection reset/);
  });
});

describe('primaryChannel', () => {
  const mk = (p: string, isPrimary: boolean) =>
    ({ id: p, provider: p, isPrimary }) as unknown as WhatsAppChannel;

  it('picks the flagged primary', () => {
    expect(
      primaryChannel([mk('whapi', false), mk('meta', true)])?.provider
    ).toBe('meta');
  });

  it('falls back to the first row when no primary is flagged', () => {
    // Can happen if an admin deleted the primary. Returning null would
    // read as "not configured" while a perfectly usable channel exists.
    expect(
      primaryChannel([mk('whapi', false), mk('meta', false)])?.provider
    ).toBe('whapi');
  });

  it('is null only when nothing is connected', () => {
    expect(primaryChannel([])).toBeNull();
  });
});

describe('resolveChannelForSurface', () => {
  it('uses an explicit route when the admin set one', async () => {
    const db = makeDb({
      configs: [WHAPI, META],
      route: { config_id: 'cfg-meta' },
    });
    const ch = await resolveChannelForSurface(db, 'acct-1', 'broadcast');
    expect(ch.provider).toBe('meta');
  });

  it('falls back to the primary when no route exists', async () => {
    const db = makeDb({ configs: [WHAPI, META], route: null });
    const ch = await resolveChannelForSurface(db, 'acct-1', 'inbox');
    expect(ch.provider).toBe('whapi');
  });

  it('falls back to the primary when a route points at a deleted channel', async () => {
    // The FK cascades, so this should not happen — but failing a
    // customer-visible send over stale config would be worse.
    const db = makeDb({
      configs: [WHAPI, META],
      route: { config_id: 'cfg-gone' },
    });
    const ch = await resolveChannelForSurface(db, 'acct-1', 'broadcast');
    expect(ch.provider).toBe('whapi');
  });

  it('throws a 400 "not configured" when the account has no channels', async () => {
    const db = makeDb({ configs: [] });
    await expect(
      resolveChannelForSurface(db, 'acct-1', 'inbox')
    ).rejects.toMatchObject({
      code: 'whatsapp_not_configured',
      status: 400,
    });
  });

  it('behaves as a single-channel install did when only one channel exists', async () => {
    const db = makeDb({ configs: [WHAPI], route: null });
    for (const surface of ROUTING_SURFACES) {
      const ch = await resolveChannelForSurface(db, 'acct-1', surface);
      expect(ch.provider).toBe('whapi');
    }
  });
});

describe('resolveReplyChannel', () => {
  it('replies on the number the customer last wrote to', async () => {
    const db = makeDb({ configs: [WHAPI, META], lastInboundProvider: 'meta' });
    const ch = await resolveReplyChannel(db, 'acct-1', 'conv-1');
    expect(ch.provider).toBe('meta');
  });

  it('falls back to the inbox route for a thread with no inbound history', async () => {
    // Agent-initiated first contact: nothing to follow, so the
    // configured inbox channel decides.
    const db = makeDb({
      configs: [WHAPI, META],
      lastInboundProvider: null,
      route: { config_id: 'cfg-meta' },
    });
    const ch = await resolveReplyChannel(db, 'acct-1', 'conv-1');
    expect(ch.provider).toBe('meta');
  });

  it('still replies when the channel that carried the thread was disconnected', async () => {
    const db = makeDb({
      configs: [WHAPI],
      lastInboundProvider: 'meta',
      route: null,
    });
    const ch = await resolveReplyChannel(db, 'acct-1', 'conv-1');
    expect(ch.provider).toBe('whapi');
  });
});

describe('resolveSendChannel — provider pin', () => {
  it('sends on the pinned provider even when the customer last wrote to the other one', async () => {
    // Contact detail → Send template: an approved template belongs on
    // the Meta number regardless of thread history.
    const db = makeDb({ configs: [WHAPI, META], lastInboundProvider: 'whapi' });
    const ch = await resolveSendChannel(
      db,
      'acct-1',
      'inbox',
      'conv-1',
      'meta'
    );
    expect(ch.provider).toBe('meta');
  });

  it('sends on the pinned provider over the surface route', async () => {
    // Contact detail → Send message: a plain text goes out on Whapi
    // even when the admin routed the inbox to Meta.
    const db = makeDb({
      configs: [WHAPI, META],
      lastInboundProvider: null,
      route: { config_id: 'cfg-meta' },
    });
    const ch = await resolveSendChannel(
      db,
      'acct-1',
      'inbox',
      'conv-1',
      'whapi'
    );
    expect(ch.provider).toBe('whapi');
  });

  it('falls back to the normal rules when the pinned provider is not connected', async () => {
    // Single-channel install: the button keeps working on whatever
    // number exists rather than failing.
    const db = makeDb({ configs: [WHAPI], lastInboundProvider: null });
    const ch = await resolveSendChannel(
      db,
      'acct-1',
      'inbox',
      'conv-1',
      'meta'
    );
    expect(ch.provider).toBe('whapi');
  });

  it('follows the customer when no provider is pinned', async () => {
    const db = makeDb({ configs: [WHAPI, META], lastInboundProvider: 'meta' });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', null);
    expect(ch.provider).toBe('meta');
  });

  it('resolveChannelByProvider returns null rather than throwing for a missing provider', async () => {
    const db = makeDb({ configs: [WHAPI] });
    expect(await resolveChannelByProvider(db, 'acct-1', 'meta')).toBeNull();
    expect((await resolveChannelByProvider(db, 'acct-1', 'whapi'))?.id).toBe(
      'cfg-whapi'
    );
  });

  it('isWhatsAppProvider guards an API body value', () => {
    expect(isWhatsAppProvider('whapi')).toBe(true);
    expect(isWhatsAppProvider('meta')).toBe(true);
    expect(isWhatsAppProvider('twilio')).toBe(false);
    expect(isWhatsAppProvider(undefined)).toBe(false);
  });
});

// ------------------------------------------------------------
// Migration 060: several Whapi numbers per account, allocated to
// members. `provider` no longer names a number on its own.
// ------------------------------------------------------------
const SALES: ConfigRow = {
  id: 'cfg-sales',
  provider: 'whapi',
  is_primary: true,
  label: 'Sales',
  created_at: '2026-01-01T00:00:00Z',
};
const SUPPORT: ConfigRow = {
  id: 'cfg-support',
  provider: 'whapi',
  is_primary: false,
  label: 'Support',
  created_at: '2026-02-01T00:00:00Z',
};

describe('several Whapi numbers (migration 060)', () => {
  it('replies on the exact number the customer wrote to, not the first of its provider', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      lastInboundProvider: 'whapi',
      lastInboundChannelId: 'cfg-support',
    });
    const ch = await resolveReplyChannel(db, 'acct-1', 'conv-1');
    expect(ch.id).toBe('cfg-support');
  });

  it("breaks a provider-only tie (pre-060 message) with the thread's own number", async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      lastInboundProvider: 'whapi',
      threadChannelId: 'cfg-support',
    });
    const ch = await resolveReplyChannel(db, 'acct-1', 'conv-1');
    expect(ch.id).toBe('cfg-support');
  });

  it('keeps an agent-initiated thread on the number it was started from', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      threadChannelId: 'cfg-support',
    });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1');
    expect(ch.id).toBe('cfg-support');
  });

  it("starts a new chat from the sender's allocated number", async () => {
    const db = makeDb({ configs: [SALES, SUPPORT], allocations: ['cfg-support'] });
    const ch = await resolveSendChannel(
      db, 'acct-1', 'inbox', 'conv-1', null, 'user-1'
    );
    expect(ch.id).toBe('cfg-support');
  });

  it('starts from the route for a sender on no number — the pre-060 behaviour', async () => {
    const db = makeDb({ configs: [SALES, SUPPORT], allocations: [] });
    const ch = await resolveSendChannel(
      db, 'acct-1', 'inbox', 'conv-1', null, 'user-1'
    );
    expect(ch.id).toBe('cfg-sales');
  });

  it('a Whapi pin prefers the thread, then the sender allocation, then the primary', async () => {
    const pinned = (script: Script) =>
      resolveSendChannel(
        makeDb({ configs: [SALES, SUPPORT, META], ...script }),
        'acct-1', 'inbox', 'conv-1', 'whapi', 'user-1'
      ).then((c) => c.id);
    expect(await pinned({ threadChannelId: 'cfg-support' })).toBe('cfg-support');
    expect(await pinned({ allocations: ['cfg-support'] })).toBe('cfg-support');
    expect(await pinned({})).toBe('cfg-sales');
    // A thread on the Meta number does not drag a Whapi pin onto it.
    expect(await pinned({ threadChannelId: 'cfg-meta' })).toBe('cfg-sales');
  });

  it('a bot stays on the thread number when it matches the routed provider', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      route: { config_id: 'cfg-sales' },
      threadChannelId: 'cfg-support',
    });
    const ch = await resolveBotChannel(db, 'acct-1', 'flow', 'conv-1');
    expect(ch.id).toBe('cfg-support');
  });

  it('a bot obeys a cross-provider route even when the thread is on Whapi', async () => {
    const db = makeDb({
      configs: [SALES, META],
      route: { config_id: 'cfg-meta' },
      threadChannelId: 'cfg-sales',
    });
    const ch = await resolveBotChannel(db, 'acct-1', 'automation', 'conv-1');
    expect(ch.id).toBe('cfg-meta');
  });

  it('a bot with no conversation uses the route', async () => {
    const db = makeDb({ configs: [SALES, SUPPORT], route: { config_id: 'cfg-support' } });
    const ch = await resolveBotChannel(db, 'acct-1', 'automation', null);
    expect(ch.id).toBe('cfg-support');
  });

  it('resolveChannelByProvider picks the primary among several', async () => {
    const db = makeDb({ configs: [SUPPORT, SALES] });
    expect((await resolveChannelByProvider(db, 'acct-1', 'whapi'))?.id).toBe('cfg-sales');
  });

  it('loadChannels orders same-provider numbers oldest first', async () => {
    const db = makeDb({ configs: [SUPPORT, SALES] });
    expect((await loadChannels(db, 'acct-1')).map((c) => c.id)).toEqual([
      'cfg-sales',
      'cfg-support',
    ]);
  });
});

describe('a chat pinned to a number (migration 061)', () => {
  it('sends an agent reply from the pin, not the number the customer wrote to', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT, META],
      lastInboundProvider: 'meta',
      lastInboundChannelId: 'cfg-meta',
      pinnedChannelId: 'cfg-support',
    });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1');
    expect(ch.id).toBe('cfg-support');
  });

  it('beats the sender allocation and the surface route', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      route: { config_id: 'cfg-sales' },
      allocations: ['cfg-sales'],
      pinnedChannelId: 'cfg-support',
    });
    expect(
      (await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', null, 'user-1')).id
    ).toBe('cfg-support');
  });

  it('bots answering in the chat follow the pin, even across providers', async () => {
    const db = makeDb({
      configs: [SALES, META],
      route: { config_id: 'cfg-meta' },
      threadChannelId: 'cfg-meta',
      pinnedChannelId: 'cfg-sales',
    });
    expect((await resolveBotChannel(db, 'acct-1', 'flow', 'conv-1')).id).toBe(
      'cfg-sales'
    );
  });

  it('yields to a provider pin of the other kind (Contact screen, Compass)', async () => {
    const db = makeDb({
      configs: [SALES, META],
      pinnedChannelId: 'cfg-meta',
    });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', 'whapi');
    expect(ch.id).toBe('cfg-sales');
  });

  it('keeps the pin when the provider pin agrees with it', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      pinnedChannelId: 'cfg-support',
    });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', 'whapi');
    expect(ch.id).toBe('cfg-support');
  });

  it('falls back to automatic when the pinned number was disconnected', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      lastInboundChannelId: 'cfg-sales',
      lastInboundProvider: 'whapi',
      pinnedChannelId: 'cfg-gone',
    });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1');
    expect(ch.id).toBe('cfg-sales');
  });
});

describe('review fixes (migration 062)', () => {
  it("does not start an unallocated agent's chat on another team's number", async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      otherAllocations: [{ config_id: 'cfg-sales', user_id: 'someone-else' }],
    });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', null, 'user-1');
    // Sales (the default) belongs to someone else; Support is shared.
    expect(ch.id).toBe('cfg-support');
  });

  it("still starts an admin's chat from the default, whoever it is allocated to", async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      otherAllocations: [{ config_id: 'cfg-sales', user_id: 'someone-else' }],
      senderRole: 'admin',
    });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', null, 'user-1');
    expect(ch.id).toBe('cfg-sales');
  });

  it('skips one number with an unreadable token instead of failing every number', async () => {
    const db = makeDb({
      configs: [SALES, { ...SUPPORT, access_token: 'garbage:not:ciphertext' }],
    });
    expect((await loadChannels(db, 'acct-1')).map((c) => c.id)).toEqual(['cfg-sales']);
  });

  it('falls back to a Whapi number, not Meta, when no default is flagged', () => {
    const meta = { id: 'm', provider: 'meta', isPrimary: false } as WhatsAppChannel;
    const whapi = { id: 'w', provider: 'whapi', isPrimary: false } as WhatsAppChannel;
    expect(primaryChannel([meta, whapi])?.id).toBe('w');
  });

  it('keeps a Meta pin for a Whapi-preferred send when no Whapi number exists', async () => {
    const db = makeDb({ configs: [META], pinnedChannelId: 'cfg-meta' });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', 'whapi');
    expect(ch.id).toBe('cfg-meta');
  });

  it('uses the caller-supplied conversation numbers instead of re-reading them', async () => {
    const db = makeDb({ configs: [SALES, SUPPORT], pinnedChannelId: null });
    const ch = await resolveSendChannel(db, 'acct-1', 'inbox', 'conv-1', null, null, {
      channelId: null,
      sendChannelId: 'cfg-support',
    });
    expect(ch.id).toBe('cfg-support');
  });

  it('the AI takes an explicit ai_reply route literally (a same-provider number stays human)', async () => {
    const db = makeDb({
      configs: [SALES, SUPPORT],
      route: { config_id: 'cfg-sales' },
      threadChannelId: 'cfg-support',
    });
    expect((await resolveAiReplyChannel(db, 'acct-1', 'conv-1')).id).toBe('cfg-sales');
  });

  it('the AI stays on the thread number when no ai_reply route is set', async () => {
    const db = makeDb({ configs: [SALES, SUPPORT], threadChannelId: 'cfg-support' });
    expect((await resolveAiReplyChannel(db, 'acct-1', 'conv-1')).id).toBe('cfg-support');
  });

  it('the AI follows a pin', async () => {
    const db = makeDb({
      configs: [SALES, META],
      route: { config_id: 'cfg-sales' },
      pinnedChannelId: 'cfg-meta',
    });
    expect((await resolveAiReplyChannel(db, 'acct-1', 'conv-1')).id).toBe('cfg-meta');
  });
});

describe('pickChannelForUser / pickByProvider', () => {
  const ch = (id: string, provider: 'whapi' | 'meta', isPrimary = false) =>
    ({ id, provider, isPrimary }) as WhatsAppChannel;
  const a = ch('a', 'whapi', true);
  const b = ch('b', 'whapi');
  const c = ch('c', 'whapi');
  const m = ch('m', 'meta');

  it('keeps the route when the user is on no number', () => {
    expect(pickChannelForUser([a, b], [], a)).toBe(a);
  });
  it('keeps the route when it is one of theirs', () => {
    expect(pickChannelForUser([a, b, c], ['a', 'c'], a)).toBe(a);
  });
  it('otherwise takes their oldest allocated number', () => {
    expect(pickChannelForUser([a, b, c], ['c', 'b'], a)).toBe(b);
  });
  it('pickByProvider is null for a provider that is not connected', () => {
    expect(pickByProvider([a, b], 'meta')).toBeNull();
    expect(pickByProvider([a, b, m], 'meta')).toBe(m);
  });
  it('pickByProvider skips unknown and null preferences', () => {
    expect(pickByProvider([a, b], 'whapi', [null, 'zzz', 'b'])).toBe(b);
  });
});

describe('surface catalogue', () => {
  it('matches the whatsapp_routes CHECK constraint in migration 046', () => {
    expect([...ROUTING_SURFACES]).toEqual([
      'inbox',
      'broadcast',
      'automation',
      'flow',
      'ai_reply',
      'api',
    ]);
  });

  it('guards unknown surfaces coming off an API body', () => {
    expect(isRoutingSurface('broadcast')).toBe(true);
    expect(isRoutingSurface('telepathy')).toBe(false);
  });
});

describe('describeChannel', () => {
  const mk = (o: Partial<WhatsAppChannel>) => o as WhatsAppChannel;

  it('prefers the operator label', () => {
    expect(
      describeChannel(
        mk({ label: 'Marketing', provider: 'meta', phoneNumberId: 'p' })
      )
    ).toBe('Marketing (Cloud API)');
  });

  it('falls back to the number, then the gateway id', () => {
    expect(
      describeChannel(
        mk({
          label: null,
          wabaId: '15551234567',
          provider: 'whapi',
          phoneNumberId: 'CHAN-1',
        })
      )
    ).toBe('15551234567 (Whapi)');
    expect(
      describeChannel(
        mk({
          label: null,
          wabaId: null,
          provider: 'whapi',
          phoneNumberId: 'CHAN-1',
        })
      )
    ).toBe('CHAN-1 (Whapi)');
  });
});
