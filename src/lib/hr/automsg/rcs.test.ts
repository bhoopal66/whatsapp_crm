import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifySendFailure } from './failure';
import type { TemplateSendRequest } from './ports';
import { RcsSendError, createRcsSendPort } from './rcs';

const TOKEN = 'secret-token-xyz';
const CFG = {
  baseUrl: 'https://rcs.example/v1/',
  token: TOKEN,
  senderId: 'S1',
};
type Row = Record<string, unknown>;

function fakeDb(conv: Row | null, contact: Row | null): SupabaseClient {
  const tables: Record<string, Row | null> = {
    conversations: conv,
    contacts: contact,
  };
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push([c, v]), b),
        maybeSingle: async () => {
          const r = tables[table];
          const hit = r && filters.every(([c, v]) => r[c] === v);
          return { data: hit ? r : null, error: null };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const CONV = {
  id: 'c1',
  account_id: 'acc',
  contact_id: 'p1',
  personal_owner_id: null,
};
const CONTACT = { id: 'p1', account_id: 'acc', phone: '+971 50 123 4567' };

const REQ: TemplateSendRequest = {
  accountId: 'acc',
  conversationId: 'c1',
  contactId: 'p1',
  templateKind: 'hr_interview_invite',
  language: 'en',
  metaTemplateName: 'rcs-tpl-9',
  body: 'Hi Sara, see you Monday',
  templateBody: 'Hi {name}, {slot}. Bye {name}',
  params: { name: 'Sara', slot: 'Monday' },
};

function fetchOf(status: number, json: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const port = (f: typeof fetch, conv: Row | null = CONV, timeoutMs?: number) =>
  createRcsSendPort(fakeDb(conv, CONTACT), CFG, f, timeoutMs);

async function failure(p: Promise<unknown>): Promise<RcsSendError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  );
  expect(e).toBeInstanceOf(RcsSendError);
  expect(String((e as Error).message)).not.toContain(TOKEN);
  return e as RcsSendError;
}

describe('createRcsSendPort', () => {
  it('posts the template body with the bearer token and a normalised phone', async () => {
    const { f, calls } = fetchOf(200, { messageId: 'rcs-1' });
    await expect(port(f).send(REQ)).resolves.toEqual({
      providerMessageId: 'rcs-1',
      messageId: null,
    });
    expect(calls[0].url).toBe('https://rcs.example/v1/messages');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      to: '+971501234567',
      senderId: 'S1',
      templateId: 'rcs-tpl-9',
      language: 'en',
      params: [
        { name: 'name', value: 'Sara' },
        { name: 'slot', value: 'Monday' },
      ],
      clientRef: 'c1',
    });
  });

  it('accepts { id } as the provider id', async () => {
    const { f } = fetchOf(201, { id: 'x9' });
    await expect(port(f).send(REQ)).resolves.toMatchObject({
      providerMessageId: 'x9',
    });
  });

  it('a 2xx without an id is terminal no_message_id', async () => {
    const e = await failure(port(fetchOf(200, {}).f).send(REQ));
    expect([e.reason, e.retryable]).toEqual(['no_message_id', false]);
  });

  it.each([
    [429, 'rate_limited', true],
    [500, 'provider_unavailable', true],
    [503, 'provider_unavailable', true],
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
    [400, 'rejected', false],
    [404, 'rejected', false],
  ])('http %i -> %s (retryable %s)', async (status, reason, retryable) => {
    const e = await failure(
      port(fetchOf(status, { error: TOKEN }).f).send(REQ)
    );
    expect([e.reason, e.retryable, e.status]).toEqual([
      reason,
      retryable,
      status,
    ]);
  });

  it('a network error is retryable and never echoes its text', async () => {
    const f = (async () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    }) as unknown as typeof fetch;
    const e = await failure(port(f).send(REQ));
    expect([e.reason, e.retryable]).toEqual(['network', true]);
  });

  it('a timeout is retryable', async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_ok, bad) =>
        init.signal!.addEventListener('abort', () => bad(new Error('aborted')))
      )) as unknown as typeof fetch;
    const e = await failure(port(f, CONV, 5).send(REQ));
    expect([e.reason, e.retryable]).toEqual(['timeout', true]);
  });

  it('refuses a personal chat before any call', async () => {
    const { f, calls } = fetchOf(200, { messageId: 'x' });
    const e = await failure(
      port(f, { ...CONV, personal_owner_id: 'u1' }).send(REQ)
    );
    expect([e.reason, e.retryable]).toEqual(['personal_number', false]);
    expect(calls).toEqual([]);
  });

  it('refuses another account’s chat', async () => {
    const { f, calls } = fetchOf(200, { messageId: 'x' });
    const e = await failure(
      port(f, { ...CONV, account_id: 'other' }).send(REQ)
    );
    expect(e.reason).toBe('conversation_missing');
    expect(calls).toEqual([]);
  });
});

describe('classifySendFailure: RCS', () => {
  it.each([
    ['timeout', true],
    ['rate_limited', true],
    ['unauthorized', false],
    ['no_message_id', false],
  ])('%s keeps its own reason (retryable %s)', (reason, retryable) => {
    expect(classifySendFailure(new RcsSendError(reason, retryable))).toEqual({
      retryable,
      reason,
    });
  });
});
