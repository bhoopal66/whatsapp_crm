import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { WhatsAppChannel } from './channels';
import {
  AVATAR_MAX_BYTES,
  AVATAR_REFRESH_MS,
  avatarObjectPath,
  createChannelGate,
  isAvatarDue,
  mapWithConcurrency,
  parseAvatarRequest,
  pickAvatarChannel,
  refreshContactAvatar,
} from './contact-avatars';

const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const CONTACT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = new Date('2026-10-05T12:00:00.000Z');

function channel(over: Partial<WhatsAppChannel> = {}): WhatsAppChannel {
  return {
    id: 'ch-1',
    accountId: ACCOUNT,
    provider: 'whapi',
    label: null,
    phoneNumberId: 'CHAN',
    wabaId: null,
    accessToken: 'tok',
    appSecret: null,
    isPrimary: false,
    mirrorInboundMedia: true,
    status: 'connected',
    ...over,
  };
}

/** Records every `update().eq().eq()` chain on `contacts`. */
function fakeDb(error: { message: string } | null = null) {
  const updates: Array<{
    table: string;
    patch: Record<string, unknown>;
    eqs: Array<[string, unknown]>;
  }> = [];
  const db = {
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          const entry = { table, patch, eqs: [] as Array<[string, unknown]> };
          updates.push(entry);
          const chain = {
            eq(col: string, value: unknown) {
              entry.eqs.push([col, value]);
              return chain;
            },
            then(resolve: (v: { error: typeof error }) => unknown) {
              return Promise.resolve({ error }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

function fakeStorage(
  opts: { uploadError?: { message: string }; throws?: boolean } = {}
) {
  const uploads: Array<{
    bucket: string;
    path: string;
    options: { contentType: string; cacheControl: string; upsert: boolean };
  }> = [];
  const storage = {
    from(bucket: string) {
      return {
        async upload(
          path: string,
          _body: Uint8Array | Buffer,
          options: {
            contentType: string;
            cacheControl: string;
            upsert: boolean;
          }
        ) {
          if (opts.throws) throw new Error('storage down');
          uploads.push({ bucket, path, options });
          return { error: opts.uploadError ?? null };
        },
        getPublicUrl(path: string) {
          return {
            data: {
              publicUrl: `http://internal.local:8000/storage/v1/object/public/${bucket}/${path}`,
            },
          };
        },
      };
    },
  };
  return { storage, uploads };
}

function base(over: Partial<Parameters<typeof refreshContactAvatar>[0]> = {}) {
  const { db, updates } = fakeDb();
  const { storage, uploads } = fakeStorage();
  return {
    updates,
    uploads,
    args: {
      db,
      storage,
      accountId: ACCOUNT,
      contactId: CONTACT,
      phone: '+971501234567',
      channel: channel(),
      now: () => NOW,
      getPicture: vi.fn(async () => 'https://pps.whatsapp.net/v/t61/full.jpg'),
      download: vi.fn(async () => ({
        buffer: Buffer.alloc(20_000),
        contentType: 'image/jpeg',
      })),
      ...over,
    },
  };
}

describe('isAvatarDue', () => {
  it('is due when never checked, or unreadable', () => {
    expect(isAvatarDue(null, NOW)).toBe(true);
    expect(isAvatarDue(undefined, NOW)).toBe(true);
    expect(isAvatarDue('not a date', NOW)).toBe(true);
  });

  it('is not due within the week, and due once it has passed', () => {
    const recent = new Date(NOW.getTime() - AVATAR_REFRESH_MS + 60_000);
    const old = new Date(NOW.getTime() - AVATAR_REFRESH_MS);
    expect(isAvatarDue(recent.toISOString(), NOW)).toBe(false);
    expect(isAvatarDue(old.toISOString(), NOW)).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('refreshContactAvatar', () => {
  it('uploads under account-<id>/avatars/ and stores the public URL with ?v=', async () => {
    // Self-hosted: storage answers with the INTERNAL origin, the column
    // must hold the one the browser can reach.
    vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://internal.local:8000');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example');
    const { args, uploads, updates } = base();
    const result = await refreshContactAvatar(args);

    expect(uploads).toEqual([
      {
        bucket: 'chat-media',
        path: `account-${ACCOUNT}/avatars/${CONTACT}.jpg`,
        options: expect.objectContaining({
          contentType: 'image/jpeg',
          upsert: true,
        }),
      },
    ]);
    const url = `https://supabase.example/storage/v1/object/public/chat-media/account-${ACCOUNT}/avatars/${CONTACT}.jpg?v=${NOW.getTime()}`;
    expect(result).toEqual({
      contactId: CONTACT,
      avatarUrl: url,
      status: 'updated',
    });
    expect(updates).toEqual([
      {
        table: 'contacts',
        patch: { avatar_url: url, avatar_checked_at: NOW.toISOString() },
        eqs: [
          ['id', CONTACT],
          ['account_id', ACCOUNT],
        ],
      },
    ]);
    expect(args.download).toHaveBeenCalledWith({
      channel: args.channel,
      downloadUrl: 'https://pps.whatsapp.net/v/t61/full.jpg',
    });
  });

  it('clears the URL and stamps the check when there is no picture', async () => {
    const { args, uploads, updates } = base({
      getPicture: vi.fn(async () => null),
    });
    const result = await refreshContactAvatar(args);

    expect(result).toEqual({
      contactId: CONTACT,
      avatarUrl: null,
      status: 'none',
    });
    expect(uploads).toHaveLength(0);
    expect(args.download).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({
      avatar_url: null,
      avatar_checked_at: NOW.toISOString(),
    });
    expect(updates[0].eqs).toContainEqual(['account_id', ACCOUNT]);
  });

  it.each([
    [
      'a Whapi failure',
      {
        getPicture: vi.fn(async () => {
          throw new Error('Whapi API error: 503');
        }),
      },
    ],
    [
      'a failed download',
      {
        download: vi.fn(async () => {
          throw new Error('Media download failed: 403');
        }),
      },
    ],
    [
      'a refused upload',
      { storage: fakeStorage({ uploadError: { message: 'mime' } }).storage },
    ],
    ['a throwing uploader', { storage: fakeStorage({ throws: true }).storage }],
  ])('writes nothing and does not throw on %s', async (_label, over) => {
    const { args, updates } = base(over);
    await expect(refreshContactAvatar(args)).resolves.toEqual({
      contactId: CONTACT,
      avatarUrl: null,
      status: 'error',
    });
    expect(updates).toHaveLength(0);
  });

  it('reports an error, not success, when the contact write fails', async () => {
    const { args } = base({ db: fakeDb({ message: 'denied' }).db });
    await expect(refreshContactAvatar(args)).resolves.toMatchObject({
      status: 'error',
    });
  });

  it.each([
    ['not an image', Buffer.alloc(1000), 'text/html; charset=utf-8'],
    ['an SVG', Buffer.alloc(1000), 'image/svg+xml'],
    ['oversized', Buffer.alloc(AVATAR_MAX_BYTES + 1), 'image/jpeg'],
  ])(
    'skips a download that is %s without uploading',
    async (_l, buffer, contentType) => {
      const { args, uploads, updates } = base({
        download: vi.fn(async () => ({ buffer, contentType })),
      });
      const result = await refreshContactAvatar(args);

      expect(result.status).toBe('skipped');
      expect(uploads).toHaveLength(0);
      // Stamped so the same thing isn't fetched on every load; the URL we
      // had (if any) is left alone.
      expect(updates).toHaveLength(1);
      expect(updates[0].patch).toEqual({
        avatar_checked_at: NOW.toISOString(),
      });
    }
  );
});

describe('avatarObjectPath', () => {
  it('starts with the account segment migration 023 RLS matches', () => {
    expect(avatarObjectPath(ACCOUNT, CONTACT).split('/')[0]).toBe(
      `account-${ACCOUNT}`
    );
  });
});

describe('pickAvatarChannel', () => {
  const meta = channel({ id: 'meta', provider: 'meta', isPrimary: true });
  const a = channel({ id: 'a' });
  const b = channel({ id: 'b', isPrimary: true });
  const down = channel({ id: 'down', status: 'disconnected' });

  it("prefers the thread's own Whapi number", () => {
    expect(pickAvatarChannel([meta, a, b], 'a')?.id).toBe('a');
  });

  it('falls back to the primary Whapi number, then the first', () => {
    expect(pickAvatarChannel([meta, a, b], null)?.id).toBe('b');
    expect(pickAvatarChannel([meta, a], undefined)?.id).toBe('a');
  });

  it('skips a thread on a Meta number rather than borrowing a Whapi one', () => {
    expect(pickAvatarChannel([meta, a, b], 'meta')).toBeNull();
  });

  it('skips a thread on a disconnected Whapi number rather than borrowing another', () => {
    expect(pickAvatarChannel([down, a, b], 'down')).toBeNull();
  });

  it('never picks Meta or a disconnected number', () => {
    expect(pickAvatarChannel([meta, down], 'down')).toBeNull();
  });
});

describe('parseAvatarRequest', () => {
  it('dedupes valid ids', () => {
    expect(parseAvatarRequest({ contactIds: [CONTACT, CONTACT] })).toEqual({
      ids: [CONTACT],
    });
  });

  it('rejects a non-array, a non-uuid, and more than 50', () => {
    expect(parseAvatarRequest({})).toHaveProperty('error');
    expect(parseAvatarRequest(null)).toHaveProperty('error');
    expect(parseAvatarRequest({ contactIds: ['x'] })).toHaveProperty('error');
    const many = Array.from(
      { length: 51 },
      (_, i) => `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`
    );
    expect(parseAvatarRequest({ contactIds: many })).toHaveProperty('error');
  });
});

describe('mapWithConcurrency', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 4, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(4);
  });
});

describe('createChannelGate', () => {
  const ok = { status: 'AUTH', authorized: true, phone: '1' };

  it('lets a channel through only when the probe says AUTH', async () => {
    const gate = createChannelGate(async (c) =>
      c.id === 'good'
        ? ok
        : {
            status: c.id === 'qr' ? 'QR' : 'LAUNCH',
            authorized: false,
            phone: null,
          }
    );
    await expect(gate(channel({ id: 'good' }))).resolves.toBe(true);
    await expect(gate(channel({ id: 'qr' }))).resolves.toBe(false);
    await expect(gate(channel({ id: 'launching' }))).resolves.toBe(false);
  });

  it('fails closed on a probe error or no probe', async () => {
    const boom = createChannelGate(async () => {
      throw new Error('Whapi API error: 404');
    });
    await expect(boom(channel())).resolves.toBe(false);
    const none = createChannelGate(async () => null);
    await expect(none(channel())).resolves.toBe(false);
  });

  it('probes each channel once per gate', async () => {
    const probe = vi.fn(async () => ok);
    const gate = createChannelGate(probe);
    const c = channel({ id: 'x' });
    await Promise.all([gate(c), gate(c), gate(c)]);
    await gate(c);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
