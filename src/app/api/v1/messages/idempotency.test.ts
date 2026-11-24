import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  send: vi.fn(),
  twins: vi.fn(),
  rows: [] as Record<string, unknown>[],
  /** Error answered by the next write of that kind, or by every one. */
  fail: {} as Record<string, { code: string } | undefined>,
}));

/** v1_message_keys in memory: unique key, filters, one write at a time. */
function table() {
  const match: ((r: Row) => boolean)[] = [];
  let op = 'select';
  let fields: Row = {};
  const run = () => {
    const failure = h.fail[op];
    if (failure) return { data: null, error: failure };
    if (op === 'insert') {
      const same = ['account_id', 'api_key_id', 'key'];
      if (h.rows.some((r) => same.every((c) => r[c] === fields[c]))) {
        return { data: null, error: { code: '23505' } };
      }
      const row = {
        id: `r${h.rows.length}`,
        state: 'claimed',
        response: null,
        ...fields,
      };
      h.rows.push(row);
      return { data: row, error: null };
    }
    const hit = h.rows.filter((r) => match.every((m) => m(r)));
    if (op === 'update') hit.forEach((r) => Object.assign(r, fields));
    return { data: hit.map((r) => ({ ...r })), error: null };
  };
  const chain = {
    select: () => chain,
    insert: (f: Row) => ((op = 'insert'), (fields = f), chain),
    update: (f: Row) => ((op = 'update'), (fields = f), chain),
    eq: (c: string, v: unknown) => (match.push((r) => r[c] === v), chain),
    in: (c: string, v: unknown[]) => (
      match.push((r) => v.includes(r[c])),
      chain
    ),
    single: async () => run(),
    maybeSingle: async () => {
      const { data, error } = run();
      return { data: (data as Row[] | null)?.[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => void) => resolve(run()),
  };
  return chain;
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async (request: Request) => ({
    accountId: 'acct-1',
    keyId: request.headers.get('authorization') ?? 'key-1',
    supabase: { from: () => table() },
  })),
}));
vi.mock('@/lib/contacts/dedupe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/dedupe')>()),
  findMatchingContacts: h.twins,
}));
vi.mock('@/lib/whatsapp/resolve-conversation', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/whatsapp/resolve-conversation')
  >()),
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'cv-1',
    contactId: 'c-1',
    contactCreated: true,
  })),
}));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: h.send,
}));

import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { purgeMessageKeys } from '@/lib/api/v1/message-keys';
import { POST } from './route';

const HI = { to: '+971501234567', text: 'Hi' };
const ANSWER = {
  message_id: 'm-1',
  whatsapp_message_id: 'wamid-1',
  conversation_id: 'cv-1',
  contact_id: 'c-1',
  contact_created: true,
};

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(
    new Request('http://x/api/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  );
  const json = await res.json();
  return {
    status: res.status,
    data: json.data,
    code: json.error?.code,
    retryAfter: res.headers.get('Retry-After'),
  };
}
const keyed = (body: unknown = HI, key = 'k-1') =>
  post(body, { 'Idempotency-Key': key });

/** The core: past `beforeGateway` the message is at the gateway. */
const gateway = vi.fn();
type Params = { beforeGateway?: () => Promise<void> };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useRealTimers();
  h.rows.length = 0;
  h.fail = {};
  h.twins.mockReset().mockResolvedValue([]);
  vi.mocked(resolveConversationByPhone).mockClear();
  gateway.mockReset().mockResolvedValue({
    messageId: 'm-1',
    whatsappMessageId: 'wamid-1',
  });
  h.send.mockReset().mockImplementation(async (_db, _acct, p: Params) => {
    await p.beforeGateway?.();
    return gateway();
  });
});

describe('POST /api/v1/messages without a key', () => {
  it('sends every time and touches no key', async () => {
    h.fail = { insert: { code: 'PGRST205' }, select: { code: 'PGRST205' } };
    expect(await post(HI)).toMatchObject({ status: 201, data: ANSWER });
    expect(await post({ ...HI, idempotency_key: null })).toMatchObject({
      status: 201,
    });
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(h.rows).toEqual([]);
  });

  it('answers 201 not_recorded when WhatsApp took it unsaved', async () => {
    const err = new SendMessageError('db_error', 'Not saved', 500, false);
    err.whatsappMessageId = 'wamid-1';
    gateway.mockRejectedValue(err);
    expect(await post(HI)).toMatchObject({
      status: 201,
      data: { ...ANSWER, message_id: null, warning: 'not_recorded' },
    });
  });
});

