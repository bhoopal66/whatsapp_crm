'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAiAutoReplyLive } from '@/hooks/use-ai-auto-reply-live';
import {
  inCampaignInbox,
  type CampaignInboxFields,
} from '@/lib/inbox/campaign-inbox';
import type { Conversation } from '@/types';

/** What the count needs of a row: its unread count, and which list it is in. */
type UnreadRow = Pick<Conversation, 'id' | 'unread_count'> &
  CampaignInboxFields;

const UNREAD_ROW_COLUMNS =
  'id, unread_count, campaign_broadcast_id, human_engaged_at, assigned_agent_id, ai_autoreply_disabled, ai_reply_count';

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Only chats the Inbox lists count: a campaign chat the bot is
 * answering is in the Campaign inbox instead (migration 067,
 * `inCampaignInbox`), and nobody opens it there to clear its unread
 * count, so counting it would keep the dot lit for a chat the Inbox
 * does not show.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 */
export function useTotalUnread(): number {
  const aiLive = useAiAutoReplyLive() === true;
  // Live mirror of the unread rows, so INSERT/UPDATE/DELETE events
  // adjust it without refetching. Replaced, never mutated, so the count
  // below recomputes from state.
  const [rows, setRows] = useState<ReadonlyMap<string, UnreadRow>>(
    () => new Map()
  );

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Initial load. RLS scopes this to the signed-in user automatically —
    // no explicit user_id filter needed here.
    //
    // Only the unread rows: they are all the count is made of, and on a
    // busy account "every conversation" is thousands of rows (and past
    // PostgREST's max-rows, silently truncated) fetched on every page of
    // the app just to light one dot. Rows missing from the mirror are
    // read as 0, and the realtime handler below adds any row it sees.
    (async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select(UNREAD_ROW_COLUMNS)
        .gt('unread_count', 0);
      if (cancelled || error || !data) return;

      const map = new Map<string, UnreadRow>();
      for (const row of data as UnreadRow[]) map.set(row.id, row);
      setRows(map);
    })();

    const channel = supabase
      .channel('total-unread-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (payload) => {
          setRows((prev) => {
            const next = new Map(prev);
            if (payload.eventType === 'DELETE') {
              const oldRow = payload.old as Partial<Conversation>;
              if (oldRow.id) next.delete(oldRow.id);
            } else {
              const row = payload.new as UnreadRow;
              if ((row.unread_count ?? 0) > 0) next.set(row.id, row);
              else next.delete(row.id);
            }
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  // Recount — cheap, conversations per user stay small.
  return useMemo(() => {
    let sum = 0;
    for (const row of rows.values()) {
      if ((row.unread_count ?? 0) > 0 && !inCampaignInbox(row, aiLive)) {
        sum += 1;
      }
    }
    return sum;
  }, [rows, aiLive]);
}
