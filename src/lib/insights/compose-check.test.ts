import { beforeEach, describe, expect, it, vi } from 'vitest';
import { partnerCatalogue } from '@/lib/typesafe/banks';

// checkDraft with settings, the decision layer and Supabase stubbed at
// the module boundary.

const NOW = Date.parse('2026-10-29T10:00:00Z');
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const h = vi.hoisted(() => ({
  available: true,
  mode: 'warn' as 'warn' | 'off',
  composeCheck: vi.fn(),
  inserts: [] as unknown[],
  insertError: null as { message: string } | null,
  provider: 'whapi' as string | null,
  messages: [] as Record<string, unknown>[],
  messagesError: null as { message: string } | null,
  conv: { channel_id: 'ch-1', send_channel_id: null } as {
    channel_id: string | null;
    send_channel_id: string | null;
  },
  newChatProvider: vi.fn(),
}));

vi.mock('@/lib/whatsapp/channels', () => ({
  newChatProvider: h.newChatProvider,
}));

vi.mock('./settings', () => ({
  insightsAvailable: () => h.available,
  getInsightSettings: async () => ({ composeCheckMode: h.mode }),
}));
vi.mock('@/lib/typesafe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/typesafe')>()),
  getDecisionLayer: () => ({
    partners: async () => partnerCatalogue(null),
    composeCheck: h.composeCheck,
  }),
}));
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (row: unknown) => {
        h.inserts.push(row);
        return {
          select: () => ({
            single: async () =>
              h.insertError
                ? { data: null, error: h.insertError }
                : { data: { id: 'event-1' }, error: null },
          }),
        };
      },
    }),
  }),
}));

function rlsDb() {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const n of ['select', 'eq', 'order']) b[n] = () => b;
    b.limit = async () =>
      h.messagesError
        ? { data: null, error: h.messagesError }
        : { data: [...h.messages].reverse(), error: null };
    b.maybeSingle = async () =>
      table === 'conversations'
        ? { data: h.conv, error: null }
        : { data: h.provider ? { provider: h.provider } : null, error: null };
    return b;
  };
  return { from } as never;
}

import { checkDraft } from './compose-check';

const run = (text: string) =>
  checkDraft({
    accountId: 'acc-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    text,
    db: rlsDb(),
    now: () => NOW,
    deadlineAt: NOW + 1800,
  });
const jev = (figures: Record<string, number>) =>
  h.composeCheck.mockResolvedValue({ ok: true, figures, latencyMs: 5 });

beforeEach(() => {
  h.available = true;
  h.mode = 'warn';
  h.inserts = [];
  h.insertError = null;
  h.provider = 'whapi';
  h.messagesError = null;
  h.conv = { channel_id: 'ch-1', send_channel_id: null };
  h.newChatProvider.mockReset();
  h.newChatProvider.mockResolvedValue(null);
  h.messages = [
    {
      sender_type: 'customer',
      content_text: 'hi',
      status: 'read',
      created_at: iso(HOUR),
    },
  ];
  h.composeCheck.mockReset();
  jev({});
});

describe('checkDraft gating', () => {
  it('warns about nothing when unavailable, off, or the draft is short', async () => {
    jev({ promise: 0.99 });
    h.available = false;
    expect(await run('approved for sure, guaranteed')).toEqual({
      warnings: [],
      eventId: null,
    });
    h.available = true;
    h.mode = 'off';
    expect(await run('approved for sure, guaranteed')).toEqual({
      warnings: [],
      eventId: null,
    });
    h.mode = 'warn';
    expect(await run('  approved  ')).toEqual({ warnings: [], eventId: null });
    expect(h.composeCheck).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });
});

