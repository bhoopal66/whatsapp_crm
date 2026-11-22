'use client';

// ============================================================
// "Tagged automatically: Interested · ADCB · 92%" — the note Jev's
// automatic tagging leaves in the thread (migration 147, a
// conversation_events row of kind chat_tag_auto). Drawn like the
// channel-switch note (ThreadChannelNote), centred like the date chips.
// The name is the one stored at tagging time, so a later rename or
// delete does not change what the note says.
// ============================================================

import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';

import { autoTagPercent } from '@/lib/insights/tag-note';
import type { ConversationEvent } from '@/types';

export function ThreadAutoTagNote({ event }: { event: ConversationEvent }) {
  const t = useTranslations('TagSuggest');
  const time = new Date(event.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const tags = event.to_label?.trim() || null;
  const percent = autoTagPercent(event.details);
  const text = !tags
    ? t('autoNoteUnnamed')
    : percent === null
      ? t('autoNote', { tags })
      : t('autoNoteWithPercent', { tags, percent });
  return (
    <div className="my-3 flex justify-center" role="note">
      <span className="bg-wa-date-chip text-wa-date-chip-fg inline-flex max-w-[90%] items-center gap-1.5 rounded-lg px-3 py-1 text-[11.5px] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
        <Sparkles className="h-3 w-3 shrink-0" />
        <span>
          {text}
          <span className="ms-1 opacity-70">· {time}</span>
        </span>
      </span>
    </div>
  );
}
