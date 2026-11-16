import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/provider', () => ({
  sendTemplate: vi.fn(),
  sendText: vi.fn(),
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  loadChannels: vi.fn(),
  resolveSendChannel: vi.fn(),
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(),
}));

import { sendTemplate, sendText } from '@/lib/whatsapp/provider';
import { loadChannels, resolveSendChannel } from '@/lib/whatsapp/channels';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { TemplateSendRequest } from './ports';
import { createHrSendPort } from './send';

type Row = Record<string, unknown>;

const ACCOUNT = 'acc-1';
const CONV = 'conv-1';
const CONTACT = 'contact-1';
const PHONE = '971501234567';

const TEMPLATE_ROW = { id: 'tpl-1', name: 'hr_hr_interview_invite' };

function channel(over: Partial<WhatsAppChannel> = {}): WhatsAppChannel {
  return {
    id: 'ch-own',
    accountId: ACCOUNT,
    provider: 'meta',
    isPersonal: false,
    ...over,
  } as WhatsAppChannel;
}

interface DbOpts {
  conv?: Row | null;
  contact?: Row | null;
  messageInsert?: { data: Row | null; error: { message: string } | null };
}

/**
 * A chainable fake of the few PostgREST calls the sender makes. Reads
 * honour every `.eq()` filter against the stored row, so a request for
 * another account or contact finds nothing, as RLS-free SQL would.
 */
function fakeDb(opts: DbOpts) {
  const inserts: { table: string; values: Row }[] = [];
  const updates: { table: string; values: Row }[] = [];
  const tables: Record<string, Row | null> = {
    conversations: opts.conv === undefined ? baseConv() : opts.conv,
    contacts:
      opts.contact === undefined
        ? { id: CONTACT, account_id: ACCOUNT, phone: `+${PHONE}` }
        : opts.contact,
  };
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return b;
        },
        update: (values: Row) => {
          updates.push({ table, values });
          return b;
        },
        insert: (values: Row) => {
          inserts.push({ table, values });
          return b;
        },
        maybeSingle: async () => {
          const row = tables[table] ?? null;
          const hit = row && filters.every(([c, v]) => row[c] === v);
          return { data: hit ? row : null, error: null };
        },
        single: async () =>
          opts.messageInsert ?? { data: { id: 'msg-1' }, error: null },
        then: (
          ok: (v: { data: null; error: null }) => unknown,
          bad?: (e: unknown) => unknown
        ) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, inserts, updates };
}

function baseConv(over: Row = {}): Row {
  return {
    id: CONV,
    account_id: ACCOUNT,
    contact_id: CONTACT,
    channel_id: 'ch-own',
    send_channel_id: null,
    personal_owner_id: null,
    ...over,
  };
}

function req(over: Partial<TemplateSendRequest> = {}): TemplateSendRequest {
  return {
    accountId: ACCOUNT,
    conversationId: CONV,
    contactId: CONTACT,
    templateKind: 'hr_interview_invite',
    language: 'en',
    metaTemplateName: 'hr_hr_interview_invite',
    body: 'Our Alignment team: your slot is Monday 10:00. See you, Ali.',
    templateBody: 'Our Alignment team: your slot is {slot}. See you, {name}.',
    params: { name: 'Ali', slot: 'Monday 10:00' },
    ...over,
  };
}

