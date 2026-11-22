'use client';

// ============================================================
// "Pinned — Urgent" / "Unpinned — Maya replied": the notes a chat's pin
// leaves in the thread (migration 153, conversation_events rows of kind
// insight_attention_set / insight_attention_cleared). The set note wears
// the reason's colour from the shared palette; a cleared note names who
// lifted the pin when the timeline can resolve them, else "someone".
// ============================================================

import { useTranslations } from 'next-intl';
import { Pin, PinOff } from 'lucide-react';

import { paletteFor } from '@/lib/insights/palette';
import { pinClearedHow, pinNoteReason } from '@/lib/insights/tag-note';
import { cn } from '@/lib/utils';
import type { ConversationEvent } from '@/types';

export function ThreadPinNote({
  event,
  actorName,
  isMe,
}: {
  event: ConversationEvent;
  actorName: string | null;
  isMe: boolean;
}) {
  const t = useTranslations('TagSuggest.pin');
  const time = new Date(event.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const set = event.kind === 'insight_attention_set';
  const reason = pinNoteReason(event.details);
  const who = isMe ? t('you') : actorName || t('someone');
  const text = set
    ? reason
      ? t('set', { reason: t(`reason.${reason}`) })
      : t('setUnnamed')
    : t(`cleared.${pinClearedHow(event.details)}`, { who });
  const Icon = set ? Pin : PinOff;
  return (
    <div className="my-3 flex justify-center" role="note">
      <span
        className={cn(
          'inline-flex max-w-[90%] items-center gap-1.5 rounded-lg px-3 py-1 text-[11.5px] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]',
          set && reason
            ? paletteFor('attention', reason).chip
            : 'bg-wa-date-chip text-wa-date-chip-fg'
        )}
      >
        {set && reason && (
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              paletteFor('attention', reason).dot
            )}
          />
        )}
        <Icon className="h-3 w-3 shrink-0" />
        <span>
          {text}
          <span className="ms-1 opacity-70">· {time}</span>
        </span>
      </span>
    </div>
  );
}
