'use client';

// Reply / Note above the composer (migration 241). Reply writes to the
// customer; Note writes to the team only. Shown only to people who may
// write notes (agent and up).

import { useTranslations } from 'next-intl';
import { MessageSquare, StickyNote } from 'lucide-react';

import { cn } from '@/lib/utils';

export type ComposerMode = 'reply' | 'note';

export function ComposerModeSwitch({
  mode,
  onChange,
  noteDisabled = false,
}: {
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
  /** A recording or staged attachment is open in the reply composer:
   *  hiding it would leave the mic live out of sight. */
  noteDisabled?: boolean;
}) {
  const t = useTranslations('ChatNotes');
  const options = [
    { id: 'reply' as const, icon: MessageSquare, label: t('reply') },
    { id: 'note' as const, icon: StickyNote, label: t('note') },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t('modeLabel')}
      className="mb-1.5 flex items-center gap-1 px-1"
    >
      {options.map(({ id, icon: Icon, label }) => {
        const active = mode === id;
        const disabled = id === 'note' && !active && noteDisabled;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={disabled ? t('finishReplyFirst') : undefined}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors',
              active
                ? id === 'note'
                  ? 'bg-warning-soft text-warning'
                  : 'bg-wa-input text-wa-text'
                : 'text-wa-text-secondary hover:bg-wa-icon-hover',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
