'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAiAutoReplyLive } from '@/hooks/use-ai-auto-reply-live';
import { useAuth } from '@/hooks/use-auth';
import { useMyNumberIds } from '@/hooks/use-whatsapp-numbers';
import { sharedBankByConversation } from '@/lib/coordinators/ui';
import { scopedChangeBindings } from '@/lib/realtime/scoped-changes';
import {
  countUnreadChats,
  type UnreadCountRow,
} from '@/lib/inbox/unread-counts';
import type { Conversation } from '@/types';

/**
 * What the counts need of a row: its unread count, which list it is in,
 * and whose it is (a team leader's Inbox lists only their own).
 */
type UnreadRow = UnreadCountRow & Pick<Conversation, 'id'>;

/** The columns `UnreadRow` reads; the home dashboard's strip reuses them. */
export const UNREAD_ROW_COLUMNS =
  'id, unread_count, campaign_broadcast_id, human_engaged_at, assigned_agent_id, ai_autoreply_disabled, ai_reply_count, chat_tag_id, user_id, channel_id, send_channel_id';

export interface UnreadChats {
  /** Unread chats the Inbox lists. */
  inbox: number;
  /** Unread chats the Team inbox lists: every one RLS shows. */
  team: number;
}

/**
 * Conversations with at least one unread inbound message, counted for
 * the sidebar's Inbox and Team inbox entries.
 *
 * The two differ only for a team leader: RLS hands them their team's
 * chats too (migration 044), and /inbox narrows them back to their own
 * (`restrictToUserGroup`), so their Inbox count does the same. For
 * everyone else the Inbox already lists all RLS returns.
 *
 * Only chats the Inbox lists count: a campaign chat the bot is
 * answering is in the Campaign inbox instead (migration 067,
 * `inCampaignInbox`), and nobody opens it there to clear its unread
 * count, so counting it would keep the count up for a chat the Inbox
 * does not show.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 */
export function useUnreadChats(): UnreadChats {
  const aiLive = useAiAutoReplyLive() === true;
  const { accountId, accountRole, user } = useAuth();
  const userId = user?.id ?? null;
  const narrowed = accountRole === 'team_leader' && !!userId;
  const myNumberIds = useMyNumberIds();
  // Chats shared with a leader as a coordinator (migration 133) are in
  // their Inbox too. Read once per workspace, without the Inbox page's
  // live re-read: a share made meanwhile is counted from the next load.
  const [shared, setShared] = useState<{
    accountId: string;
    ids: string[];
  } | null>(null);

  useEffect(() => {
    if (!narrowed || !accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient().rpc('my_coordinator_shares');
      if (cancelled || error) return;
      setShared({
        accountId,
        // Sorted as the Inbox sorts them, so the cap in
        // `inRestrictedInbox` keeps the same 100 the list asks for.
        ids: [...sharedBankByConversation(data ?? []).keys()].sort(),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [narrowed, accountId]);
  // Live mirror of the unread rows, so INSERT/UPDATE/DELETE events
  // adjust it without refetching. Replaced, never mutated, so the count
  // below recomputes from state.
  const [rows, setRows] = useState<ReadonlyMap<string, UnreadRow>>(
    () => new Map()
  );

  useEffect(() => {
    // Scoped to the active account (RLS shows nothing else), so Realtime
    // neither checks nor ships other workspaces' rows. Unknown account:
    // no channel at all, never an unfiltered one. A workspace switch
    // changes `accountId`, which tears this down and starts over.
    const bindings = scopedChangeBindings(
      'conversations',
      'account_id',
      accountId
    );
    if (!bindings) return;
    const supabase = createClient();
    let cancelled = false;

    // Initial load. RLS scopes this to the signed-in user automatically —
    // no explicit user_id filter needed here.
    //
    // Only the unread rows: they are all the count is made of, and on a
    // busy account "every conversation" is thousands of rows (and past
    // PostgREST's max-rows, silently truncated) fetched on every page of
    // the app just to show one count. Rows missing from the mirror are
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

    // The topic names the account: removeChannel is async, and a re-run
    // on the same topic would be handed the channel still leaving.
    let channel = supabase.channel(`total-unread-realtime:${accountId}`);
    for (const binding of bindings) {
      channel = channel.on('postgres_changes', binding, (payload) => {
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
      });
    }
    channel.subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      // A workspace switch must not keep counting the old one's chats
      // until the new read lands.
      setRows(new Map());
    };
  }, [accountId]);

  const sharedIds = shared?.accountId === accountId ? shared.ids : null;

  // Recount — cheap, conversations per user stay small. Until a
  // leader's numbers and shares are known, only the chats they created
  // or hold count towards their Inbox.
  return useMemo(
    () =>
      countUnreadChats(
        rows.values(),
        aiLive,
        narrowed && userId
          ? {
              userId,
              channelIds: myNumberIds ?? [],
              sharedConversationIds: sharedIds ?? [],
            }
          : null
      ),
    [rows, aiLive, narrowed, userId, myNumberIds, sharedIds]
  );
}
