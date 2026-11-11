import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  reachesOnlyByShare: vi.fn(),
  sendReaction: vi.fn(),
  maySendFromPersonal: vi.fn(),
  channel: { id: 'ch1' } as Record<string, unknown>,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { react: {} },
}));
vi.mock('@/lib/whatsapp/send-message', () => ({
  reachesOnlyByShare: mocks.reachesOnlyByShare,
  maySendFromPersonal: mocks.maySendFromPersonal,
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  sendReaction: mocks.sendReaction,
  describeSendFailure: () => 'failed',
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  ChannelError: class extends Error {},
  isWhatsAppProvider: () => true,
  loadChannels: async () => [mocks.channel],
  pickByProvider: () => null,
  resolveReplyChannel: async () => ({ id: 'ch1' }),
}));

import { POST } from './route';

function setup() {
  const rows: Record<string, unknown> = {
    messages: {
      id: 'm1',
      message_id: 'wamid',
      conversation_id: 'c1',
      provider: 'whapi',
      channel_id: 'ch1',
    },
    conversations: {
      id: 'c1',
      account_id: 'a',
      user_id: 'owner',
      assigned_agent_id: null,
      channel_id: 'ch1',
      send_channel_id: null,
      contact: { phone: '971' },
    },
  };
  const supabase = {
    from: (t: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: rows[t], error: null });
      q.upsert = async () => ({ error: null });
      return q;
    },
  };
  mocks.requireRole.mockResolvedValue({
    supabase,
    accountId: 'a',
    userId: 'coord',
  });
}

const req = () =>
  new Request('http://localhost/api/whatsapp/react', {
    method: 'POST',
    body: JSON.stringify({ message_id: 'm1', emoji: '👍' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channel = { id: 'ch1' };
  setup();
});

describe('POST /api/whatsapp/react', () => {
  it('refuses a share-only caller before the gateway call', async () => {
    mocks.reachesOnlyByShare.mockResolvedValue(true);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/shared chat/);
    expect(mocks.sendReaction).not.toHaveBeenCalled();
  });

  it('reacts for a caller with ordinary access', async () => {
    mocks.reachesOnlyByShare.mockResolvedValue(false);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mocks.sendReaction).toHaveBeenCalledOnce();
  });

  it('refuses a non-owner on a personal number before the gateway call', async () => {
    mocks.reachesOnlyByShare.mockResolvedValue(false);
    mocks.channel = { id: 'ch1', isPersonal: true, personalUserId: 'owner' };
    mocks.maySendFromPersonal.mockResolvedValue(false);
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('personal_number');
    expect(mocks.sendReaction).not.toHaveBeenCalled();
  });

  it('lets the personal number owner react', async () => {
    mocks.reachesOnlyByShare.mockResolvedValue(false);
    mocks.channel = { id: 'ch1', isPersonal: true, personalUserId: 'coord' };
    mocks.maySendFromPersonal.mockResolvedValue(true);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mocks.sendReaction).toHaveBeenCalledOnce();
  });
});
