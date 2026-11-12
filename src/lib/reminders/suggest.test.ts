import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- boundaries -------------------------------------------------------

const db = vi.hoisted(() => ({
  fromCalls: [] as string[],
  tz: { data: { timezone: 'Asia/Dubai' }, error: null } as {
    data: unknown;
    error: { message: string } | null;
  },
  chat: {
    data: { account_id: 'acc-1', personal_owner_id: null },
    error: null,
  } as { data: unknown; error: { message: string } | null },
  insert: { data: [{ id: 'sug-1' }], error: null } as {
    data: unknown;
    error: { message: string } | null;
  },
  upserts: [] as Array<{ row: unknown; opts: unknown }>,
  throwOnFrom: false,
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (db.throwOnFrom) throw new Error('db down');
      db.fromCalls.push(table);
      const read = (result: () => unknown) => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => result() }),
        }),
      });
      if (table === 'team_activity_settings') return read(() => db.tz);
      if (table === 'conversations') return read(() => db.chat);
      if (table === 'message_reminder_suggestions')
        return {
          upsert: (row: unknown, opts: unknown) => {
            db.upserts.push({ row, opts });
            return { select: async () => db.insert };
          },
        };
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const gates = vi.hoisted(() => ({
  available: true,
  enabled: true,
  rateOk: true,
}));

