import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DinstarSendError,
  createDinstarSmsSendPort,
  pinnedIdentity,
  resetDinstarPace,
  smsUserId,
} from './dinstar';
import { classifySendFailure } from './failure';
import type { TemplateSendRequest } from './ports';
import type { SmsSendConfig } from './sms-config';

const PASSWORD = 'gw-password-xyz';
const CFG: SmsSendConfig = {
  baseUrl: 'https://gw.example/',
  username: 'admin',
  password: PASSWORD,
  maxPerMinute: 10,
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
const PHONE = '+971 50 123 4567';
const CONTACT = { id: 'p1', account_id: 'acc', phone: PHONE };

const REQ: TemplateSendRequest = {
  outboxId: 'ob-1',
  accountId: 'acc',
  conversationId: 'c1',
  contactId: 'p1',
  templateKind: 'hr_interview_invite',
  language: 'en',
  metaTemplateName: 'hr-invite.sms',
  body: 'Hi Sara, see you Monday',
  templateBody: 'Hi {name}, see you {slot}',
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

const ACCEPTED = { error_code: 202, sn: 'sn-1', task_id: 77 };

const port = (
  f: typeof fetch,
  opts: { conv?: Row | null; cfg?: SmsSendConfig; now?: () => number } = {}
) =>
  createDinstarSmsSendPort(
    fakeDb(opts.conv === undefined ? CONV : opts.conv, CONTACT),
    opts.cfg ?? CFG,
    f,
    undefined,
    opts.now
  );

async function failure(p: Promise<unknown>): Promise<DinstarSendError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  );
  expect(e).toBeInstanceOf(DinstarSendError);
  const msg = String((e as Error).message);
  expect(msg).not.toContain(PASSWORD);
  expect(msg).not.toContain('971501234567');
  return e as DinstarSendError;
}

beforeEach(() => resetDinstarPace());

