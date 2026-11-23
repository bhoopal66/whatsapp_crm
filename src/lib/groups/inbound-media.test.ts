import { beforeEach, describe, expect, it, vi } from 'vitest';

// A group file from the queued event to the row: the real processor, group
// writer, mirror and OpenWA normaliser, over an in-memory database, a fake
// bucket and a fake gateway.

const h = vi.hoisted(() => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@/lib/whatsapp/provider', async (original) => ({
  ...(await original<object>()),
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'key' }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: h.upload,
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `${BUCKET}${path}` },
        }),
      }),
    },
  }),
}));
vi.mock('@/lib/submission-groups/inbound', () => ({
  recordSubmissionGroupInbound: async () => ({ failed: 0 }),
}));
vi.mock('@/lib/submission-groups/store', () => ({
  SubmissionGroupStore: class {},
}));
vi.mock('@/lib/cases/server', () => ({
  caseSlaInboundHook: () => undefined,
  caseIntakeQueueFor: () => ({ run: async () => {} }),
}));
vi.mock('@/lib/brain/sink', () => ({ recordGroupCustomerText: vi.fn() }));

import {
  getMediaUrl as openwaMediaUrl,
  isOpenWAMediaUrl,
} from '@/lib/whatsapp/openwa-api';
import { normalizeOpenWAGroupMessage } from '@/lib/whatsapp/openwa-webhook';
import {
  groupMessagePayload,
  processInboundEvent,
} from '@/lib/whatsapp/inbound-events';

import { extractWhapiGroupMessages, type GroupInboundMessage } from './inbound';

const ACCT = '00000000-0000-4000-8000-000000000001';
const BUCKET = 'https://crm.example/storage/v1/object/public/chat-media/';
const OURS = `${BUCKET}account-${ACCT}/inbound/`;
const WA_GROUP = '120363000000000001@g.us';
const WHAPI_LINK = 'https://gate.example/in-files/doc.pdf';

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
/** Every update sent, whether or not it matched a row. */
let updates: number;

function read(row: Row, col: string): unknown {
  const [field, key] = col.split('->>');
  if (!key) return row[field] ?? null;
  return (row[field] as Row | null)?.[key] ?? null;
}

const admin = {
  from(table: string) {
    const tests: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let upserted: Row[] | null = null;
    const hit = () => tables[table].filter((r) => tests.every((t) => t(r)));
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => (tests.push((r) => read(r, c) === v), b),
      is: (c: string, v: unknown) => (tests.push((r) => read(r, c) === v), b),
      in: (c: string, v: unknown[]) => (
        tests.push((r) => v.includes(read(r, c))),
        b
      ),
      update: (p: Row) => ((patch = p), b),
      upsert: (rows: Row[]) => ((upserted = rows), b),
      maybeSingle: async () => ({ data: hit()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        let data: Row[];
        if (upserted) {
          data = upserted.filter(
            (n) =>
              !tables[table].some(
                (o) =>
                  o.group_id === n.group_id &&
                  o.wa_message_id === n.wa_message_id
              )
          );
          for (const n of data) tables[table].push({ ...n, id: 'row-new' });
        } else {
          data = hit();
          if (patch) {
            updates++;
            for (const r of data) Object.assign(r, patch);
          }
        }
        return Promise.resolve({ data, error: null }).then(ok);
      },
    };
    return b;
  },
};

const process = (
  provider: 'whapi' | 'openwa',
  message: GroupInboundMessage | null,
  opts: { config?: Row; later?: Promise<unknown>[] } = {}
) =>
  processInboundEvent(
    {
      accountId: ACCT,
      channel: 'cfg-1',
      provider,
      eventKey: 'k',
      kind: 'group_message',
      payload: groupMessagePayload(message!),
    },
    {
      admin: admin as never,
      config: {
        id: 'cfg-1',
        account_id: ACCT,
        phone_number_id: 'sess-1',
        access_token: 'cipher',
        ...opts.config,
      },
      later: opts.later,
    }
  );

