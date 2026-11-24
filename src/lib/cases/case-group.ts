/**
 * A case's submission group and its live messages (module 018c over 115),
 * read on the service role. Decides nothing about access: callers gate
 * first (case_timeline, view_case).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { GroupStatus } from '@/lib/submission-groups/rules';
import {
  toMessage,
  type GroupMessage,
  type WaMode,
} from '@/lib/submission-groups/store';
import {
  DETAIL_MESSAGE_LIMIT,
  messagePage,
} from '@/lib/submission-groups/views';

import { CaseStoreError, date, rows, str } from './store';
import type { Case } from './types';

export interface CaseGroup {
  /** 136: 'none' = a submission with no WhatsApp group. */
  waMode: WaMode;
  id: string;
  status: GroupStatus;
  createdAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

const MESSAGE_COLUMNS =
  'id, group_id, direction, sender_user_id, sender_wa_id, sender_kind, type, body, prefixed_body, media, wa_message_id, wa_timestamp, send_status, post_end, created_at, system_kind';

/** The case's group in the case's own account, or null. */
export async function loadCaseGroup(
  db: SupabaseClient,
  kase: Pick<Case, 'groupId' | 'accountId'>
): Promise<CaseGroup | null> {
  // 130: a lead has no group.
  if (!kase.groupId) return null;
  const { data, error } = await db
    .from('submission_groups')
    .select('id, status, created_at, ended_at, end_reason, wa_mode')
    .eq('id', kase.groupId)
    .eq('account_id', kase.accountId)
    .maybeSingle();
  if (error) throw new CaseStoreError('submission_groups', error.code ?? null);
  const g = data as Record<string, unknown> | null;
  if (!g) return null;
  return {
    id: String(g.id),
    status: g.status as GroupStatus,
    waMode: g.wa_mode === 'none' ? 'none' : 'group',
    createdAt: date(g.created_at)!,
    endedAt: date(g.ended_at),
    endReason: str(g.end_reason),
  };
}

/**
 * An ACTIVE group's newest messages, oldest first; post_end rows excluded.
 * Read newest first under a limit of our own: an unlimited read is cut at
 * PostgREST's max rows, and oldest first that cut off the newest messages.
 * `truncated`: older ones are left out.
 */
export async function liveGroupMessages(
  db: SupabaseClient,
  groupId: string
): Promise<{ messages: GroupMessage[]; truncated: boolean }> {
  const data = await newestLive(
    db,
    groupId,
    MESSAGE_COLUMNS,
    DETAIL_MESSAGE_LIMIT + 1
  );
  const page = messagePage(rows(data));
  return { messages: page.rows.map(toMessage), truncated: page.hasMore };
}

/** When the newest of those messages was written, or null for none; no content. */
export async function newestLiveMessageAt(
  db: SupabaseClient,
  groupId: string
): Promise<Date | null> {
  const [row] = rows(await newestLive(db, groupId, 'created_at', 1));
  return date(row?.created_at);
}

async function newestLive(
  db: SupabaseClient,
  groupId: string,
  columns: string,
  limit: number
): Promise<unknown> {
  const { data, error } = await db
    .from('submission_group_messages')
    .select(columns)
    .eq('group_id', groupId)
    .eq('post_end', false)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error)
    throw new CaseStoreError('submission_group_messages', error.code ?? null);
  return data;
}
