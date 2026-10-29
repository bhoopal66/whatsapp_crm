import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  COMPOSE_CHECK_CODES_BY_SEVERITY,
  orderWarnings,
  parseComposeCheckStats,
  reportComposeCheckOutcome,
  requestComposeCheck,
  shouldCheckDraft,
  topCodes,
  warningTone,
} from './compose-check-view';

const CONV = '00000000-0000-4000-8000-000000000001';

function answer(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    json: async () => body,
  }));
}

describe('code list', () => {
  it('holds exactly the server module codes (read as text, never imported)', () => {
    const src = readFileSync(join(__dirname, 'compose-check.ts'), 'utf8').match(
      /COMPOSE_WARNING_CODES = \[([\s\S]*?)\]/
    );
    const server = [...(src?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1]
    );
    expect(server.length).toBe(7);
    expect([...COMPOSE_CHECK_CODES_BY_SEVERITY].sort()).toEqual(server.sort());
  });
});

describe('shouldCheckDraft', () => {
  it('checks only in warn mode and from 12 trimmed characters', () => {
    expect(shouldCheckDraft('warn', 'twelve chars')).toBe(true);
    expect(shouldCheckDraft('warn', '   eleven ch   ')).toBe(false);
    expect(shouldCheckDraft('off', 'a long enough message')).toBe(false);
    expect(shouldCheckDraft(undefined, 'a long enough message')).toBe(false);
  });
});

describe('orderWarnings', () => {
  it('orders by severity, drops unknown codes and repeats', () => {
    expect(
      orderWarnings([
        'tone',
        'promise',
        'nope',
        'secrets',
        'tone',
        'cold_pitch',
      ])
    ).toEqual(['secrets', 'promise', 'cold_pitch', 'tone']);
    expect(
      orderWarnings(['non_partner_bank', 'regulator_claim', 'terms'])
    ).toEqual(['terms', 'regulator_claim', 'non_partner_bank']);
  });

  it('gives secrets the destructive tone, the rest warning', () => {
    expect(warningTone('secrets')).toBe('destructive');
    expect(warningTone('tone')).toBe('warning');
  });
});

describe('requestComposeCheck', () => {
  it('asks the route and opens a review on warnings', async () => {
    const fetchImpl = answer(200, {
      warnings: [
        { code: 'tone', source: 'jev' },
        { code: 'secrets', source: 'rule' },
      ],
      eventId: 'ev-1',
    });
    const d = await requestComposeCheck({
      conversationId: CONV,
      text: 'send me your OTP now',
      fetchImpl,
    });
    expect(d).toEqual({
      kind: 'review',
      warnings: ['secrets', 'tone'],
      eventId: 'ev-1',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/insights/compose-check');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      conversationId: CONV,
      text: 'send me your OTP now',
    });
  });

  it('sends when there are no (known) warnings', async () => {
    for (const body of [
      { warnings: [], eventId: null },
      { warnings: [{ code: 'unknown' }], eventId: 'x' },
      { nothing: true },
      null,
    ]) {
      const d = await requestComposeCheck({
        conversationId: CONV,
        text: 'hello there friend',
        fetchImpl: answer(200, body),
      });
      expect(d).toEqual({ kind: 'send' });
    }
  });

  it('fails open on 429, 500, a network error or a bad body', async () => {
    for (const fetchImpl of [
      answer(429, { error: 'slow down' }),
      answer(500, { warnings: [{ code: 'tone' }] }),
      vi.fn(async () => {
        throw new Error('offline');
      }),
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      })),
    ]) {
      const d = await requestComposeCheck({
        conversationId: CONV,
        text: 'hello there friend',
        fetchImpl,
      });
      expect(d).toEqual({ kind: 'send' });
    }
  });

  it('sends when the answer does not come within the timeout', async () => {
    let aborted = false;
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })
    );
    const d = await requestComposeCheck({
      conversationId: CONV,
      text: 'hello there friend',
      timeoutMs: 20,
      fetchImpl,
    });
    expect(d).toEqual({ kind: 'send' });
    expect(aborted).toBe(true);
  });

  it('times out a stalled body read too', async () => {
    const d = await requestComposeCheck({
      conversationId: CONV,
      text: 'hello there friend',
      timeoutMs: 20,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: () => new Promise<never>(() => {}),
      })),
    });
    expect(d).toEqual({ kind: 'send' });
  });

  it('answers cancelled, never send, when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = requestComposeCheck({
      conversationId: CONV,
      text: 'hello there friend',
      signal: controller.signal,
      fetchImpl: vi.fn(() => new Promise<never>(() => {})),
    });
    controller.abort();
    expect(await pending).toEqual({ kind: 'cancelled' });

    const late = new AbortController();
    late.abort();
    expect(
      await requestComposeCheck({
        conversationId: CONV,
        text: 'hello there friend',
        signal: late.signal,
        fetchImpl: answer(200, { warnings: [{ code: 'tone' }] }),
      })
    ).toEqual({ kind: 'cancelled' });
  });
});

describe('reportComposeCheckOutcome', () => {
  it('PATCHes the outcome and swallows failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(() =>
      reportComposeCheckOutcome('ev-1', 'edited', fetchImpl)
    ).not.toThrow();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/insights/compose-check/ev-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'edited' });
    await Promise.resolve();
  });

  it('does nothing without an event id', () => {
    const fetchImpl = vi.fn();
    reportComposeCheckOutcome(null, 'sent_anyway', fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('stats', () => {
  it('parses the route answer tolerantly', () => {
    expect(parseComposeCheckStats(null)).toBeNull();
    expect(parseComposeCheckStats({ error: 'x' })).toBeNull();
    expect(
      parseComposeCheckStats({
        days: 7,
        total: 9,
        sentAnyway: 3,
        edited: 5,
        pending: 1,
        byCode: { tone: 4, promise: 2, bogus: 8, terms: -1 },
      })
    ).toEqual({
      days: 7,
      total: 9,
      sentAnyway: 3,
      edited: 5,
      pending: 1,
      byCode: { tone: 4, promise: 2, terms: 0 },
    });
  });

  it('picks the top three by count, ties by severity, never zeros', () => {
    expect(
      topCodes({ tone: 5, promise: 5, terms: 2, cold_pitch: 7, secrets: 1 })
    ).toEqual([
      { code: 'cold_pitch', count: 7 },
      { code: 'promise', count: 5 },
      { code: 'tone', count: 5 },
    ]);
    expect(topCodes({ tone: 1, terms: 0 })).toEqual([
      { code: 'tone', count: 1 },
    ]);
    expect(topCodes({})).toEqual([]);
  });
});
