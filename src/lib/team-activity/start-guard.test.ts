import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  checkHumanSend,
  recordJevBlock,
  restrictionMessage,
} from './start-guard';

function client(result: unknown): SupabaseClient {
  return { rpc: vi.fn(async () => result) } as unknown as SupabaseClient;
}

const ALLOW = {
  blocked: false,
  isStart: false,
  unlockUsed: false,
  unlockAvailable: false,
  jev: { enabled: false, minP: 0.85 },
};

describe('checkHumanSend', () => {
  it('passes the conversation, the number and the text to the 3-arg check', async () => {
    const db = client({
      data: {
        blocked: false,
        is_start: true,
        unlock_used: false,
        unlock_available: true,
        jev: { enabled: true, min_p: 0.9 },
      },
      error: null,
    });
    expect(await checkHumanSend(db, 'cv-1', 'w1', 'Hello')).toEqual({
      blocked: false,
      isStart: true,
      unlockUsed: false,
      unlockAvailable: true,
      jev: { enabled: true, minP: 0.9 },
    });
    expect(db.rpc).toHaveBeenCalledWith('team_activity_start_check', {
      p_conversation: 'cv-1',
      p_channel_id: 'w1',
      p_text: 'Hello',
    });
  });

  it('reads a block', async () => {
    const db = client({
      data: {
        blocked: true,
        rule: 'daily_number',
        block_id: 'b-1',
        unlockable: true,
        detail: { started: 50, limit: 50, warming_up: false },
        is_start: true,
      },
      error: null,
    });
    expect(await checkHumanSend(db, 'cv-1', 'w1', 'x')).toEqual({
      blocked: true,
      rule: 'daily_number',
      blockId: 'b-1',
      unlockable: true,
      detail: { started: 50, limit: 50, warming_up: false },
      isStart: true,
    });
  });

  it('never swallows a deliberate block with an unknown rule', async () => {
    const r = await checkHumanSend(
      client({ data: { blocked: true, rule: 'new_rule' }, error: null }),
      'c',
      null,
      null
    );
    expect(r).toMatchObject({ blocked: true, rule: 'new_rule', blockId: null });
  });

  it('lets the message through on any error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const db of [
      client({ data: null, error: { code: 'PGRST202', message: 'x' } }),
      client({ data: null, error: { code: '42501', message: 'x' } }),
      client({ data: 'odd', error: null }),
      {
        rpc: vi.fn(async () => {
          throw new Error('network');
        }),
      } as unknown as SupabaseClient,
    ]) {
      expect(await checkHumanSend(db, 'c', null, 'hi')).toEqual(ALLOW);
    }
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('recordJevBlock', () => {
  it('records the probability and returns the block id', async () => {
    const db = client({ data: 'b-9', error: null });
    expect(await recordJevBlock(db, 'cv-1', 'w1', 0.93)).toBe('b-9');
    expect(db.rpc).toHaveBeenCalledWith('team_activity_record_block', {
      p_conversation: 'cv-1',
      p_channel_id: 'w1',
      p_rule: 'jev_cold_pitch',
      p_detail: { p: 0.93 },
    });
  });

  it('returns null when the row cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await recordJevBlock(
        client({ data: null, error: { message: 'x' } }),
        'c',
        null,
        0.9
      )
    ).toBeNull();
    error.mockRestore();
  });
});

describe('restrictionMessage', () => {
  it.each([
    ['chase', { steps: 4, limit: 3 }, /last 3 messages/],
    [
      'quiet_hours',
      { start: 22, end: 8, tz: 'Asia/Dubai' },
      /between 22:00 and 08:00 \(Asia\/Dubai\)/,
    ],
    ['daily_user', { started: 20, limit: 20 }, /started 20 new chats today/],
    [
      'daily_user_throttled',
      { started: 10, limit: 10, reply_rate: 12.4 },
      /Only 12%.*lowered to 10/,
    ],
    [
      'daily_number',
      { started: 10, limit: 10, warming_up: true },
      /This WhatsApp number has started 10.*warming up/,
    ],
    [
      'burst',
      { started: 10, limit: 10, retry_after_s: 125 },
      /last 10 minutes.*Wait 3 minutes/,
    ],
    ['link_first', {}, /can't contain a link/],
    ['same_opener', { count: 3, limit: 3 }, /same first message in 3/],
    ['jev_cold_pitch', { p: 0.9 }, /unsolicited sales pitch/],
    ['something_new', {}, /safety rules/],
  ])('%s', (rule, detail, pattern) => {
    expect(restrictionMessage(rule, detail)).toMatch(pattern);
  });

  it('copes with missing figures', () => {
    for (const rule of ['chase', 'daily_user', 'burst', 'same_opener'])
      expect(restrictionMessage(rule, {})).not.toMatch(/null|undefined|NaN/);
  });
});
