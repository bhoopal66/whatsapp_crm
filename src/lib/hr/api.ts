/**
 * Typed wrappers over migration 200's HR RPCs. The browser calls them
 * with the user's session: every RPC is SECURITY DEFINER (`hr_counts`
 * is INVOKER) and re-checks the caller, RLS limits every read, so there
 * is no API route in between. Nothing throws: a refusal comes back as
 * `{ error }` with the RPC's HINT code.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  HR_ERROR_CODES,
  type HrConversation,
  type HrCounts,
  type HrErrorCode,
  type HrFlag,
  type HrInbox,
  type HrOpenKind,
  type HrOutcome,
  type HrRoles,
  type HrRule,
  type HrStage,
  type HrTeamRole,
  type HrTopic,
} from './types';

export type HrResult<T> = { data: T } | { error: HrErrorCode };

/**
 * The refusal code of a PostgREST error: its `hint` when that is one of
 * 200's codes, else UNKNOWN (network, missing function, anything else).
 */
export function hrErrorCode(err: unknown): HrErrorCode {
  const hint =
    err && typeof err === 'object' && 'hint' in err
      ? (err as { hint: unknown }).hint
      : null;
  return typeof hint === 'string' &&
    (HR_ERROR_CODES as readonly string[]).includes(hint)
    ? (hint as HrErrorCode)
    : 'UNKNOWN';
}

async function call<T>(
  sb: SupabaseClient,
  fn: string,
  args?: Record<string, unknown>
): Promise<HrResult<T>> {
  try {
    const { data, error } = await sb.rpc(fn, args);
    if (error) return { error: hrErrorCode(error) };
    return { data: data as T };
  } catch (err) {
    return { error: hrErrorCode(err) };
  }
}

export function hrMyRoles(sb: SupabaseClient): Promise<HrResult<HrRoles>> {
  return call(sb, 'hr_my_roles');
}

/** Idempotent: an existing row comes back unchanged, whatever its inbox. */
export function hrOpen(
  sb: SupabaseClient,
  conversationId: string,
  kind: HrOpenKind
): Promise<HrResult<HrConversation>> {
  return call(sb, 'hr_open', {
    p_conversation_id: conversationId,
    p_kind: kind,
  });
}

/** Moves the chat to recruitment if it is in dept. Backward needs a reason. */
export function hrSetStage(
  sb: SupabaseClient,
  conversationId: string,
  stage: HrStage,
  reason?: string | null
): Promise<HrResult<HrConversation>> {
  return call(sb, 'hr_set_stage', {
    p_conversation_id: conversationId,
    p_stage: stage,
    p_reason: reason ?? null,
  });
}

/** Moves the chat to the department if it is in recruitment. */
export function hrSetTopic(
  sb: SupabaseClient,
  conversationId: string,
  topic: HrTopic
): Promise<HrResult<HrConversation>> {
  return call(sb, 'hr_set_topic', {
    p_conversation_id: conversationId,
    p_topic: topic,
  });
}

export function hrSetFlag(
  sb: SupabaseClient,
  conversationId: string,
  flag: HrFlag,
  value: boolean
): Promise<HrResult<HrConversation>> {
  return call(sb, 'hr_set_flag', {
    p_conversation_id: conversationId,
    p_flag: flag,
    p_value: value,
  });
}

/** Recruiter chats need an outcome; department chats close with none. */
export function hrClose(
  sb: SupabaseClient,
  conversationId: string,
  outcome?: HrOutcome | null
): Promise<HrResult<HrConversation>> {
  return call(sb, 'hr_close', {
    p_conversation_id: conversationId,
    p_outcome: outcome ?? null,
  });
}

export function hrReopen(
  sb: SupabaseClient,
  conversationId: string,
  reason: string
): Promise<HrResult<HrConversation>> {
  return call(sb, 'hr_reopen', {
    p_conversation_id: conversationId,
    p_reason: reason,
  });
}

/** Admin only. A `null` role takes the person off that inbox. */
export async function hrMemberSet(
  sb: SupabaseClient,
  userId: string,
  inbox: HrInbox,
  role: HrTeamRole | null
): Promise<HrResult<null>> {
  const res = await call<unknown>(sb, 'hr_member_set', {
    p_user_id: userId,
    p_inbox: inbox,
    p_role: role,
  });
  return 'error' in res ? res : { data: null };
}

/** What `hrRuleSet` changes; a missing field stays as it is. */
export interface HrRulePatch {
  enabled?: boolean;
  afterHours?: number;
  dueHours?: number;
  title?: string;
}

export function hrRuleSet(
  sb: SupabaseClient,
  key: string,
  patch: HrRulePatch
): Promise<HrResult<HrRule>> {
  return call(sb, 'hr_rule_set', {
    p_key: key,
    p_enabled: patch.enabled ?? null,
    p_after_hours: patch.afterHours ?? null,
    p_due_hours: patch.dueHours ?? null,
    p_title: patch.title ?? null,
  });
}

/** Seeds the caller's account's rules first, then lists them. */
export async function hrRulesList(
  sb: SupabaseClient
): Promise<HrResult<HrRule[]>> {
  const res = await call<HrRule[] | null>(sb, 'hr_rules_list');
  return 'error' in res ? res : { data: res.data ?? [] };
}

export function hrCounts(sb: SupabaseClient): Promise<HrResult<HrCounts>> {
  return call(sb, 'hr_counts');
}