const openwa = (over: Row = {}) =>
  normalizeOpenWAGroupMessage({
    id: 'false_120363000000000001@g.us_ABC_971500000001@c.us',
    from: WA_GROUP,
    chatId: WA_GROUP,
    isGroup: true,
    kind: 'group',
    author: '971500000001@c.us',
    type: 'image',
    body: 'secret text',
    timestamp: 1700000000,
    media: { mimetype: 'image/jpeg' },
    ...over,
  } as never);

const whapi = (over: Row = {}) =>
  extractWhapiGroupMessages({
    messages: [
      {
        id: 'w1',
        chat_id: WA_GROUP,
        from: '971500000001',
        type: 'document',
        timestamp: 1700000000,
        document: {
          id: 'pdf-abc',
          link: WHAPI_LINK,
          mime_type: 'application/pdf',
          file_name: 'licence.pdf',
          file_size: 12,
        },
        ...over,
      },
    ],
  })[0];

const stored = () => tables.whatsapp_group_messages[0];
const media = () => stored().media as Row;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  tables = {
    whatsapp_groups: [
      {
        id: 'grp-1',
        account_id: ACCT,
        channel_id: 'cfg-1',
        wa_group_id: WA_GROUP,
      },
    ],
    whatsapp_group_messages: [],
  };
  updates = 0;
  h.upload.mockResolvedValue({ error: null });
  h.getMediaUrl.mockResolvedValue({
    url: 'http://127.0.0.1:2785/media',
    mimeType: 'application/octet-stream',
    fileSize: null,
  });
  h.downloadMedia.mockResolvedValue({
    buffer: Buffer.from('bytes'),
    contentType: 'application/octet-stream',
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a file sent in a WhatsApp group', () => {
  it('openwa: is fetched by chat and message id, and the row gets our link', async () => {
    const message = openwa();
    expect(await process('openwa', message)).toEqual({ outcome: 'done' });
    expect(h.getMediaUrl.mock.calls[0][0].mediaId).toBe(
      `${WA_GROUP}/${message!.id}`
    );
    expect(media()).toMatchObject({
      id: `${WA_GROUP}/${message!.id}`,
      mime_type: 'image/jpeg',
    });
    expect(media().link).toMatch(
      new RegExp(`^${OURS}\\d{20}-image-1700000000\\.jpg$`)
    );
    expect(stored().body).toBe('secret text');
  });

  it('openwa: two files of one name are two objects', async () => {
    const doc = { mimetype: 'application/pdf', filename: 'scan.pdf' };
    for (const id of ['A', 'B']) {
      await process(
        'openwa',
        openwa({ id: `false_${WA_GROUP}_${id}`, type: 'document', media: doc })
      );
    }
    const paths = h.upload.mock.calls.map((c) => c[0]);
    expect(new Set(paths).size).toBe(2);
  });

  it('openwa: the gateway serves it for an @g.us chat, with the key', () => {
    vi.stubEnv('OPENWA_URL', 'http://127.0.0.1:2785');
    try {
      const { url } = openwaMediaUrl({
        sessionId: 'sess-1',
        mediaId: openwa()!.media!.id as string,
      });
      expect(url).toContain('/messages/120363000000000001%40g.us/false_');
      expect(isOpenWAMediaUrl(new URL(url), 'sess-1')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['sticker', 'voice', 'audio', 'video', 'document'])(
    'openwa: a %s too',
    async (type) => {
      await process('openwa', openwa({ type, media: {} }));
      expect(String(media().link)).toContain(OURS);
    }
  );

  it('whapi: its 30-day link becomes ours, the rest of the media is kept', async () => {
    await process('whapi', whapi());
    expect(h.downloadMedia.mock.calls[0][0].downloadUrl).toBe(WHAPI_LINK);
    expect(media()).toEqual({
      id: 'pdf-abc',
      link: expect.stringContaining(OURS),
      mime_type: 'application/pdf',
      filename: 'licence.pdf',
      file_size: 12,
    });
  });

  it('whapi: a number that opted out of copies keeps the link', async () => {
    await process('whapi', whapi(), {
      config: { mirror_inbound_media: false },
    });
    expect(h.downloadMedia).not.toHaveBeenCalled();
    expect(media().link).toBe(WHAPI_LINK);
  });

  it('openwa: is copied even then, having no other link', async () => {
    await process('openwa', openwa(), {
      config: { mirror_inbound_media: false },
    });
    expect(String(media().link)).toContain(OURS);
  });

  it('is copied behind the message, never before the next one', async () => {
    let release = () => {};
    h.downloadMedia.mockImplementation(
      () =>
        new Promise((r) => (release = () => r({ buffer: Buffer.from('x') })))
    );
    const later: Promise<unknown>[] = [];
    expect(await process('whapi', whapi(), { later })).toEqual({
      outcome: 'done',
    });
    expect(later).toHaveLength(1);
    expect(media().link).toBe(WHAPI_LINK);
    await vi.waitFor(() => expect(h.downloadMedia).toHaveBeenCalled());
    release();
    await Promise.all(later);
    expect(String(media().link)).toContain(OURS);
  });

  it('a failed download leaves the row, and logs no number or text', async () => {
    h.downloadMedia.mockRejectedValue(new Error('503'));
    expect(await process('openwa', openwa())).toEqual({ outcome: 'done' });
    expect(media().link).toBeNull();
    expect(updates).toBe(0);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('no durable copy for message row-new');
    expect(logged).not.toMatch(/971500000001|secret/);
  });

  it('a redelivery copies nothing again', async () => {
    await process('openwa', openwa());
    const link = media().link;
    await process('openwa', openwa());
    expect(h.downloadMedia).toHaveBeenCalledTimes(1);
    expect(tables.whatsapp_group_messages).toHaveLength(1);
    expect(media().link).toBe(link);
  });

  it('a retry after a failed copy tries again', async () => {
    h.downloadMedia.mockRejectedValueOnce(new Error('503'));
    await process('whapi', whapi());
    await process('whapi', whapi());
    expect(String(media().link)).toContain(OURS);
  });

  it('an echo of our own send leaves the uploaded file alone', async () => {
    const upload = { link: `${BUCKET}account-${ACCT}/groups/1-a.jpg` };
    tables.whatsapp_group_messages.push({
      id: 'row-1',
      account_id: ACCT,
      group_id: 'grp-1',
      wa_message_id: openwa()!.id,
      media: upload,
    });
    await process('openwa', openwa({ fromMe: true }));
    expect(h.downloadMedia).not.toHaveBeenCalled();
    expect(media()).toEqual(upload);
  });

  it.each([
    ['cleared', null],
    ['replaced by our send', { link: `${BUCKET}account-${ACCT}/groups/1.jpg` }],
  ])('a row %s during the copy keeps what it says', async (_, newer) => {
    h.upload.mockImplementation(async () => {
      stored().media = newer;
      return { error: null };
    });
    await process('whapi', whapi());
    expect(stored().media).toEqual(newer);
  });

  it('an unknown group stores and copies nothing', async () => {
    tables.whatsapp_groups = [];
    await process('whapi', whapi());
    expect(h.downloadMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['location', { location: { latitude: 25, longitude: 55 } }],
    ['contact', { body: 'BEGIN:VCARD\nFN:Omar\nTEL:+97150\nEND:VCARD' }],
    ['text', { body: 'hello' }],
  ])('a %s is untouched', async (type, over) => {
    const message = openwa({ type, media: undefined, ...over });
    await process('openwa', message);
    expect(stored().media).toEqual(message!.media);
    expect(h.getMediaUrl).not.toHaveBeenCalled();
    expect(updates).toBe(0);
  });
});