const gateway = () =>
  vi.mocked(sendTemplate).mock.calls.length +
  vi.mocked(sendText).mock.calls.length;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadChannels).mockResolvedValue([channel()]);
  vi.mocked(resolveTemplateRow).mockResolvedValue({
    row: TEMPLATE_ROW,
  } as unknown as Awaited<ReturnType<typeof resolveTemplateRow>>);
  vi.mocked(sendTemplate).mockResolvedValue({ messageId: 'wamid-1' } as never);
  vi.mocked(sendText).mockResolvedValue({ messageId: 'wamid-t' } as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('createHrSendPort: Meta', () => {
  it('sends the local template row with params in the template token order', async () => {
    const { db } = fakeDb({});
    const out = await createHrSendPort(db).send(req());
    expect(out).toEqual({ providerMessageId: 'wamid-1', messageId: 'msg-1' });
    expect(resolveTemplateRow).toHaveBeenCalledWith(
      db,
      ACCOUNT,
      'hr_hr_interview_invite',
      'en'
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(vi.mocked(sendTemplate).mock.calls[0][0]).toMatchObject({
      to: PHONE,
      template: TEMPLATE_ROW,
      // {slot} comes first in the template, though the name's text also
      // appears earlier in the fixed wording ("Alignment").
      bodyParams: ['Monday 10:00', 'Ali'],
    });
  });

  it('a missing local template row throws before any gateway call', async () => {
    vi.mocked(resolveTemplateRow).mockResolvedValue({
      row: null,
    } as unknown as Awaited<ReturnType<typeof resolveTemplateRow>>);
    const { db } = fakeDb({});
    await expect(createHrSendPort(db).send(req())).rejects.toThrow(
      /no local template/
    );
    expect(gateway()).toBe(0);
  });
});

describe('createHrSendPort: linked devices', () => {
  it.each(['whapi', 'openwa'] as const)(
    '%s sends the rendered body as text',
    async (provider) => {
      vi.mocked(loadChannels).mockResolvedValue([channel({ provider })]);
      const { db, inserts } = fakeDb({});
      await createHrSendPort(db).send(req());
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(vi.mocked(sendText).mock.calls[0][0]).toMatchObject({
        to: PHONE,
        text: req().body,
      });
      expect(inserts[0].values).toMatchObject({
        content_type: 'text',
        content_text: req().body,
        template_name: null,
        provider,
      });
    }
  );
});

describe('createHrSendPort: refusals', () => {
  it('a personal chat throws before any gateway call', async () => {
    const { db } = fakeDb({ conv: baseConv({ personal_owner_id: 'u-1' }) });
    await expect(createHrSendPort(db).send(req())).rejects.toThrow(
      /personal chat/
    );
    expect(gateway()).toBe(0);
    expect(loadChannels).not.toHaveBeenCalled();
  });

  it('a personal number throws before any gateway call', async () => {
    vi.mocked(loadChannels).mockResolvedValue([channel({ isPersonal: true })]);
    const { db } = fakeDb({});
    await expect(createHrSendPort(db).send(req())).rejects.toThrow(
      /personal number/
    );
    expect(gateway()).toBe(0);
  });

  it('a chat whose own number is no longer connected throws', async () => {
    vi.mocked(loadChannels).mockResolvedValue([channel({ id: 'ch-other' })]);
    const { db } = fakeDb({});
    await expect(createHrSendPort(db).send(req())).rejects.toThrow(
      /not connected/
    );
    expect(resolveSendChannel).not.toHaveBeenCalled();
    expect(gateway()).toBe(0);
  });

  it('an account mismatch throws', async () => {
    const { db } = fakeDb({});
    await expect(
      createHrSendPort(db).send(req({ accountId: 'acc-2' }))
    ).rejects.toThrow(/conversation not found/);
    expect(gateway()).toBe(0);
  });

  it('a contact mismatch throws', async () => {
    const { db } = fakeDb({});
    await expect(
      createHrSendPort(db).send(req({ contactId: 'contact-2' }))
    ).rejects.toThrow(/contact/);
    expect(gateway()).toBe(0);
  });
});

describe('createHrSendPort: channel choice and record', () => {
  it('the pin wins over the number the chat is on', async () => {
    vi.mocked(loadChannels).mockResolvedValue([
      channel({ id: 'ch-own' }),
      channel({ id: 'ch-pin' }),
    ]);
    const { db, inserts } = fakeDb({
      conv: baseConv({ send_channel_id: 'ch-pin' }),
    });
    await createHrSendPort(db).send(req());
    expect(vi.mocked(sendTemplate).mock.calls[0][0].channel.id).toBe('ch-pin');
    expect(inserts[0].values.channel_id).toBe('ch-pin');
  });

  it('a chat with no number follows the inbox rule', async () => {
    vi.mocked(resolveSendChannel).mockResolvedValue(
      channel({ id: 'ch-inbox' })
    );
    const { db } = fakeDb({ conv: baseConv({ channel_id: null }) });
    await createHrSendPort(db).send(req());
    expect(vi.mocked(resolveSendChannel).mock.calls[0][2]).toBe('inbox');
    expect(vi.mocked(sendTemplate).mock.calls[0][0].channel.id).toBe(
      'ch-inbox'
    );
  });

  it("records a bot message on the number's channel id", async () => {
    const { db, inserts } = fakeDb({});
    await createHrSendPort(db).send(req());
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: 'messages',
      values: {
        conversation_id: CONV,
        sender_type: 'bot',
        content_type: 'template',
        content_text: req().body,
        template_name: 'hr_hr_interview_invite',
        message_id: 'wamid-1',
        status: 'sent',
        provider: 'meta',
        channel_id: 'ch-own',
      },
    });
  });

  it('a recipient-not-allowed error retries the next phone variant', async () => {
    vi.mocked(sendTemplate)
      .mockRejectedValueOnce(
        new Error('(#131030) Recipient not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid-2' } as never);
    const { db, updates } = fakeDb({});
    const out = await createHrSendPort(db).send(req());
    const tos = vi.mocked(sendTemplate).mock.calls.map((c) => c[0].to);
    expect(tos).toEqual([PHONE, '9071501234567']);
    expect(out.providerMessageId).toBe('wamid-2');
    expect(updates).toContainEqual({
      table: 'contacts',
      values: { phone: '9071501234567' },
    });
  });

  it('any other gateway error throws without retrying', async () => {
    vi.mocked(sendTemplate).mockRejectedValue(new Error('boom'));
    const { db } = fakeDb({});
    await expect(createHrSendPort(db).send(req())).rejects.toThrow('boom');
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('a failed messages insert after an accepted send returns messageId null', async () => {
    const { db } = fakeDb({
      messageInsert: { data: null, error: { message: 'insert failed' } },
    });
    await expect(createHrSendPort(db).send(req())).resolves.toEqual({
      providerMessageId: 'wamid-1',
      messageId: null,
    });
  });
});
