'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

/** Somebody else saved the list on screen; what was typed stays until Reload. */
export function ChangedNotice({
  text,
  busy,
  onReload,
  label,
}: {
  text: string;
  busy: boolean;
  onReload: () => Promise<void> | void;
  /** The button's text when it is not "Reload". */
  label?: string;
}) {
  const t = useTranslations('CaseSettings');
  return (
    <div
      role="alert"
      className="border-warning/30 bg-warning-soft text-warning flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <p>{text}</p>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void onReload()}
      >
        {label ?? t('reload')}
      </Button>
    </div>
  );
}
