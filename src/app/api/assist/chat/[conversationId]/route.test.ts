// The panel's routes refuse while the workspace switch is off (323), for
// every role, before reading the chat, the AI key or calling a model; and
// a viewer is refused even while it is on.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  supabaseAdmin: vi.fn(),
  enabled: null as unknown,
  convReads: 0,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: m.loadAiConfig }));
vi.mock('@/lib/ai/generate', () => ({ generateReply: m.generateReply }));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: m.supabaseAdmin }));

import { POST } from './route';
import { POST as RUN } from './run/route';

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CHAT = '44444444-4444-4444-8444-444444444444';
const PENDING = '33333333-3333-4333-8333-333333333333';

/** The caller's client: the switch row, and a count of chat reads. */
function rls() {
  const q = (table: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        if (table === 'inbox_assistant_settings')
          return { data: m.enabled, error: null };
        m.convReads++;
        return { data: null, error: null };
      },
    };
    return b;
  };
  return { from: q, rpc: vi.fn() };
}

const ask = () =>
  POST(
    new Request(`http://x/api/assist/chat/${CHAT}`, {
      method: 'POST',
      body: JSON.stringify({ task: 'summary' }),
    }),
    { params: Promise.resolve({ conversationId: CHAT }) }
  );
const run = () =>
  RUN(
    new Request(`http://x/api/assist/chat/${CHAT}/run`, {
      method: 'POST',
      body: JSON.stringify({
        pendingId: PENDING,
        tool: 'chat_add_note',
        args: { conversationId: CHAT, body: 'x' },
      }),
    }),
    { params: Promise.resolve({ conversationId: CHAT }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.convReads = 0;
  m.enabled = null;
});

const as = (role: string) =>
  m.getCurrentAccount.mockResolvedValue({
    supabase: rls(),
    userId: USER,
    accountId: ACCOUNT,
    role,
  });

describe('the chat assistant switch', () => {
  it.each(['owner', 'admin', 'team_leader', 'agent'])(
    'refuses a %s while the switch is off (no row)',
    async (role) => {
      as(role);
      for (const res of [await ask(), await run()]) {
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('chat_assist_off');
      }
      expect(m.convReads).toBe(0);
      expect(m.loadAiConfig).not.toHaveBeenCalled();
      expect(m.generateReply).not.toHaveBeenCalled();
      expect(m.supabaseAdmin).not.toHaveBeenCalled();
    }
  );

  it('refuses while the row says off', async () => {
    as('admin');
    m.enabled = { enabled: false };
    const res = await ask();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('chat_assist_off');
    expect(m.generateReply).not.toHaveBeenCalled();
  });

  it('refuses a viewer even while on', async () => {
    as('viewer');
    m.enabled = { enabled: true };
    const res = await ask();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('chat_assist_role');
    expect(m.generateReply).not.toHaveBeenCalled();
  });

  it('goes on to read the chat once on, for an agent', async () => {
    as('agent');
    m.enabled = { enabled: true };
    const res = await ask();
    // The fake chat is not found: past the gate, before any model call.
    expect(res.status).toBe(404);
    expect(m.convReads).toBe(1);
    expect(m.generateReply).not.toHaveBeenCalled();
  });
});
