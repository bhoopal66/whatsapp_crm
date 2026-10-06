import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { checkNewChatAllowed, newChatLimitMessage } from './start-guard';

function client(result: unknown): SupabaseClient {
  return { rpc: vi.fn(async () => result) } as unknown as SupabaseClient;
}

describe('checkNewChatAllowed', () => {
  it('passes the conversation and the number to the check', async () => {
    const db = client({ data: { blocked: false }, error: null });
    expect(await checkNewChatAllowed(db, 'cv-1', 'w1')).toEqual({
      blocked: false,
    });
    expect(db.rpc).toHaveBeenCalledWith('team_activity_start_check', {
      p_conversation_id: 'cv-1',
      p_channel_id: 'w1',
    });
  });

  it('reads a refusal', async () => {
    const db = client({
      data: { blocked: true, reason: 'number', started: 50, limit: 50 },
      error: null,
    });
    expect(await checkNewChatAllowed(db, 'cv-1', 'w1')).toEqual({
      blocked: true,
      reason: 'number',
      started: 50,
      limit: 50,
    });
  });

  it('lets the message through on any error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await checkNewChatAllowed(
        client({ data: null, error: { code: 'PGRST202', message: 'x' } }),
        'c',
        null
      )
    ).toEqual({ blocked: false });
    expect(
      await checkNewChatAllowed(
        client({ data: null, error: { code: '42501', message: 'x' } }),
        'c',
        null
      )
    ).toEqual({ blocked: false });
    const throwing = {
      rpc: vi.fn(async () => {
        throw new Error('network');
      }),
    } as unknown as SupabaseClient;
    expect(await checkNewChatAllowed(throwing, 'c', null)).toEqual({
      blocked: false,
    });
    expect(
      await checkNewChatAllowed(client({ data: 'odd', error: null }), 'c', null)
    ).toEqual({
      blocked: false,
    });
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('newChatLimitMessage', () => {
  it('names whose limit it is', () => {
    expect(
      newChatLimitMessage({
        blocked: true,
        reason: 'user',
        started: 20,
        limit: 20,
      })
    ).toMatch(/You have started 20 new chats today/);
    expect(
      newChatLimitMessage({
        blocked: true,
        reason: 'number',
        started: 50,
        limit: 50,
      })
    ).toMatch(/This WhatsApp number has started 50/);
  });
});
