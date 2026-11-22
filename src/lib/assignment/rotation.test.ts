import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ASSIGNMENT_SETTINGS_DEFAULTS,
  automationPoolKey,
  compassAssign,
  loadAssignmentSettings,
  loadMemberLoads,
  parseAssignmentSettings,
  rotateAssign,
  saveAssignmentSettings,
  setChatLimit,
} from './rotation';

function rpcClient(answer: unknown | (() => unknown)) {
  const rpc = vi.fn(async () =>
    typeof answer === 'function' ? (answer as () => unknown)() : answer
  );
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

function tableClient(answer: { data: unknown; error: unknown } | Error) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    db: { from: vi.fn(() => builder) } as unknown as SupabaseClient,
    builder,
  };
}

describe('rotateAssign', () => {
  it('passes the pool and candidates and reads the pick', async () => {
    const { db, rpc } = rpcClient({
      data: { assigned_to: 'u2', reason: 'assigned' },
      error: null,
    });
    const out = await rotateAssign(db, {
      accountId: 'a1',
      conversationId: 'c1',
      poolKey: 'broadcast',
      candidates: ['u1', 'u2'],
    });
    expect(out).toEqual({ assignedTo: 'u2', reason: 'assigned' });
    expect(rpc).toHaveBeenCalledWith('assignment_rotate_assign', {
      p_account_id: 'a1',
      p_conversation_id: 'c1',
      p_pool_key: 'broadcast',
      p_candidates: ['u1', 'u2'],
    });
  });

  it('sends an empty pool as NULL (the default pool)', async () => {
    const { db, rpc } = rpcClient({
      data: { assigned_to: null, reason: 'nobody_eligible' },
      error: null,
    });
    const out = await rotateAssign(db, {
      accountId: 'a1',
      conversationId: 'c1',
      poolKey: 'broadcast',
      candidates: [],
    });
    expect(out).toEqual({ assignedTo: null, reason: 'nobody_eligible' });
    expect(rpc.mock.calls[0]).toEqual([
      'assignment_rotate_assign',
      expect.objectContaining({ p_candidates: null }),
    ]);
  });

  it('turns an RPC error into reason error', async () => {
    const { db } = rpcClient({ data: null, error: { message: 'boom' } });
    expect(
      await rotateAssign(db, {
        accountId: 'a',
        conversationId: 'c',
        poolKey: 'p',
      })
    ).toEqual({ assignedTo: null, reason: 'error', error: 'boom' });
  });

  it('never throws, even when the client does', async () => {
    const { db } = rpcClient(() => {
      throw new Error('network');
    });
    const out = await rotateAssign(db, {
      accountId: 'a',
      conversationId: 'c',
      poolKey: 'p',
    });
    expect(out.reason).toBe('error');
    expect(out.error).toBe('network');
  });

  it('rejects an answer it does not recognise', async () => {
    const { db } = rpcClient({ data: { reason: 'maybe' }, error: null });
    const out = await rotateAssign(db, {
      accountId: 'a',
      conversationId: 'c',
      poolKey: 'p',
    });
    expect(out.reason).toBe('error');
  });
});

describe('compassAssign', () => {
  const input = {
    accountId: 'a1',
    conversationId: 'c1',
    agentUserId: 'agent',
    coordinatorUserId: 'coord',
    bankCode: 'ADCB',
  };

  it('reads what the SQL did', async () => {
    const { db, rpc } = rpcClient({
      data: {
        enabled: true,
        assigned_to: 'agent',
        reason: 'assigned',
        shared_with: 'coord',
        share_created: true,
        share_reason: 'shared',
      },
      error: null,
    });
    expect(await compassAssign(db, input)).toEqual({
      enabled: true,
      assignedTo: 'agent',
      reason: 'assigned',
      sharedWith: 'coord',
      shareCreated: true,
      shareReason: 'shared',
    });
    expect(rpc).toHaveBeenCalledWith('assignment_compass_assign', {
      p_account_id: 'a1',
      p_conversation_id: 'c1',
      p_agent_user_id: 'agent',
      p_coordinator_user_id: 'coord',
      p_bank_code: 'ADCB',
    });
  });

  it('reports off as off', async () => {
    const { db } = rpcClient({
      data: { enabled: false, assigned_to: null, reason: 'off' },
      error: null,
    });
    const out = await compassAssign(db, input);
    expect(out.reason).toBe('off');
    expect(out.enabled).toBe(false);
  });

  it('reads engaged (a person is working the chat) as a known reason', async () => {
    const { db } = rpcClient({
      data: {
        enabled: true,
        assigned_to: null,
        reason: 'engaged',
        shared_with: 'coord',
        share_created: false,
        share_reason: 'already_shared',
      },
      error: null,
    });
    const out = await compassAssign(db, input);
    expect(out.reason).toBe('engaged');
    expect(out.assignedTo).toBeNull();
    expect(out.error).toBeUndefined();
  });

  it('never throws', async () => {
    const { db } = rpcClient(() => {
      throw new Error('down');
    });
    const out = await compassAssign(db, input);
    expect(out.reason).toBe('error');
    expect(out.assignedTo).toBeNull();
  });
});

