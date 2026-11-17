import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  assertAutoStartAllowed,
  checkAutoStartAllowed,
  NumberDailyLimitError,
  numberDailyLimitMessage,
  campaignDailyLimitMessage,
} from './auto-guard';

function client(result: unknown): SupabaseClient {
  return { rpc: vi.fn(async () => result) } as unknown as SupabaseClient;
}

const WHAPI = { id: 'w1', provider: 'whapi' as const };
const OPENWA = { id: 'o1', provider: 'openwa' as const };
const META = { id: 'm1', provider: 'meta' as const };

const BLOCKED = {
  data: {
    blocked: true,
    rule: 'daily_number',
    block_id: 'blk-1',
    detail: { started: 10, limit: 10, warming_up: true },
  },
  error: null,
};

describe('checkAutoStartAllowed', () => {
  it('passes the account, conversation and number to the check', async () => {
    const db = client({ data: { blocked: false }, error: null });
    expect(await checkAutoStartAllowed(db, 'a1', 'cv-1', WHAPI)).toEqual({
      blocked: false,
    });
    expect(db.rpc).toHaveBeenCalledWith('team_activity_auto_check', {
      p_account: 'a1',
      p_conversation: 'cv-1',
      p_channel_id: 'w1',
    });
  });

  it('reads a refusal', async () => {
    expect(
      await checkAutoStartAllowed(client(BLOCKED), 'a1', null, OPENWA)
    ).toEqual({
      blocked: true,
      blockId: 'blk-1',
      started: 10,
      limit: 10,
      warmingUp: true,
    });
  });

  it('never asks for the Meta number', async () => {
    const db = client(BLOCKED);
    expect(await checkAutoStartAllowed(db, 'a1', 'cv-1', META)).toEqual({
      blocked: false,
    });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('lets the message through on any error, warning once when missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = client({
      data: null,
      error: { code: 'PGRST202', message: 'x' },
    });
    expect(await checkAutoStartAllowed(missing, 'a', 'c', WHAPI)).toEqual({
      blocked: false,
    });
    expect(await checkAutoStartAllowed(missing, 'a', 'c', WHAPI)).toEqual({
      blocked: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      await checkAutoStartAllowed(
        client({ data: null, error: { code: '42501', message: 'x' } }),
        'a',
        'c',
        WHAPI
      )
    ).toEqual({ blocked: false });
    const throwing = {
      rpc: vi.fn(async () => {
        throw new Error('network');
      }),
    } as unknown as SupabaseClient;
    expect(await checkAutoStartAllowed(throwing, 'a', 'c', WHAPI)).toEqual({
      blocked: false,
    });
    expect(error).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('assertAutoStartAllowed', () => {
  it('returns quietly when allowed', async () => {
    await expect(
      assertAutoStartAllowed(
        client({ data: { blocked: false }, error: null }),
        'a1',
        'cv-1',
        WHAPI,
        'flows'
      )
    ).resolves.toBeUndefined();
  });

  it('throws the readable refusal when blocked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await assertAutoStartAllowed(
      client(BLOCKED),
      'a1',
      'cv-1',
      WHAPI,
      'flows'
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(NumberDailyLimitError);
    expect(err).toMatchObject({ code: 'number_daily_limit' });
    expect((err as Error).message).toMatch(/started 10 new chats today/);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('numberDailyLimitMessage', () => {
  it('names the limit, and says so when it is a warm-up limit', () => {
    expect(numberDailyLimitMessage({ blocked: true, limit: 50 })).toMatch(
      /started 50 new chats today, its daily limit\./
    );
    expect(
      numberDailyLimitMessage({ blocked: true, limit: 10, warmingUp: true })
    ).toMatch(/while it warms up/);
    expect(numberDailyLimitMessage({ blocked: true })).toMatch(
      /reached its daily limit/
    );
  });
});

describe('campaignDailyLimitMessage', () => {
  it('tells the sender to resume the campaign tomorrow', () => {
    expect(campaignDailyLimitMessage({ blocked: true, limit: 50 })).toBe(
      'This number reached its daily limit of 50 new chats. Press Resume tomorrow to send the rest.'
    );
    expect(
      campaignDailyLimitMessage({ blocked: true, limit: 10, warmingUp: true })
    ).toMatch(/of 10 new chats while it warms up\. Press Resume tomorrow/);
    expect(campaignDailyLimitMessage({ blocked: true })).toBe(
      'This number reached its daily limit of new chats. Press Resume tomorrow to send the rest.'
    );
  });
});
