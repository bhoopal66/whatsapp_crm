/**
 * Browser wrappers for the recruiter agents (migration 202). Reads go
 * through RLS (recruiter-role users of the active workspace, and
 * `hr_can_see` for drafts); the two writes are SECURITY DEFINER RPCs
 * that re-check the caller; "Draft a reply" is the one API route,
 * because it spends the account's AI key on the server. Nothing throws:
 * a refusal comes back as `{ error }`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { hrErrorCode, type HrResult } from '@/lib/hr/api';
import {
  AGENT_KINDS,
  type AgentKind,
  type AgentLang,
  type DraftStatus,
  type HandoffReason,
  type Intent,
} from './types';

/** A `hr_agent_settings` row. */
export interface HrAgentSettingRow {
  account_id: string;
  agent_kind: AgentKind;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** A `hr_agent_drafts` row. */
export interface HrAgentDraftRow {
  id: string;
  account_id: string;
  conversation_id: string;
  source_message_id: string | null;
  agent_kind: AgentKind;
  intent: Intent;
  body: string;
  lang: AgentLang;
  requires_template: boolean;
  handoff_reason: HandoffReason | null;
  status: DraftStatus;
  decided_by: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  trace: unknown;
  created_by: string | null;
  created_at: string;
}

export type DraftDecision = 'approve' | 'reject';

/** How many drafts a chat's panel lists. */
export const DRAFT_LIST_LIMIT = 20;

const DRAFT_COLUMNS =
  'id, account_id, conversation_id, source_message_id, agent_kind, intent, body, lang, requires_template, handoff_reason, status, decided_by, decided_at, reject_reason, trace, created_by, created_at';

/**
 * A chat's drafts: pending ones first, then the rest, each newest first,
 * at most DRAFT_LIST_LIMIT. Two reads, because a status order cannot put
 * pending first and a single newest-20 read could drop an old pending one.
 */
export async function listDrafts(
  sb: SupabaseClient,
  conversationId: string
): Promise<HrResult<HrAgentDraftRow[]>> {
  try {
    const base = () =>
      sb
        .from('hr_agent_drafts')
        .select(DRAFT_COLUMNS)
        .eq('conversation_id', conversationId);
    const [pending, rest] = await Promise.all([
      base()
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(DRAFT_LIST_LIMIT),
      base()
        .neq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(DRAFT_LIST_LIMIT),
    ]);
    if (pending.error) return { error: hrErrorCode(pending.error) };
    if (rest.error) return { error: hrErrorCode(rest.error) };
    const rows = [
      ...((pending.data ?? []) as HrAgentDraftRow[]),
      ...((rest.data ?? []) as HrAgentDraftRow[]),
    ];
    return { data: rows.slice(0, DRAFT_LIST_LIMIT) };
  } catch (err) {
    return { error: hrErrorCode(err) };
  }
}

async function rpc<T>(
  sb: SupabaseClient,
  fn: string,
  args: Record<string, unknown>
): Promise<HrResult<T>> {
  try {
    const { data, error } = await sb.rpc(fn, args);
    if (error) return { error: hrErrorCode(error) };
    return { data: data as T };
  } catch (err) {
    return { error: hrErrorCode(err) };
  }
}

/** Approve or reject a pending draft; a second decision is ALREADY_DECIDED. */
export function decideDraft(
  sb: SupabaseClient,
  id: string,
  decision: DraftDecision,
  reason?: string | null
): Promise<HrResult<HrAgentDraftRow>> {
  return rpc(sb, 'hr_agent_draft_decide', {
    p_draft_id: id,
    p_decision: decision,
    p_reason: reason?.trim() ? reason.trim() : null,
  });
}

/** Every agent kind's switch; a kind with no row is off. */
export async function agentSettings(
  sb: SupabaseClient
): Promise<HrResult<Record<AgentKind, boolean>>> {
  try {
    const { data, error } = await sb
      .from('hr_agent_settings')
      .select('agent_kind, enabled');
    if (error) return { error: hrErrorCode(error) };
    const out = Object.fromEntries(
      AGENT_KINDS.map((k) => [k, false])
    ) as Record<AgentKind, boolean>;
    for (const row of (data ?? []) as Pick<
      HrAgentSettingRow,
      'agent_kind' | 'enabled'
    >[]) {
      if ((AGENT_KINDS as readonly string[]).includes(row.agent_kind)) {
        out[row.agent_kind] = row.enabled === true;
      }
    }
    return { data: out };
  } catch (err) {
    return { error: hrErrorCode(err) };
  }
}

export function setAgentSetting(
  sb: SupabaseClient,
  kind: AgentKind,
  enabled: boolean
): Promise<HrResult<HrAgentSettingRow>> {
  return rpc(sb, 'hr_agent_settings_set', {
    p_agent_kind: kind,
    p_enabled: enabled,
  });
}

export interface RunAgentsAnswer {
  outcome: 'drafted' | 'handoff' | 'opted_out';
  draftId?: string | null;
}

/**
 * "Draft a reply": POST /api/hr/agents/run. The error is the route's
 * code (`agents_off`, `ai_off`, `limit`, `forbidden`, …), or `failed`
 * when the request itself fails or the answer is not JSON.
 */
export async function runAgents(
  conversationId: string,
  slots?: string[]
): Promise<{ data: RunAgentsAnswer } | { error: string }> {
  try {
    const res = await fetch('/api/hr/agents/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        slots && slots.length ? { conversationId, slots } : { conversationId }
      ),
    });
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok) {
      return {
        error:
          json && typeof json.error === 'string' && json.error
            ? json.error
            : 'failed',
      };
    }
    if (!json || typeof json.outcome !== 'string') return { error: 'failed' };
    return {
      data: {
        outcome: json.outcome as RunAgentsAnswer['outcome'],
        ...(typeof json.draftId === 'string' ? { draftId: json.draftId } : {}),
      },
    };
  } catch {
    return { error: 'failed' };
  }
}
