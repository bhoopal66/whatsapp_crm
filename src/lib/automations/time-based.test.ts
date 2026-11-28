import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('./admin-client', () => ({ supabaseAdmin: vi.fn(() => ({})) }));
vi.mock('./engine', () => ({ runScheduledAutomation: vi.fn() }));

import {
  parseTimeBasedConfig,
  runTimeBasedAutomations,
  TIME_BASED_MAX_CHATS,
} from './time-based';

const TAG = '11111111-2222-4333-8444-555555555555';
const SUB = '11111111-2222-4333-8444-666666666666';
const ACCT = 'acct-1';
// Monday 2026-11-23, 09:03 in Dubai.
const NOW = new Date('2026-11-23T05:03:00Z');
const SLOT = '2026-11-23T05:00:00.000Z';

type Call = { table: string; op: string; args: unknown[] };

/**
 * A chainable stand-in for the service-role client. Each terminal read
 * resolves to what `answer(table, op, calls)` returns for that query.
 */
function fakeDb(
  answer: (
    table: string,
    op: string,
    filters: Call[]
  ) => { data?: unknown; error?: unknown }
) {
  const log: Call[][] = [];
  const db = {
    from(table: string) {
      const calls: Call[] = [];
      log.push(calls);
      let op = 'select';
      const q: Record<string, unknown> = {};
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          calls.push({ table, op: name, args });
          if (name === 'upsert' || name === 'update' || name === 'delete')
            op = name;
          return q;
        };
      for (const name of [
        'select',
        'eq',
        'is',
        'neq',
        'lt',
        'in',
        'order',
        'limit',
        'upsert',
        'update',
        'delete',
      ]) {
        q[name] = chain(name);
      }
      q.then = (
        resolve: (v: unknown) => void,
        reject: (e: unknown) => void
      ) => {
        try {
          const r = answer(table, op, calls);
          resolve({ data: r.data ?? null, error: r.error ?? null });
        } catch (e) {
          reject(e);
        }
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, log };
}

const automation = (over: Record<string, unknown> = {}) => ({
  id: 'auto-1',
  account_id: ACCT,
  user_id: 'u-1',
  name: 'Morning follow-up',
  trigger_type: 'time_based',
  trigger_config: { schedule: '0 9 * * 1-5', chat_tag_id: TAG },
  is_active: true,
  updated_at: '2026-11-01T00:00:00Z',
  ...over,
});

function world(opts: {
  automations?: unknown[];
  claimed?: boolean;
  chats?: { id: string; contact_id: string | null }[];
  reachable?: string[];
  zone?: string | null;
}) {
  return fakeDb((table, op) => {
    if (table === 'automations')
      return { data: opts.automations ?? [automation()] };
    if (table === 'response_settings') {
      return {
        data: opts.zone ? [{ account_id: ACCT, timezone: opts.zone }] : [],
      };
    }
    if (table === 'automation_schedule_runs') {
      if (op === 'upsert') {
        return {
          data: opts.claimed === false ? [] : [{ automation_id: 'auto-1' }],
        };
      }
      return { data: null };
    }
    if (table === 'conversations') return { data: opts.chats ?? [] };
    if (table === 'contacts') {
      return { data: (opts.reachable ?? []).map((id) => ({ id })) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe('parseTimeBasedConfig', () => {
  it('needs a readable schedule and a chat tag', () => {
    expect(parseTimeBasedConfig({ schedule: '0 9 * * *' })).toEqual({
      ok: false,
      reason: 'no chat tag is chosen',
    });
    expect(
      parseTimeBasedConfig({ schedule: 'soon', chat_tag_id: TAG })
    ).toEqual({
      ok: false,
      reason: 'the schedule cannot be read',
    });
    const ok = parseTimeBasedConfig({
      schedule: '0 9 * * *',
      chat_tag_id: TAG,
      chat_sub_tag_id: SUB,
      quiet_days: 3,
    });
    expect(ok.ok && ok.config.chatSubTagId).toBe(SUB);
    expect(ok.ok && ok.config.quietDays).toBe(3);
  });
});

describe('runTimeBasedAutomations', () => {
  it('claims the slot, then runs the engine once per reachable chat', async () => {
    const { db, log } = world({
      chats: [
        { id: 'c1', contact_id: 'k1' },
        { id: 'c2', contact_id: 'k2' }, // opted out: not reachable
        { id: 'c3', contact_id: 'k3' },
        { id: 'c4', contact_id: null },
      ],
      reachable: ['k1', 'k3'],
    });
    const run = vi.fn().mockResolvedValue(true);
    const summary = await runTimeBasedAutomations({
      db,
      now: NOW,
      run,
      deadline: Infinity,
    });

    expect(summary).toEqual({ automations: 1, ran: 1, chats: 2, skipped: 0 });
    expect(run.mock.calls.map((c) => c[1].contactId)).toEqual(['k1', 'k3']);
    const input = run.mock.calls[0][1];
    expect(input).toMatchObject({
      accountId: ACCT,
      triggerType: 'time_based',
      customerJustWrote: false,
      context: { conversation_id: 'c1' },
    });
    expect(typeof input.salesChat).toBe('function');

    const claim = log.flat().find((c) => c.op === 'upsert');
    expect(claim?.args[0]).toEqual({
      automation_id: 'auto-1',
      account_id: ACCT,
      slot: SLOT,
    });

    // The chat query is the account's open company chats with the tag.
    const chatQuery = log.find((calls) => calls[0]?.table === 'conversations')!;
    expect(chatQuery).toEqual(
      expect.arrayContaining([
        { table: 'conversations', op: 'eq', args: ['account_id', ACCT] },
        { table: 'conversations', op: 'is', args: ['personal_owner_id', null] },
        { table: 'conversations', op: 'neq', args: ['status', 'closed'] },
        { table: 'conversations', op: 'eq', args: ['chat_tag_id', TAG] },
        { table: 'conversations', op: 'limit', args: [TIME_BASED_MAX_CHATS] },
      ])
    );
    const contactQuery = log.find((calls) => calls[0]?.table === 'contacts')!;
    expect(contactQuery).toEqual(
      expect.arrayContaining([
        { table: 'contacts', op: 'is', args: ['opted_out_at', null] },
        { table: 'contacts', op: 'is', args: ['do_not_contact_at', null] },
      ])
    );
  });

  it('runs nothing when another pass already claimed the slot', async () => {
    const { db } = world({
      claimed: false,
      chats: [{ id: 'c1', contact_id: 'k1' }],
      reachable: ['k1'],
    });
    const run = vi.fn();
    const summary = await runTimeBasedAutomations({
      db,
      now: NOW,
      run,
      deadline: Infinity,
    });
    expect(run).not.toHaveBeenCalled();
    expect(summary.ran).toBe(0);
  });

  it('runs nothing outside the schedule, or for a slot before the last save', async () => {
    const run = vi.fn();
    const weekend = world({
      chats: [{ id: 'c1', contact_id: 'k1' }],
      reachable: ['k1'],
    });
    // Sunday 09:03 Dubai: a weekdays schedule does not run.
    await runTimeBasedAutomations({
      db: weekend.db,
      now: new Date('2026-11-22T05:03:00Z'),
      run,
      deadline: Infinity,
    });
    const saved = world({
      automations: [automation({ updated_at: '2026-11-23T05:02:10Z' })],
      chats: [{ id: 'c1', contact_id: 'k1' }],
      reachable: ['k1'],
    });
    await runTimeBasedAutomations({
      db: saved.db,
      now: NOW,
      run,
      deadline: Infinity,
    });
    expect(run).not.toHaveBeenCalled();
    expect(saved.log.flat().some((c) => c.op === 'upsert')).toBe(false);
  });

  it('never runs a trigger with no chat tag', async () => {
    const { db, log } = world({
      automations: [automation({ trigger_config: { schedule: '0 9 * * *' } })],
    });
    const run = vi.fn();
    await runTimeBasedAutomations({ db, now: NOW, run, deadline: Infinity });
    expect(run).not.toHaveBeenCalled();
    expect(log.some((calls) => calls[0]?.table === 'conversations')).toBe(
      false
    );
  });

  it('reads the schedule in the workspace zone, and the trigger zone wins', async () => {
    const run = vi.fn().mockResolvedValue(true);
    // 09:03 UTC: 09:00 only in a UTC workspace.
    const at = new Date('2026-11-23T09:03:00Z');
    const utc = world({
      zone: 'UTC',
      chats: [{ id: 'c1', contact_id: 'k1' }],
      reachable: ['k1'],
    });
    await runTimeBasedAutomations({
      db: utc.db,
      now: at,
      run,
      deadline: Infinity,
    });
    expect(run).toHaveBeenCalledTimes(1);

    const overridden = world({
      zone: 'UTC',
      automations: [
        automation({
          trigger_config: {
            schedule: '0 9 * * 1-5',
            chat_tag_id: TAG,
            timezone: 'Asia/Dubai',
          },
        }),
      ],
      chats: [{ id: 'c1', contact_id: 'k1' }],
      reachable: ['k1'],
    });
    await runTimeBasedAutomations({
      db: overridden.db,
      now: at,
      run,
      deadline: Infinity,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops starting chats at the deadline and records how far it got', async () => {
    const { db, log } = world({
      chats: [
        { id: 'c1', contact_id: 'k1' },
        { id: 'c2', contact_id: 'k2' },
      ],
      reachable: ['k1', 'k2'],
    });
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const run = vi.fn(async () => {
        clock = 100;
        return true;
      });
      const summary = await runTimeBasedAutomations({
        db,
        now: NOW,
        run,
        deadline: 50,
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ chats: 1, skipped: 1 });
    } finally {
      Date.now = realNow;
    }
    const finish = log.flat().find((c) => c.op === 'update');
    expect(finish?.args[0]).toMatchObject({
      chats_matched: 2,
      chats_run: 1,
      note: 'stopped at the time limit',
    });
  });

  it('never throws when the automations cannot be read', async () => {
    const { db } = fakeDb(() => ({ error: { message: 'down' } }));
    await expect(
      runTimeBasedAutomations({
        db,
        now: NOW,
        run: vi.fn(),
        deadline: Infinity,
      })
    ).resolves.toMatchObject({ automations: 0, ran: 0 });
  });
});