describe('createDinstarSmsSendPort', () => {
  it('posts the rendered body to one number with Basic auth', async () => {
    const { f, calls } = fetchOf(200, ACCEPTED);
    const uid = smsUserId('ob-1');
    await expect(port(f).send(REQ)).resolves.toEqual({
      providerMessageId: `77:${uid}`,
      messageId: null,
    });
    expect(calls[0].url).toBe('https://gw.example/api/send_sms');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe(
      `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      text: 'Hi Sara, see you Monday',
      param: [{ number: '+971501234567', user_id: uid }],
      encoding: 'gsm-7bit',
      request_status_report: true,
    });
  });

  it('names the SIM ports when configured, and Unicode for Arabic', async () => {
    const { f, calls } = fetchOf(200, ACCEPTED);
    await port(f, { cfg: { ...CFG, ports: [0, 3] } }).send({
      ...REQ,
      body: 'مرحبا سارة',
    });
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.port).toEqual([0, 3]);
    expect(sent.encoding).toBe('unicode');
  });

  it('keeps one user_id per outbox row, across retries', () => {
    expect(smsUserId('ob-1')).toBe(smsUserId('ob-1'));
    expect(smsUserId('ob-1')).not.toBe(smsUserId('ob-2'));
    for (const id of ['ob-1', 'ob-2', 'x']) {
      expect(Number.isInteger(smsUserId(id))).toBe(true);
      expect(smsUserId(id)).toBeGreaterThan(0);
      expect(smsUserId(id)).toBeLessThan(2 ** 31);
    }
  });

  it('falls back to sn when there is no task_id', async () => {
    const { f } = fetchOf(200, { error_code: 202, sn: 'sn-9' });
    await expect(port(f).send(REQ)).resolves.toMatchObject({
      providerMessageId: `sn-9:${smsUserId('ob-1')}`,
    });
  });

  it('a 202 without task_id or sn is terminal no_task_id', async () => {
    const e = await failure(
      port(fetchOf(200, { error_code: 202 }).f).send(REQ)
    );
    expect([e.reason, e.retryable]).toEqual(['no_task_id', false]);
  });

  it.each([
    [400, 'invalid_request', false],
    [413, 'too_large', false],
    [500, 'gateway_error', false],
    [550, 'no_available_port', true],
    [999, 'unexpected_response', false],
  ])('error_code %i -> %s (retryable %s)', async (code, reason, retryable) => {
    const e = await failure(
      port(fetchOf(200, { error_code: code }).f).send(REQ)
    );
    expect([e.reason, e.retryable]).toEqual([reason, retryable]);
  });

  it.each([
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
    [404, 'rejected', false],
    [500, 'gateway_unavailable', false],
    [503, 'gateway_unavailable', false],
  ])('http %i -> %s (retryable %s)', async (status, reason, retryable) => {
    const e = await failure(
      port(fetchOf(status, { error: PASSWORD }).f).send(REQ)
    );
    expect([e.reason, e.retryable, e.status]).toEqual([
      reason,
      retryable,
      status,
    ]);
  });

  it('an unreadable 200 is terminal, never resent', async () => {
    const f = (async () =>
      new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const e = await failure(port(f).send(REQ));
    expect([e.reason, e.retryable]).toEqual(['unexpected_response', false]);
  });

  it('a gateway that was never reached is retryable', async () => {
    const f = (async () => {
      throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    }) as unknown as typeof fetch;
    const e = await failure(port(f).send(REQ));
    expect([e.reason, e.retryable]).toEqual(['not_reached', true]);
  });

  it('a lost connection is never resent and does not echo the request', async () => {
    const f = (async () => {
      throw new Error(`connect failed ${PASSWORD} +971501234567`);
    }) as unknown as typeof fetch;
    const e = await failure(port(f).send(REQ));
    expect([e.reason, e.retryable]).toEqual(['network', false]);
  });

  it('a stalled body read is terminal, never resent', async () => {
    const f = (async (_u: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('x')))
        ),
    })) as unknown as typeof fetch;
    const p = createDinstarSmsSendPort(fakeDb(CONV, CONTACT), CFG, f, 20);
    const e = await failure(p.send(REQ));
    // The body never arrived: terminal, the gateway may hold the message.
    expect([e.reason, e.retryable]).toEqual(['unexpected_response', false]);
  });

  it('a request that never answers is never resent', async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('x')))
      )) as unknown as typeof fetch;
    const p = createDinstarSmsSendPort(fakeDb(CONV, CONTACT), CFG, f, 20);
    const e = await failure(p.send(REQ));
    expect([e.reason, e.retryable]).toEqual(['timeout', false]);
  });

  it('refuses a text over 3 segments before any call', async () => {
    const { f, calls } = fetchOf(200, ACCEPTED);
    const e = await failure(port(f).send({ ...REQ, body: 'a'.repeat(460) }));
    expect([e.reason, e.retryable]).toEqual(['text_too_long', false]);
    expect(calls).toHaveLength(0);
  });

  it('refuses a blank body, a personal chat and a bad number before any call', async () => {
    const { f, calls } = fetchOf(200, ACCEPTED);
    expect((await failure(port(f).send({ ...REQ, body: '  ' }))).reason).toBe(
      'no_template_body'
    );
    expect(
      (
        await failure(
          port(f, { conv: { ...CONV, personal_owner_id: 'u1' } }).send(REQ)
        )
      ).reason
    ).toBe('personal_number');
    const badContact = createDinstarSmsSendPort(
      fakeDb(CONV, { ...CONTACT, phone: '12' }),
      CFG,
      f
    );
    expect((await failure(badContact.send(REQ))).reason).toBe('invalid_number');
    expect(calls).toHaveLength(0);
  });

  it('paces sends per gateway across sender instances', async () => {
    let t = 1_000_000;
    const now = () => t;
    const cfg = { ...CFG, maxPerMinute: 2 };
    const { f, calls } = fetchOf(200, ACCEPTED);
    // The drain builds a new sender every pass: the limit must hold anyway.
    expect(port(f, { cfg, now }).hasCapacity?.()).toBe(true);
    await port(f, { cfg, now }).send(REQ);
    await port(f, { cfg, now }).send(REQ);
    const third = port(f, { cfg, now });
    expect(third.hasCapacity?.()).toBe(false);
    const e = await failure(third.send(REQ));
    expect([e.reason, e.retryable]).toEqual(['rate_limited', true]);
    expect(calls).toHaveLength(2);
    // Half a minute refills one of two.
    t += 30_000;
    expect(third.hasCapacity?.()).toBe(true);
    // Another gateway has its own bucket.
    const other = port(f, {
      cfg: { ...cfg, baseUrl: 'https://gw2.example' },
      now,
    });
    expect(other.hasCapacity?.()).toBe(true);
  });

  it('classifies its own failures', () => {
    expect(
      classifySendFailure(new DinstarSendError('no_available_port', true, 550))
    ).toEqual({ retryable: true, reason: 'no_available_port' });
    expect(
      classifySendFailure(new DinstarSendError('text_too_long', false))
    ).toEqual({ retryable: false, reason: 'text_too_long' });
  });
});

describe('pinnedIdentity', () => {
  const fp = 'AB:CD:' + 'ef'.repeat(30);
  it('accepts only the pinned certificate, colons and case aside', () => {
    const check = pinnedIdentity(fp);
    expect(
      check('gw', { fingerprint256: fp.toLowerCase() } as never)
    ).toBeUndefined();
    expect(
      check('gw', { fingerprint256: 'AB:CD:' + 'ee'.repeat(30) } as never)
    ).toBeInstanceOf(Error);
    expect(check('gw', {} as never)).toBeInstanceOf(Error);
  });
});