vi.mock('@/lib/insights/settings', () => ({
  insightsAvailable: vi.fn(() => gates.available),
  getInsightSettings: vi.fn(async () => ({
    reminderSuggestEnabled: gates.enabled,
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { reminderSuggestAccount: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: vi.fn(() => ({ success: gates.rateOk })),
}));

const jev = vi.hoisted(() => ({
  layer: true,
  reminder: vi.fn(),
}));

vi.mock('@/lib/typesafe', () => ({
  getDecisionLayer: () => (jev.layer ? { reminder: jev.reminder } : null),
}));

vi.mock('./time-phrases', () => ({
  findTimePhrases: vi.fn(),
}));

import { checkRateLimit } from '@/lib/rate-limit';
import {
  __resetReminderCaches,
  REMINDER_MIN_P,
  suggestReminderForMessage,
  type SuggestReminderArgs,
} from './suggest';
import { findTimePhrases } from './time-phrases';

// ---- fixtures ---------------------------------------------------------

const NOW = Date.parse('2026-11-12T08:00:00.000Z');
const TOMORROW = '2026-11-13T05:00:00.000Z';
const FRIDAY = '2026-11-14T09:00:00.000Z';

const ARGS: SuggestReminderArgs = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  text: 'I will send the salary certificate tomorrow at 9 or on Friday',
  side: 'customer',
  messageAt: '2026-11-12T07:59:00.000Z',
};

function candidates(...ats: string[]) {
  return ats.map((at, i) => ({
    phrase: i === 0 ? 'tomorrow at 9' : 'on Friday',
    index: 40 + i * 15,
    at,
    dateOnly: i > 0,
  }));
}

function yes(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    isReminder: true,
    p: 0.83456,
    timeIndex: 0,
    kind: 'documents',
    latencyMs: 120,
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  __resetReminderCaches();
  db.fromCalls = [];
  db.upserts = [];
  db.throwOnFrom = false;
  db.tz = { data: { timezone: 'Asia/Dubai' }, error: null };
  db.chat = {
    data: { account_id: 'acc-1', personal_owner_id: null },
    error: null,
  };
  db.insert = { data: [{ id: 'sug-1' }], error: null };
  gates.available = true;
  gates.enabled = true;
  gates.rateOk = true;
  jev.layer = true;
  jev.reminder.mockReset();
  jev.reminder.mockResolvedValue(yes());
  vi.mocked(findTimePhrases).mockReset();
  vi.mocked(findTimePhrases).mockReturnValue(candidates(TOMORROW, FRIDAY));
  vi.mocked(checkRateLimit).mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
  error.mockRestore();
});

function logged(): string {
  return [...warn.mock.calls, ...error.mock.calls]
    .map((c) => c.join(' '))
    .join('\n');
}

// ---- tests ------------------------------------------------------------

describe('suggestReminderForMessage', () => {
  it('stores the judged time with the exact upsert arguments', async () => {
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: null, stored: true, candidates: 2 });
    expect(out.judgment).toMatchObject({ ok: true, kind: 'documents' });
    expect(db.upserts).toEqual([
      {
        row: {
          account_id: 'acc-1',
          conversation_id: 'conv-1',
          message_id: 'msg-1',
          side: 'customer',
          kind: 'documents',
          due_at: TOMORROW,
          date_only: false,
          phrase: 'tomorrow at 9',
          p: 0.835,
        },
        opts: { onConflict: 'message_id', ignoreDuplicates: true },
      },
    ]);
    expect(findTimePhrases).toHaveBeenCalledWith(ARGS.text, {
      now: new Date(ARGS.messageAt),
      timeZone: 'Asia/Dubai',
    });
    expect(checkRateLimit).toHaveBeenCalledWith('reminders:acc-1', {
      limit: 60,
      windowMs: 60_000,
    });
  });

  it('passes the side through to Jev and the row', async () => {
    const out = await suggestReminderForMessage({ ...ARGS, side: 'agent' });
    expect(out.stored).toBe(true);
    expect(jev.reminder).toHaveBeenCalledWith({
      accountId: 'acc-1',
      text: ARGS.text,
      side: 'agent',
      times: ['tomorrow at 9', 'on Friday'],
    });
    expect((db.upserts[0].row as { side: string }).side).toBe('agent');
  });

  it('uses the candidate Jev picked (the second one)', async () => {
    jev.reminder.mockResolvedValue(yes({ timeIndex: 1, kind: 'payment' }));
    const out = await suggestReminderForMessage(ARGS);
    expect(out.stored).toBe(true);
    expect(db.upserts[0].row).toMatchObject({
      due_at: FRIDAY,
      date_only: true,
      phrase: 'on Friday',
      kind: 'payment',
    });
  });

  it('clips the phrase to 120 characters', async () => {
    vi.mocked(findTimePhrases).mockReturnValue([
      { phrase: 'x'.repeat(200), index: 0, at: TOMORROW, dateOnly: false },
    ]);
    await suggestReminderForMessage(ARGS);
    expect((db.upserts[0].row as { phrase: string }).phrase).toHaveLength(120);
  });

  it('stores at exactly the 0.6 threshold and not below it', async () => {
    expect(REMINDER_MIN_P).toBe(0.6);
    jev.reminder.mockResolvedValue(yes({ p: 0.6 }));
    expect((await suggestReminderForMessage(ARGS)).stored).toBe(true);

    jev.reminder.mockResolvedValue(yes({ p: 0.59 }));
    const out = await suggestReminderForMessage({ ...ARGS, messageId: 'm2' });
    expect(out).toMatchObject({ skipped: 'not_reminder', stored: false });
    expect(db.upserts).toHaveLength(1);
  });

  it('skips a blank message before anything else', async () => {
    const out = await suggestReminderForMessage({ ...ARGS, text: '  \n\t ' });
    expect(out).toEqual({ skipped: 'blank', stored: false, candidates: 0 });
    expect(db.fromCalls).toEqual([]);
  });

  it('skips a message over 1000 characters', async () => {
    const out = await suggestReminderForMessage({
      ...ARGS,
      text: 'a'.repeat(1001),
    });
    expect(out.skipped).toBe('too_long');
    expect(findTimePhrases).not.toHaveBeenCalled();
  });

  it('is unavailable without insights or without the decision layer', async () => {
    gates.available = false;
    expect((await suggestReminderForMessage(ARGS)).skipped).toBe('unavailable');
    gates.available = true;
    jev.layer = false;
    expect((await suggestReminderForMessage(ARGS)).skipped).toBe('unavailable');
    expect(db.fromCalls).toEqual([]);
  });

  it('is off until the switch is on', async () => {
    gates.enabled = false;
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'off', stored: false });
    expect(findTimePhrases).not.toHaveBeenCalled();
    expect(jev.reminder).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it('skips a message with no time', async () => {
    vi.mocked(findTimePhrases).mockReturnValue([]);
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'no_time', candidates: 0 });
    expect(jev.reminder).not.toHaveBeenCalled();
  });

  it('drops times within two minutes of now', async () => {
    vi.mocked(findTimePhrases).mockReturnValue(
      candidates(
        new Date(NOW + 60_000).toISOString(),
        new Date(NOW + 2 * 60_000).toISOString()
      )
    );
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'no_time', candidates: 0 });
  });

  it.each([
    ['a personal chat', { account_id: 'acc-1', personal_owner_id: 'user-9' }],
    [
      'another account’s chat',
      { account_id: 'acc-2', personal_owner_id: null },
    ],
    ['a missing chat', null],
  ])('never judges %s', async (_name, data) => {
    db.chat = { data, error: null };
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'personal', stored: false });
    expect(jev.reminder).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it('is rate limited per account', async () => {
    gates.rateOk = false;
    const out = await suggestReminderForMessage(ARGS);
    expect(out.skipped).toBe('rate_limited');
    expect(jev.reminder).not.toHaveBeenCalled();
  });

  it('logs and skips a failed Jev judgment without the text', async () => {
    jev.reminder.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      latencyMs: 4000,
    });
    const out = await suggestReminderForMessage(ARGS);
    expect(out.skipped).toBe('jev_failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('acc-1');
    expect(logged()).toContain('TIMEOUT');
    expect(logged()).not.toContain('salary');
  });

  it('treats an out-of-range time index as a failed judgment', async () => {
    jev.reminder.mockResolvedValue(yes({ timeIndex: 2 }));
    const out = await suggestReminderForMessage(ARGS);
    expect(out.skipped).toBe('jev_failed');
    expect(db.upserts).toEqual([]);
  });

  it('skips a message Jev says is not a reminder', async () => {
    jev.reminder.mockResolvedValue(yes({ isReminder: false, p: 0.9 }));
    expect((await suggestReminderForMessage(ARGS)).skipped).toBe(
      'not_reminder'
    );
  });

  it('re-checks the picked time after the judgment', async () => {
    const soon = new Date(NOW + 3 * 60_000).toISOString();
    vi.mocked(findTimePhrases).mockReturnValue(candidates(soon));
    jev.reminder.mockImplementation(async () => {
      vi.setSystemTime(NOW + 2 * 60_000);
      return yes();
    });
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'too_soon', candidates: 1 });
    expect(db.upserts).toEqual([]);
  });

  it('reports an existing row as a duplicate', async () => {
    db.insert = { data: [], error: null };
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'duplicate', stored: false });
  });

  it('logs and skips a failed insert', async () => {
    db.insert = { data: null, error: { message: 'violates check' } };
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'error', stored: false });
    expect(error).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('acc-1');
    expect(logged()).not.toContain('salary');
  });

  it('reads the account time zone once for two calls', async () => {
    await suggestReminderForMessage(ARGS);
    await suggestReminderForMessage({ ...ARGS, messageId: 'msg-2' });
    expect(
      db.fromCalls.filter((t) => t === 'team_activity_settings')
    ).toHaveLength(1);
    expect(vi.mocked(findTimePhrases).mock.calls[1][1].timeZone).toBe(
      'Asia/Dubai'
    );
  });

  it('reads the time zone again after five minutes', async () => {
    await suggestReminderForMessage(ARGS);
    vi.setSystemTime(NOW + 5 * 60_000 + 1);
    await suggestReminderForMessage({ ...ARGS, messageId: 'msg-2' });
    expect(
      db.fromCalls.filter((t) => t === 'team_activity_settings')
    ).toHaveLength(2);
  });

  it.each([
    ['no saved settings', { data: null, error: null }],
    ['an invalid zone', { data: { timezone: 'Mars/Base' }, error: null }],
    ['a failed read', { data: null, error: { message: 'boom' } }],
  ])('falls back to UTC with %s', async (_name, result) => {
    db.tz = result;
    await suggestReminderForMessage(ARGS);
    expect(vi.mocked(findTimePhrases).mock.calls[0][1].timeZone).toBe('UTC');
  });

  it('never throws when the admin client throws', async () => {
    db.throwOnFrom = true;
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'error', stored: false });
    expect(error).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain('salary');
  });

  it('never throws when the facade throws', async () => {
    jev.reminder.mockRejectedValue(new Error('facade exploded'));
    const out = await suggestReminderForMessage(ARGS);
    expect(out).toMatchObject({ skipped: 'error', stored: false });
    expect(logged()).toContain('acc-1');
  });

  it('never throws when the time finder throws', async () => {
    vi.mocked(findTimePhrases).mockImplementation(() => {
      throw new Error('bad zone');
    });
    expect((await suggestReminderForMessage(ARGS)).skipped).toBe('error');
  });
});
