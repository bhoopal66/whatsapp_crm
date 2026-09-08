import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ChannelError,
  describeChannel,
  isRoutingSurface,
  loadChannels,
  primaryChannel,
  resolveChannelForSurface,
  resolveReplyChannel,
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
}

interface Script {
  configs?: ConfigRow[];
  configError?: { message: string } | null;
  /** whatsapp_routes row for the requested surface. */
  route?: { config_id: string } | null;
  /** messages: provider of the last inbound message on the thread. */
  lastInboundProvider?: string | null;
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
          data: script.lastInboundProvider
            ? { provider: script.lastInboundProvider }
            : null,
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
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

  it('surfaces a query failure as a typed error', async () => {
    const db = makeDb({ configError: { message: 'connection reset' } });
    await expect(loadChannels(db, 'acct-1')).rejects.toThrow(
      /connection reset/
    );
  });

  it('returns an empty list when nothing is connected', async () => {
    expect(await loadChannels(makeDb({ configs: [] }), 'acct-1')).toEqual([]);
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
