import { beforeEach, describe, expect, it, vi } from 'vitest';

// The legacy one-shot batch route: phone numbers stay out of the log,
// and a Meta media template with no media is refused once per batch.

const h = vi.hoisted(() => ({
  provider: 'whapi' as 'whapi' | 'meta',
  template: {} as Record<string, unknown>,
  sendTemplate: vi.fn(),
  autoCheck: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  assertSalesAccess: (c: unknown) => c,
  requireRole: vi.fn(async () => ({
    supabase: {},
    accountId: 'acct-1',
    userId: 'user-1',
  })),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: String(err) }, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { broadcast: {} },
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  resolveChannelForSurface: vi.fn(async () => ({
    id: 'cfg-1',
    provider: h.provider,
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })),
  ChannelError: class extends Error {},
  isLinkedDeviceProvider: (p: string) => p === 'whapi' || p === 'openwa',
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/team-activity/auto-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/team-activity/auto-guard')>()),
  checkAutoStartAllowed: (...args: unknown[]) => h.autoCheck(...args),
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({
    row: {
      id: 'tpl-1',
      user_id: 'u-1',
      name: 'promo',
      language: 'en',
      body_text: 'Hello',
      ...h.template,
    },
    language: 'en',
    malformed: false,
  })),
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  sendTemplate: (...args: unknown[]) => h.sendTemplate(...args),
  describeSendFailure: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

import { POST } from './route';

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.provider = 'whapi';
  h.template = {};
  h.sendTemplate.mockReset();
  h.autoCheck.mockReset();
  h.autoCheck.mockResolvedValue({ blocked: false });
});

describe('POST /api/whatsapp/broadcast — logging', () => {
  it('logs a failed recipient by the last four digits only', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendTemplate.mockRejectedValue(new Error('Invalid parameter'));

    const res = await post({
      template_name: 'promo',
      recipients: [{ phone: '+971 50 123 4567', params: [] }],
    });

    expect(res.status).toBe(200);
    const lines = logged.mock.calls.map((c) => c.map(String).join(' '));
    expect(lines.join('\n')).not.toMatch(/501234567|50 123 4567/);
    expect(lines.some((l) => l.includes('…4567'))).toBe(true);
    // The caller, who sent the numbers, still gets them back.
    expect((await res.json()).results[0].phone).toBe('+971 50 123 4567');
    logged.mockRestore();
  });
});

describe('POST /api/whatsapp/broadcast — header media on Meta', () => {
  it('refuses the batch before sending anything', async () => {
    h.provider = 'meta';
    h.template = { header_type: 'video' };

    const res = await post({
      template_name: 'promo',
      recipients: [{ phone: '+14155550123', params: [] }],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'template_media_missing',
      error:
        'Template promo (en) has a video header but no media. Add a header media URL to the template in Settings → Templates, then send again.',
    });
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it("accepts a recipient's own media override", async () => {
    h.provider = 'meta';
    h.template = { header_type: 'video' };
    h.sendTemplate.mockResolvedValue({
      messageId: 'wamid.1',
      provider: 'meta',
    });

    const res = await post({
      template_name: 'promo',
      recipients: [
        {
          phone: '+14155550123',
          params: [],
          messageParams: { headerMediaUrl: 'https://cdn.example.com/v.mp4' },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('does not apply on Whapi', async () => {
    h.template = { header_type: 'video' };
    h.sendTemplate.mockResolvedValue({ messageId: 'id-1', provider: 'whapi' });

    const res = await post({
      template_name: 'promo',
      recipients: [{ phone: '+14155550123', params: [] }],
    });

    expect(res.status).toBe(200);
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/whatsapp/broadcast — number daily limit (migration 204)', () => {
  it('sends nothing once the number is refused, and reports the rest with the reason', async () => {
    h.sendTemplate.mockResolvedValue({ messageId: 'wamid.1' });
    h.autoCheck
      .mockResolvedValueOnce({ blocked: false })
      .mockResolvedValueOnce({ blocked: true, limit: 50 });

    const res = await post({
      template_name: 'promo',
      recipients: [
        { phone: '+971501234561', params: [] },
        { phone: '+971501234562', params: [] },
        { phone: '+971501234563', params: [] },
      ],
    });
    const body = await res.json();

    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
    expect(h.sendTemplate.mock.calls[0][0]).toMatchObject({
      to: expect.stringContaining('971501234561'),
    });
    // One refusal stops the asking for this number.
    expect(h.autoCheck).toHaveBeenCalledTimes(2);
    expect(h.autoCheck).toHaveBeenCalledWith({}, 'acct-1', null, {
      id: 'cfg-1',
      provider: 'whapi',
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
    });
    expect(body).toMatchObject({ success: true, total: 3, sent: 1, failed: 2 });
    expect(body.results.slice(1)).toEqual([
      {
        phone: '+971501234562',
        status: 'failed',
        error: expect.stringMatching(/started 50 new chats today/),
      },
      {
        phone: '+971501234563',
        status: 'failed',
        error: expect.stringMatching(/started 50 new chats today/),
      },
    ]);
  });

  it('does not ask for a Meta number', async () => {
    h.provider = 'meta';
    h.sendTemplate.mockResolvedValue({ messageId: 'wamid.1' });
    await post({
      template_name: 'promo',
      recipients: [{ phone: '+971501234561', params: [] }],
    });
    expect(h.autoCheck).not.toHaveBeenCalled();
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
