/**
 * A case's submission group and its live messages (module 018c over 115),
 * read on the service role. Decides nothing about access: callers gate
 * first (case_timeline, view_case).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { GroupStatus } from '@/lib/submission-groups/rules';
import { toMessage, type GroupMessage } from '@/lib/submission-groups/store';

import { CaseStoreError, date, rows, str } from './store';
import type { Case } from './types';

export interface CaseGroup {
  id: string;
  status: GroupStatus;
  createdAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

const MESSAGE_COLUMNS =
  'id, group_id, direction, sender_user_id, sender_kind, type, body, prefixed_body, media, wa_message_id, wa_timestamp, send_status, post_end, created_at';

/** The case's group in the case's own account, or null. */
export async function loadCaseGroup(
  db: SupabaseClient,
  kase: Pick<Case, 'groupId' | 'accountId'>
): Promise<CaseGroup | null> {
  // 130: a lead has no group.
  if (!kase.groupId) return null;
  const { data, error } = await db
    .from('submission_groups')
    .select('id, status, created_at, ended_at, end_reason')
    .eq('id', kase.groupId)
    .eq('account_id', kase.accountId)
    .maybeSingle();
  if (error) throw new CaseStoreError('submission_groups', error.code ?? null);
  const g = data as Record<string, unknown> | null;
  if (!g) return null;
  return {
    id: String(g.id),
    status: g.status as GroupStatus,
    createdAt: date(g.created_at)!,
    endedAt: date(g.ended_at),
    endReason: str(g.end_reason),
  };
}

/** An ACTIVE group's messages, oldest first; post_end rows excluded. */
export async function liveGroupMessages(
  db: SupabaseClient,
  groupId: string
): Promise<GroupMessage[]> {
  const { data, error } = await db
    .from('submission_group_messages')
    .select(MESSAGE_COLUMNS)
    .eq('group_id', groupId)
    .eq('post_end', false)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error)
    throw new CaseStoreError('submission_group_messages', error.code ?? null);
  return rows(data).map(toMessage);
}
