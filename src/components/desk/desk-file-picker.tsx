'use client';

/**
 * The desk's file picker: the app's Button opens the system dialog, and
 * the chosen file's name (with a remove button) shows beside it. The
 * browser's own "Choose file" control never appears.
 */
import { useRef } from 'react';
import { Paperclip, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export function DeskFilePicker({
  id,
  file,
  accept,
  onChange,
  disabled,
}: {
  id: string;
  file: File | null;
  accept: string;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('DeskForms');
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const picked = e.target.files?.[0] ?? null;
          // Cleared so the same file can be chosen again after removing it.
          e.target.value = '';
          onChange(picked);
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip aria-hidden className="size-4" />
        {file ? t('file.change') : t('file.choose')}
      </Button>
      {file ? (
        <span className="flex min-w-0 items-center gap-1 text-sm">
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('file.remove')}
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">{t('file.none')}</span>
      )}
    </div>
  );
}
