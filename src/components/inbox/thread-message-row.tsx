'use client';

import { memo, useCallback, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { Message, MessageReaction } from '@/types';
import type { ReminderSuggestion } from '@/lib/reminders/types';
import {
  chipFor,
  chipWhenLabel,
  type ReminderChip,
} from '@/lib/reminders/suggestion-view';
import { MessageActions } from './message-actions';
import { MessageBubble } from './message-bubble';
import { buildReplyPreview } from './reply-quote';
import type { SenderLabel } from './sender-label';

interface ThreadMessageRowProps {
  message: Message;
  /**
   * First of a run of messages from one side (lib/inbox/timeline.ts):
   * gets the bubble tail and the wider gap above. The rest of the run
   * stacks tight beneath it, as on WhatsApp.
   */
  runStart: boolean;
  /**
   * The message this one quotes, when it's loaded. `undefined` with
   * `parentMayBeOlder` means it's in a page not fetched yet.
   */
  parent: Message | undefined;
  /** The thread has older pages, so a missing parent may just be unloaded. */
  parentMayBeOlder: boolean;
  /** Who sent a message: this one's line and its quote's author. */
  senderLabel: (message: Message) => SenderLabel;
  reactions: MessageReaction[] | undefined;
  currentUserId: string | undefined;
  onReply: (message: Message) => void;
  /** Omitted → no Forward button. */
  onForward?: (message: Message) => void;
  /** `emoji === ''` removes the caller's reaction. */
  onSetReaction: (messageId: string, emoji: string) => void;
  onOpenMedia: (messageId: string | null) => void;
  /**
   * The message's reminder suggestion (migration 197), passed only while
   * the feature is on and the viewer may act on it. The chip is worked
   * out here, so the row's props stay the map's own (stable) row.
   */
  reminderSuggestion?: ReminderSuggestion;
  onAddReminder?: (message: Message, chip: ReminderChip) => void;
  onDismissReminder?: (suggestionId: string) => void;
  /**
   * When the thread last took in a suggestion (Date.now() then): the
   * "now" the chip is judged against, so rendering stays pure.
   */
  reminderNowMs?: number;
}

/**
 * One bubble in the thread, with its hover toolbar.
 *
 * Memoised, and fed only stable callbacks keyed by message, so a new
 * inbound message or a status tick re-renders the row that changed —
 * not every bubble in a long history. (The toolbar takes the bubble as
 * `children`, so memoising either alone would do nothing: a fresh
 * child element defeats it. Memoising the pair here does.)
 */
export const ThreadMessageRow = memo(function ThreadMessageRow({
  message,
  runStart,
  parent,
  parentMayBeOlder,
  senderLabel,
  reactions,
  currentUserId,
  onReply,
  onForward,
  onSetReaction,
  onOpenMedia,
  reminderSuggestion,
  onAddReminder,
  onDismissReminder,
  reminderNowMs = 0,
}: ThreadMessageRowProps) {
  const tQuote = useTranslations('Inbox.replyQuote');
  const tReminder = useTranslations('Inbox.reminderSuggestion');
  const locale = useLocale();

  const sender = useMemo(() => senderLabel(message), [senderLabel, message]);

  const hasQuote = !!message.reply_to_message_id;
  const reply = useMemo(() => {
    if (!hasQuote) return null;
    if (parent) {
      return {
        authorLabel: senderLabel(parent).text,
        preview: buildReplyPreview(parent, tQuote),
      };
    }
    // The thread loads a page at a time, so the quoted message may sit in
    // an older page. Keep the reply recognisable as one rather than
    // silently dropping the quote; scrolling up resolves it.
    return parentMayBeOlder
      ? { authorLabel: '', preview: tQuote('message') }
      : null;
  }, [hasQuote, parent, parentMayBeOlder, senderLabel, tQuote]);

  // Toggle semantic for a pill click: same emoji again removes it.
  const handleToggleReaction = useCallback(
    (emoji: string) => {
      const own = reactions?.find(
        (r) => r.actor_type === 'agent' && r.actor_id === currentUserId
      );
      onSetReaction(message.id, own?.emoji === emoji ? '' : emoji);
    },
    [reactions, currentUserId, onSetReaction, message.id]
  );

  const handleReact = useCallback(
    (emoji: string) => {
      if (emoji) onSetReaction(message.id, emoji);
    },
    [onSetReaction, message.id]
  );

  const handleReply = useCallback(() => onReply(message), [onReply, message]);

  const handleForward = useMemo(
    () => (onForward ? () => onForward(message) : undefined),
    [onForward, message]
  );

  // Judged against the thread's last suggestion update, not a clock of
  // its own: an open chip whose time has since come too close stays
  // until the next update, and the dialog refuses a time too soon.
  const nowMs = reminderNowMs;
  const chip =
    onAddReminder && onDismissReminder
      ? chipFor(reminderSuggestion, nowMs)
      : null;
  const reminder = chip
    ? {
        chip,
        label: chipWhenLabel(chip.dueAt, new Date(nowMs), locale, {
          today: tReminder('today'),
          tomorrow: tReminder('tomorrow'),
        }),
        onAdd: () => onAddReminder?.(message, chip),
        onDismiss: () => onDismissReminder?.(chip.suggestionId),
      }
    : undefined;

  return (
    <MessageActions
      message={message}
      onReply={handleReply}
      onForward={handleForward}
      onReact={handleReact}
      className={runStart ? 'mt-3' : 'mt-0.5'}
    >
      <MessageBubble
        message={message}
        sender={sender}
        tail={runStart}
        reply={reply}
        reactions={reactions}
        currentUserId={currentUserId}
        onToggleReaction={handleToggleReaction}
        onOpenMedia={onOpenMedia}
        reminder={reminder}
      />
    </MessageActions>
  );
});
