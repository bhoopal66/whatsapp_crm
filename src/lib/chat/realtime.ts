/**
 * One Supabase realtime channel carrying every chat table's changes.
 * RLS is replayed per subscriber, so nothing leaks; the filters only cut
 * the work: `account_id` where the table has it, `user_id` for the bell
 * (Settings → Workspaces wants every workspace's notifications). DELETE
 * events carry only the primary key and are not RLS-filtered — the
 * reducers ignore ids they do not hold.
 *
 * Handlers are read off `opts` at event time, so a hook can pass one
 * object and swap its callbacks (refs) without resubscribing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { MessageEvent, ReactionEvent } from './message-list';
import {
  toChannel,
  toChannelMember,
  toChatMessage,
  toChatNotification,
  type Channel,
  type ChannelMember,
  type ChatNotification,
} from './types';

type Row = Record<string, unknown>;
type Change = 'insert' | 'update' | 'delete';

export interface ChatSubscription {
  accountId: string;
  userId: string;
  onMessage?: (e: MessageEvent) => void;
  onReaction?: (e: ReactionEvent) => void;
  onPin?: (e: {
    type: 'pin' | 'unpin';
    channelId: string;
    messageId: string;
  }) => void;
  /** `channel` is partial (id only) on delete. */
  onChannel?: (e: { type: Change; channel: Channel }) => void;
  onMember?: (e: {
    type: Change;
    member: Pick<ChannelMember, 'channelId' | 'userId'> &
      Partial<ChannelMember>;
  }) => void;
  onNotification?: (e: {
    type: Change;
    notification: ChatNotification;
  }) => void;
  onStatus?: (status: string) => void;
}

interface Payload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Row;
  old: Row;
}

const change = (p: Payload): Change => p.eventType.toLowerCase() as Change;
const rowOf = (p: Payload): Row => (p.eventType === 'DELETE' ? p.old : p.new);

/** Subscribes; returns the unsubscribe function. */
export function subscribeChat(
  sb: SupabaseClient,
  opts: ChatSubscription
): () => void {
  const topic = `chat:${opts.accountId}:${Math.random().toString(36).slice(2, 10)}`;
  const byAccount = `account_id=eq.${opts.accountId}`;
  let ch = sb.channel(topic);
  const on = (
    table: string,
    filter: string | undefined,
    fn: (p: Payload) => void
  ) => {
    ch = ch.on(
      'postgres_changes' as never,
      { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
      (p: unknown) => fn(p as Payload)
    );
  };

  on('internal_messages', byAccount, (p) => {
    const r = rowOf(p);
    opts.onMessage?.(
      p.eventType === 'DELETE'
        ? { type: 'delete', id: String(r.id) }
        : { type: change(p) as 'insert' | 'update', message: toChatMessage(r) }
    );
  });
  on('internal_message_reactions', undefined, (p) => {
    if (p.eventType === 'UPDATE') return;
    const r = rowOf(p);
    opts.onReaction?.({
      type: p.eventType === 'INSERT' ? 'add' : 'remove',
      messageId: String(r.message_id),
      userId: String(r.user_id),
      emoji: String(r.emoji),
    });
  });
  on('message_pins', undefined, (p) => {
    if (p.eventType === 'UPDATE') return;
    const r = rowOf(p);
    opts.onPin?.({
      type: p.eventType === 'INSERT' ? 'pin' : 'unpin',
      channelId: String(r.channel_id),
      messageId: String(r.message_id),
    });
  });
  on('chat_channels', byAccount, (p) =>
    opts.onChannel?.({ type: change(p), channel: toChannel(rowOf(p)) })
  );
  on('chat_channel_members', undefined, (p) => {
    const r = rowOf(p);
    opts.onMember?.({
      type: change(p),
      member:
        p.eventType === 'DELETE'
          ? { channelId: String(r.channel_id), userId: String(r.user_id) }
          : toChannelMember(r),
    });
  });
  on('chat_notifications', `user_id=eq.${opts.userId}`, (p) =>
    opts.onNotification?.({
      type: change(p),
      notification: toChatNotification(rowOf(p)),
    })
  );

  const channel = ch.subscribe((status) => opts.onStatus?.(status));
  return () => {
    void sb.removeChannel(channel);
  };
}
