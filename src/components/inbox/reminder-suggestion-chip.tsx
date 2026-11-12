'use client';

// The pill under a chat message that names a later time (migration
// 197): "Add reminder · Tomorrow 15:00" with a × (Not a reminder) while
// open, "Reminder set · Tomorrow 15:00" once its follow-up task exists.
// What the chip is, and the "when" words, come from
// lib/reminders/suggestion-view.ts.

import { useTranslations } from 'next-intl';
import { AlarmClock, CheckCircle2, X } from 'lucide-react';

import type { ReminderChip } from '@/lib/reminders/suggestion-view';
import { cn } from '@/lib/utils';

export interface ReminderSuggestionChipProps {
  chip: ReminderChip;
  /** The "when" words, from `chipWhenLabel`. */
  label: string;
  onAdd: () => void;
  onDismiss: () => void;
}

const PILL =
  'mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs';

export function ReminderSuggestionChip({
  chip,
  label,
  onAdd,
  onDismiss,
}: ReminderSuggestionChipProps) {
  const t = useTranslations('Inbox.reminderSuggestion');

  if (chip.state === 'added') {
    return (
      <div
        className={cn(PILL, 'border-success/40 bg-success-soft text-success')}
        title={t('setTitle', { when: label })}
      >
        <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          {t('set')} · {label}
        </span>
      </div>
    );
  }

  return (
    <div className={cn(PILL, 'border-warning/40 bg-warning-soft text-warning')}>
      <button
        type="button"
        onClick={onAdd}
        title={t('addTitle', { when: label })}
        className="inline-flex items-center gap-1 font-medium hover:underline"
      >
        <AlarmClock className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          {t('add')} · {label}
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('dismiss')}
        title={t('dismiss')}
        className="hover:bg-warning/15 -mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}