describe('settings', () => {
  it('no row reads as the defaults', async () => {
    const { db } = tableClient({ data: null, error: null });
    expect(await loadAssignmentSettings(db, 'a1')).toEqual(
      ASSIGNMENT_SETTINGS_DEFAULTS
    );
  });

  it('a read error or a throw reads as the defaults', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await loadAssignmentSettings(
        tableClient({ data: null, error: { message: 'x' } }).db,
        'a1'
      )
    ).toEqual(ASSIGNMENT_SETTINGS_DEFAULTS);
    expect(
      await loadAssignmentSettings(tableClient(new Error('x')).db, 'a1')
    ).toEqual(ASSIGNMENT_SETTINGS_DEFAULTS);
    quiet.mockRestore();
  });

  it('parses a stored row', () => {
    expect(
      parseAssignmentSettings({
        broadcast_rotation_enabled: true,
        broadcast_pool: ['u1', null, 'u2'],
        compass_assign_enabled: true,
        limits_enabled: true,
        default_chat_limit: 12,
      })
    ).toEqual({
      broadcastRotationEnabled: true,
      broadcastPool: ['u1', 'u2'],
      compassAssignEnabled: true,
      limitsEnabled: true,
      defaultChatLimit: 12,
    });
  });

  it('saves only the fields given', async () => {
    const { db, rpc } = rpcClient({
      data: { limits_enabled: true, default_chat_limit: 30 },
      error: null,
    });
    const out = await saveAssignmentSettings(db, { limitsEnabled: true });
    expect(out.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('assignment_settings_set', {
      p_broadcast_rotation_enabled: null,
      p_broadcast_pool: null,
      p_compass_assign_enabled: null,
      p_limits_enabled: true,
      p_default_chat_limit: null,
    });
  });

  it('a refusal carries its hint as the code', async () => {
    const { db } = rpcClient({
      data: null,
      error: { code: '22023', hint: 'pool_member_invalid', message: 'no' },
    });
    expect(await saveAssignmentSettings(db, { broadcastPool: ['x'] })).toEqual({
      ok: false,
      code: 'pool_member_invalid',
      error: 'no',
    });
  });

  it('sets and removes a chat limit', async () => {
    const { db, rpc } = rpcClient({ data: true, error: null });
    expect(await setChatLimit(db, 'u1', null)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('assignment_chat_limit_set', {
      p_user_id: 'u1',
      p_max_open: null,
    });
  });
});

describe('loadMemberLoads', () => {
  it('maps rows and keeps a null limit', async () => {
    const { db } = rpcClient({
      data: [
        { user_id: 'u1', open_count: 12, chat_limit: 30 },
        { user_id: 'u2', open_count: 0, chat_limit: null },
      ],
      error: null,
    });
    expect(await loadMemberLoads(db)).toEqual([
      { userId: 'u1', openCount: 12, chatLimit: 30 },
      { userId: 'u2', openCount: 0, chatLimit: null },
    ]);
  });

  it('is empty on error', async () => {
    const { db } = rpcClient({ data: null, error: { message: 'x' } });
    expect(await loadMemberLoads(db)).toEqual([]);
  });
});

describe('pool keys', () => {
  it('names an automation step pool', () => {
    expect(automationPoolKey('auto-1', 'step-2')).toBe(
      'automation:auto-1:step-2'
    );
  });
});
