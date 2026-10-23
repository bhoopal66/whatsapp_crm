import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}));

// Control the SSRF guard per-test. Delivery goes through the guard's
// address-pinned `safeFetch`, not the global fetch.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
  safeFetch: vi.fn(),
}));

import { dispatchWebhookEvent, MAX_CONSECUTIVE_FAILURES } from './deliver';
import { isDeliverableUrl, safeFetch } from './ssrf';

interface Row {
  id: string;
  url: string;
  secret: string;
}
interface Calls {
  updates: { id: string; payload: Record<string, unknown> }[];
  rpcs: { name: string; args: Record<string, unknown> }[];
}

function makeDb(rows: Row[], calls: Calls) {
  const from = () => {
    let mode: 'select' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    let id: string | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: string) => {
        if (col === 'id') id = val;
        return b;
      },
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;
        return b;
      },
      contains: () => Promise.resolve({ data: rows, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'update' && id) calls.updates.push({ id, payload });
        return resolve({ data: null, error: null });
      },
    };
    return b;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.rpcs.push({ name, args });
    return Promise.resolve({ data: null, error: null });
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const emptyCalls = (): Calls => ({ updates: [], rpcs: [] });

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.mocked(safeFetch).mockReset();
  // Nothing may bypass the guard through the global fetch.
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('dispatchWebhookEvent', () => {
  it('signs + POSTs (no redirect follow) and resets failure_count on success', async () => {
    const fetchMock = vi
      .mocked(safeFetch)
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'a', url: 'https://a.test/hook', secret: 's1' }], calls),
      'acct-1',
      'message.received',
      { x: 1 }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Taamul-Event']).toBe('message.received');
    expect(opts.headers['X-Taamul-Signature']).toMatch(
      /^t=\d+,v1=[0-9a-f]{64}$/
    );
    // Pre-rebrand header names still ship, carrying the identical
    // value, so receivers written against them keep verifying.
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received');
    expect(opts.headers['X-Wacrm-Signature']).toBe(
      opts.headers['X-Taamul-Signature']
    );
    // Payload carries a dedupe id.
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/);
    expect(calls.updates[0]).toMatchObject({
      id: 'a',
      payload: { failure_count: 0 },
    });
    expect(calls.rpcs).toHaveLength(0);
  });

  it('records an atomic failure (RPC) when the endpoint errors', async () => {
    vi.mocked(safeFetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'b', url: 'https://b.test/hook', secret: 's2' }], calls),
      'acct-1',
      'message.received',
      {}
    );

    expect(calls.rpcs[0]).toEqual({
      name: 'record_webhook_failure',
      args: { endpoint_id: 'b', max_failures: MAX_CONSECUTIVE_FAILURES },
    });
    expect(calls.updates).toHaveLength(0);
  });

  it('blocks a non-public target (SSRF guard) without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.mocked(safeFetch);
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }], calls),
      'acct-1',
      'message.received',
      {}
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs[0].name).toBe('record_webhook_failure');
  });

  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.mocked(safeFetch);
    const calls = emptyCalls();
    await dispatchWebhookEvent(
      makeDb([], calls),
      'acct-1',
      'message.received',
      {}
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });
});
