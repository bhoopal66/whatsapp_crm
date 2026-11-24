// ============================================================
// Assignment rotation, chat limits and settings (migration 236).
//
// Thin wrappers over the SQL functions. None of them throws: a failed
// call (network, a database without 236) comes back as a result with
// reason 'error' or the defaults, because every caller sits on a path
// that must not fail for it (the inbound pipeline inside after(), an
// automation step, a Compass send that already reached the customer).
//
// The rules live in SQL (`assignment_rotate_assign`,
// `assignment_compass_assign`): who is eligible, the order, the limits,
// the locks. Nothing here decides.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ASSIGNMENT_SETTINGS_DEFAULTS,
  type AssignmentSettings,
  type CompassAssignReason,
  type CompassAssignResult,
  type MemberLoad,
  type RotateReason,
  type RotateResult,
} from './types';

export * from './types';

const ROTATE_REASONS: ReadonlySet<string> = new Set<RotateReason>([
  'assigned',
  'already_assigned',
  'engaged',
  'personal',
  'not_found',
  'nobody_eligible',
]);

const COMPASS_REASONS: ReadonlySet<string> = new Set<CompassAssignReason>([
  'off',
  'assigned',
  'agent_not_eligible',
  'already_assigned',
  'engaged',
  'personal',
  'not_found',
]);

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Hand an unassigned company chat to the next eligible person of a
 * rotation pool. `candidates` (auth user ids, in order) empty or absent
 * means every live agent and team leader. Service-role client only.
 */
export async function rotateAssign(
  db: SupabaseClient,
  input: {
    accountId: string;
    conversationId: string;
    poolKey: string;
    candidates?: string[] | null;
  }
): Promise<RotateResult> {
  try {
    const candidates =
      input.candidates && input.candidates.length > 0 ? input.candidates : null;
    const { data, error } = await db.rpc('assignment_rotate_assign', {
      p_account_id: input.accountId,
      p_conversation_id: input.conversationId,
      p_pool_key: input.poolKey,
      p_candidates: candidates,
    });
    if (error) {
      return { assignedTo: null, reason: 'error', error: errorText(error) };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    const reason = asString(row.reason);
    if (!reason || !ROTATE_REASONS.has(reason)) {
      return {
        assignedTo: null,
        reason: 'error',
        error: `unexpected answer: ${JSON.stringify(data)}`,
      };
    }
    return {
      assignedTo: asString(row.assigned_to),
      reason: reason as RotateReason,
    };
  } catch (err) {
    return { assignedTo: null, reason: 'error', error: errorText(err) };
  }
}

/**
 * Compass: give a chat with no assignee to the case's agent and share
 * it with the case's coordinator, when the account's switch is on.
 * Off, the SQL changes nothing. Service-role client only.
 */
export async function compassAssign(
  db: SupabaseClient,
  input: {
    accountId: string;
    conversationId: string;
    agentUserId: string | null;
    coordinatorUserId: string | null;
    bankCode: string | null;
  }
): Promise<CompassAssignResult> {
  const failed = (error: string): CompassAssignResult => ({
    enabled: false,
    assignedTo: null,
    reason: 'error',
    sharedWith: null,
    shareCreated: false,
    shareReason: null,
    error,
  });
  try {
    const { data, error } = await db.rpc('assignment_compass_assign', {
      p_account_id: input.accountId,
      p_conversation_id: input.conversationId,
      p_agent_user_id: input.agentUserId,
      p_coordinator_user_id: input.coordinatorUserId,
      p_bank_code: input.bankCode,
    });
    if (error) return failed(errorText(error));
    const row = (data ?? {}) as Record<string, unknown>;
    const reason = asString(row.reason);
    if (!reason || !COMPASS_REASONS.has(reason)) {
      return failed(`unexpected answer: ${JSON.stringify(data)}`);
    }
    return {
      enabled: row.enabled === true,
      assignedTo: asString(row.assigned_to),
      reason: reason as CompassAssignReason,
      sharedWith: asString(row.shared_with),
      shareCreated: row.share_created === true,
      shareReason: asString(row.share_reason),
    };
  } catch (err) {
    return failed(errorText(err));
  }
}

/** A settings row (snake_case, as stored) read into the TS shape. */
export function parseAssignmentSettings(
  row: Record<string, unknown> | null | undefined
): AssignmentSettings {
  if (!row) return { ...ASSIGNMENT_SETTINGS_DEFAULTS, broadcastPool: [] };
  const limit = Number(row.default_chat_limit);
  return {
    broadcastRotationEnabled: row.broadcast_rotation_enabled === true,
    broadcastPool: Array.isArray(row.broadcast_pool)
      ? (row.broadcast_pool as unknown[]).filter(
          (u): u is string => typeof u === 'string' && u.length > 0
        )
      : [],
    compassAssignEnabled: row.compass_assign_enabled === true,
    limitsEnabled: row.limits_enabled === true,
    defaultChatLimit:
      Number.isInteger(limit) && limit >= 1 && limit <= 500
        ? limit
        : ASSIGNMENT_SETTINGS_DEFAULTS.defaultChatLimit,
  };
}

/**
 * The account's assignment settings; the defaults (everything off) when
 * there is no row or the read fails. With a member's RLS client this
 * reads their active account's row; with the service role, any.
 */
export async function loadAssignmentSettings(
  db: SupabaseClient,
  accountId: string
): Promise<AssignmentSettings> {
  try {
    const { data, error } = await db
      .from('assignment_settings')
      .select(
        'broadcast_rotation_enabled, broadcast_pool, compass_assign_enabled, limits_enabled, default_chat_limit'
      )
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[assignment] settings read failed:', error);
      return parseAssignmentSettings(null);
    }
    return parseAssignmentSettings(data as Record<string, unknown> | null);
  } catch (err) {
    console.error('[assignment] settings read failed:', err);
    return parseAssignmentSettings(null);
  }
}