describe('checkDraft warnings', () => {
  it('adds Jev warnings over their thresholds and records one event', async () => {
    jev({ promise: 0.8, terms: 0.6, tone: 0.1 });
    const r = await run('You will be approved by tomorrow, rate 3.5%');
    expect(r.warnings).toEqual([
      { code: 'promise', source: 'jev' },
      { code: 'terms', source: 'jev' },
    ]);
    expect(r.eventId).toBe('event-1');
    expect(h.inserts).toEqual([
      {
        account_id: 'acc-1',
        user_id: 'user-1',
        conversation_id: 'conv-1',
        warnings: ['promise', 'terms'],
      },
    ]);
  });

  it('keeps the rules when Jev fails', async () => {
    h.composeCheck.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 1800,
    });
    const r = await run(
      'We are licensed by the Central Bank. Try HSBC instead'
    );
    expect(r.warnings).toEqual([
      { code: 'non_partner_bank', source: 'rule' },
      { code: 'regulator_claim', source: 'rule' },
    ]);
    expect(r.eventId).toBe('event-1');
  });

  it('does not flag a non-partner bank the customer named first', async () => {
    h.messages.push({
      sender_type: 'customer',
      content_text: 'Can you do HSBC?',
      status: 'read',
      created_at: iso(HOUR / 2),
    });
    expect((await run('Sorry, we do not work with HSBC')).warnings).toEqual([]);
  });

  it('records nothing without warnings, and survives a failed insert', async () => {
    expect(await run('Thanks, I will check and revert today')).toEqual({
      warnings: [],
      eventId: null,
    });
    expect(h.inserts).toHaveLength(0);
    jev({ tone: 0.9 });
    h.insertError = { message: 'boom' };
    expect(await run('Stop wasting my time please')).toEqual({
      warnings: [{ code: 'tone', source: 'jev' }],
      eventId: null,
    });
  });
});

describe('checkDraft isStart', () => {
  const isStartSent = () => h.composeCheck.mock.calls[0]![0].isStart;

  it('is a start after 24 h silence when the business wrote last', async () => {
    h.messages = [
      {
        sender_type: 'agent',
        content_text: 'hello',
        status: 'read',
        created_at: iso(25 * HOUR),
      },
    ];
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(true);
  });

  it('is not a start when the customer wrote last, however long ago', async () => {
    h.messages = [
      {
        sender_type: 'customer',
        content_text: 'hello',
        status: 'read',
        created_at: iso(48 * HOUR),
      },
    ];
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(false);
  });

  it('is not a start within 24 h', async () => {
    h.messages = [
      {
        sender_type: 'agent',
        content_text: 'hello',
        status: 'read',
        created_at: iso(23 * HOUR),
      },
    ];
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(false);
  });

  it('is only a start on a linked-device number', async () => {
    h.messages = [];
    h.provider = 'meta';
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(false);
    h.composeCheck.mockClear();
    h.provider = null;
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(false);
    h.composeCheck.mockClear();
    h.provider = 'openwa';
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(true);
  });

  it('is not a start when the messages could not be read', async () => {
    h.messages = [];
    h.messagesError = { message: 'boom' };
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(false);
  });

  it('judges a chat with no number yet on the number its first send uses', async () => {
    h.messages = [];
    h.conv = { channel_id: null, send_channel_id: null };
    h.newChatProvider.mockResolvedValue('whapi');
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(true);
    expect(h.newChatProvider).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'inbox',
      'user-1',
      expect.any(String)
    );
    h.composeCheck.mockClear();
    h.newChatProvider.mockResolvedValue('meta');
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(false);
    h.composeCheck.mockClear();
    h.newChatProvider.mockResolvedValue(null);
    await run('Great offers on loans this week');
    expect(isStartSent()).toBe(false);
  });
});

describe('checkDraft deadline', () => {
  it('records no event once the deadline has passed', async () => {
    jev({ promise: 0.9 });
    let t = NOW;
    h.composeCheck.mockImplementation(async () => {
      t = NOW + 2000;
      return { ok: true, figures: { promise: 0.9 }, latencyMs: 2000 };
    });
    const r = await checkDraft({
      accountId: 'acc-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      text: 'You will be approved by tomorrow',
      db: rlsDb(),
      now: () => t,
      deadlineAt: NOW + 1800,
    });
    expect(r).toEqual({
      warnings: [{ code: 'promise', source: 'jev' }],
      eventId: null,
    });
    expect(h.inserts).toHaveLength(0);
  });
});