describe('POST /api/v1/messages with a key', () => {
  it('claims before the send and settles after', async () => {
    gateway.mockImplementation(async () => {
      expect(h.rows).toMatchObject([
        { state: 'claimed', contact_id: 'c-1', key: 'k-1' },
      ]);
      return { messageId: 'm-1', whatsappMessageId: 'wamid-1' };
    });
    expect(await keyed()).toMatchObject({ status: 201, data: ANSWER });
    expect(h.rows).toMatchObject([
      {
        account_id: 'acct-1',
        api_key_id: 'key-1',
        state: 'sent',
        message_id: 'm-1',
        response: ANSWER,
      },
    ]);
    expect(JSON.stringify(h.rows)).not.toContain('Hi');
  });

  it('answers a repeat with the first answer and sends nothing', async () => {
    await keyed();
    // Opted out since: the repeat is still the first request.
    h.twins.mockResolvedValue([{ opted_out_at: '2026-11-01T00:00:00Z' }]);
    const body = { text: 'Hi', idempotency_key: 'k-1', to: HI.to };
    for (const again of [await keyed(), await post(body)]) {
      expect(again).toMatchObject({
        status: 200,
        data: { ...ANSWER, replayed: true },
      });
    }
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('answers a repeat of an unsaved send the same way', async () => {
    gateway.mockRejectedValue(
      new SendMessageError('db_error', 'Not saved', 500, false)
    );
    await keyed();
    expect(await keyed()).toMatchObject({
      status: 200,
      data: { warning: 'not_recorded', replayed: true },
    });
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('refuses another body, and keeps another API key apart', async () => {
    await keyed();
    expect(await keyed({ ...HI, text: 'Bye' })).toMatchObject({
      status: 409,
      code: 'idempotency_key_reused',
    });
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(
      await post(HI, { 'Idempotency-Key': 'k-1', Authorization: 'key-2' })
    ).toMatchObject({ status: 201 });
  });

  it('answers in_progress while the first is being sent', async () => {
    let during;
    gateway.mockImplementation(async () => {
      during = await keyed();
      return { messageId: 'm-1', whatsappMessageId: 'wamid-1' };
    });
    expect(await keyed()).toMatchObject({ status: 201 });
    expect(during).toMatchObject({
      status: 409,
      code: 'in_progress',
      retryAfter: '5',
    });
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('never sends again for a process that died', async () => {
    await keyed();
    h.rows[0].state = 'claimed';
    h.rows[0].response = null;
    h.rows[0].claimed_at = new Date(Date.now() - 121_000).toISOString();
    for (let i = 0; i < 2; i++) {
      expect(await keyed()).toMatchObject({
        status: 409,
        code: 'delivery_unconfirmed',
      });
    }
    expect(h.rows[0].state).toBe('unconfirmed');
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('is unconfirmed when the gateway may have taken it', async () => {
    gateway.mockRejectedValueOnce(
      new SendMessageError('whatsapp_error', 'timeout', 502, false)
    );
    for (let i = 0; i < 2; i++) {
      expect(await keyed()).toMatchObject({
        status: 409,
        code: 'delivery_unconfirmed',
      });
    }
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('tries again after a certain refusal', async () => {
    gateway.mockRejectedValueOnce(
      new SendMessageError('whatsapp_error', 'refused', 502, true)
    );
    expect(await keyed()).toMatchObject({ code: 'whatsapp_error' });
    expect(h.rows[0].state).toBe('failed');
    h.twins.mockResolvedValueOnce([{ opted_out_at: '2026-11-01T00:00:00Z' }]);
    expect(await keyed()).toMatchObject({ code: 'customer_opted_out' });
    expect(h.rows[0].state).toBe('failed');
    vi.mocked(resolveConversationByPhone).mockRejectedValueOnce(new Error());
    expect(await keyed()).toMatchObject({ status: 500 });
    expect(h.rows[0].state).toBe('failed');
    expect(await keyed()).toMatchObject({ status: 201 });
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  it('does not send once the claim was called unconfirmed', async () => {
    h.send.mockImplementation(async (_db, _acct, p: Params) => {
      h.rows[0].state = 'unconfirmed';
      await p.beforeGateway?.();
      return gateway();
    });
    expect(await keyed()).toMatchObject({ status: 503, code: 'unavailable' });
    expect(gateway).not.toHaveBeenCalled();
    expect(h.rows[0].state).toBe('failed');
  });

  it('answers 201 even when the outcome cannot be stored', async () => {
    gateway.mockImplementation(async () => {
      h.fail = { update: { code: '57014' } };
      return { messageId: 'm-1', whatsappMessageId: 'wamid-1' };
    });
    expect(await keyed()).toMatchObject({ status: 201, data: ANSWER });
    expect(h.rows[0].state).toBe('claimed');
  });

  it.each(['PGRST205', '42P01', '57014'])(
    'sends nothing and answers 503 without a claim (%s)',
    async (code) => {
      h.fail = { insert: { code } };
      expect(await keyed()).toMatchObject({
        status: 503,
        code: 'unavailable',
        retryAfter: '5',
      });
      expect(resolveConversationByPhone).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['header', '', undefined],
    ['header', 'x'.repeat(201), undefined],
    ['body', null, 12],
    ['body', null, 'a\nb'],
    ['both', 'k-1', 'k-2'],
  ])('refuses an unusable key (%s, %o, %o)', async (_w, header, field) => {
    const res = await post(
      field === undefined ? HI : { ...HI, idempotency_key: field },
      header === null ? {} : { 'Idempotency-Key': header }
    );
    expect(res).toMatchObject({ status: 400, code: 'bad_request' });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('purgeMessageKeys', () => {
  const purge = (error: unknown) => {
    const lt = vi.fn(async () => ({ error }));
    const db = { from: () => ({ delete: () => ({ lt }) }) };
    return { lt, done: purgeMessageKeys(db as never) };
  };

  it('forgets what is older than 30 days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-30T00:00:00Z'));
    const { lt, done } = purge(null);
    await done;
    expect(lt).toHaveBeenCalledWith('created_at', '2026-10-31T00:00:00.000Z');
  });

  it('is nothing before migration 305, and throws otherwise', async () => {
    await purge({ code: 'PGRST205' }).done;
    await expect(purge({ code: '57014' }).done).rejects.toThrow();
  });
});