/**
 * Open company chats and limits per member of the caller's active
 * account (assignment_member_loads). Signed-in client. Null when they
 * could not be read: an empty list would say nobody has an open chat.
 */
export async function loadMemberLoads(
  db: SupabaseClient
): Promise<MemberLoad[] | null> {
  try {
    const { data, error } = await db.rpc('assignment_member_loads');
    if (error || !Array.isArray(data)) return null;
    return (data as Record<string, unknown>[]).flatMap((r) => {
      const userId = asString(r.user_id);
      if (!userId) return [];
      const limit = r.chat_limit;
      return [
        {
          userId,
          openCount: Number(r.open_count) || 0,
          chatLimit:
            typeof limit === 'number' && Number.isFinite(limit) ? limit : null,
        },
      ];
    });
  } catch {
    return null;
  }
}

export type AssignmentWriteResult =
  | { ok: true; settings?: AssignmentSettings }
  | { ok: false; code: string; error: string };

function writeFailure(error: unknown): AssignmentWriteResult {
  const e = (error ?? {}) as { code?: string; hint?: string; message?: string };
  return {
    ok: false,
    code: e.hint || e.code || 'error',
    error: e.message || 'Request failed',
  };
}

/**
 * Save assignment settings as the signed-in owner/admin
 * (assignment_settings_set). Fields left out keep their value.
 */
export async function saveAssignmentSettings(
  db: SupabaseClient,
  patch: Partial<AssignmentSettings>
): Promise<AssignmentWriteResult> {
  try {
    const { data, error } = await db.rpc('assignment_settings_set', {
      p_broadcast_rotation_enabled: patch.broadcastRotationEnabled ?? null,
      p_broadcast_pool: patch.broadcastPool ?? null,
      p_compass_assign_enabled: patch.compassAssignEnabled ?? null,
      p_limits_enabled: patch.limitsEnabled ?? null,
      p_default_chat_limit: patch.defaultChatLimit ?? null,
    });
    if (error) return writeFailure(error);
    return {
      ok: true,
      settings: parseAssignmentSettings(data as Record<string, unknown>),
    };
  } catch (err) {
    return writeFailure(err);
  }
}

/**
 * Set (1-500) or remove (null) a member's own chat limit as the
 * signed-in owner/admin (assignment_chat_limit_set).
 */
export async function setChatLimit(
  db: SupabaseClient,
  userId: string,
  maxOpen: number | null
): Promise<AssignmentWriteResult> {
  try {
    const { error } = await db.rpc('assignment_chat_limit_set', {
      p_user_id: userId,
      p_max_open: maxOpen,
    });
    return error ? writeFailure(error) : { ok: true };
  } catch (err) {
    return writeFailure(err);
  }
}
