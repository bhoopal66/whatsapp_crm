import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/hr/automsg/rcs-config', () => ({ rcsWebhookConfig: h.config }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

import { POST } from './route';

const SECRET = 'rcs-test-secret-0123456789';
const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const URL = 'http://localhost/api/rcs/webhook';

const sign = (body: string, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

function post(body: string, headers: Record<string, string> = {}) {
  return new Request(URL, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const BODY = JSON.stringify({
  // the payload's own account-ish field must never be used
  accountId: '99999999-9999-9999-9999-999999999999',
  events: [
    { messageId: 'm1', status: 'delivered', timestamp: '2026-11-20T10:00:00Z' },
    { messageId: 'm2', status: 'failed', timestamp: 1763632800 },
    { messageId: 'm3', status: 'read', timestamp: 1763632800 },
    { status: 'read' },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.config.mockReturnValue({ secret: SECRET, accountId: ACCOUNT });
  h.rpc.mockResolvedValue({ data: 'recorded', error: null });
});

describe('POST /api/rcs/webhook', () => {
  it('answers 501 not_configured while RCS is off', async () => {
    h.config.mockReturnValue(null);
    const res = await POST(post(BODY, { 'x-rcs-signature': sign(BODY) }));
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toEqual({ error: 'not_configured' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('answers 413 on a declared oversize body', async () => {
    const res = await POST(
      post(BODY, {
        'x-rcs-signature': sign(BODY),
        'content-length': String(256 * 1024 + 1),
      })
    );
    expect(res.status).toBe(413);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('answers 413 on an oversize body with no usable Content-Length', async () => {
    const big = 'x'.repeat(256 * 1024 + 1);
    const res = await POST(post(big, { 'x-rcs-signature': sign(big) }));
    expect(res.status).toBe(413);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('answers 401 on a bad signature and records nothing', async () => {
    const res = await POST(
      post(BODY, { 'x-rcs-signature': sign(BODY, 'wrong-secret-xxxxxxxx') })
    );
    expect(res.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('answers 401 on a missing signature and records nothing', async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('records each receipt on the configured workspace with channel rcs', async () => {
    h.rpc
      .mockResolvedValueOnce({ data: 'recorded', error: null })
      .mockResolvedValueOnce({ data: 'failed_terminal', error: null })
      .mockResolvedValueOnce({ data: 'unknown_message', error: null });
    const res = await POST(post(BODY, { 'x-rcs-signature': sign(BODY) }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      counts: {
        recorded: 1,
        failed_terminal: 1,
        unknown_message: 1,
        ignored: 1,
      },
    });
    expect(h.rpc).toHaveBeenCalledTimes(3);
    expect(h.rpc).toHaveBeenNthCalledWith(1, 'hr_automsg_delivery_record', {
      p_account_id: ACCOUNT,
      p_provider_message_id: 'm1',
      p_state: 'delivered',
      p_at: '2026-11-20T10:00:00.000Z',
      p_reason: null,
      p_channel: 'rcs',
    });
    expect(h.rpc).toHaveBeenNthCalledWith(2, 'hr_automsg_delivery_record', {
      p_account_id: ACCOUNT,
      p_provider_message_id: 'm2',
      p_state: 'failed',
      p_at: new Date(1763632800 * 1000).toISOString(),
      p_reason: 'unknown',
      p_channel: 'rcs',
    });
  });

  it('keeps going when one receipt fails', async () => {
    h.rpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'x' },
      })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ data: 'unchanged', error: null });
    const res = await POST(post(BODY, { 'x-rcs-signature': sign(BODY) }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      counts: { error: 2, unchanged: 1, ignored: 1 },
    });
    expect(h.rpc).toHaveBeenCalledTimes(3);
  });
});
