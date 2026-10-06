import { beforeEach, describe, expect, it, vi } from 'vitest';

// The legacy one-shot batch route: phone numbers stay out of the log,
// and a Meta media template with no media is refused once per batch.

const h = vi.hoisted(() => ({
  provider: 'whapi' as 'whapi' | 'meta',
  template: {} as Record<string, unknown>,
  sendTemplate: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
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
