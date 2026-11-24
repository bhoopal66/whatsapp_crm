'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

/**
 * A create nobody can vouch for: `unconfirmed` (the answer was lost, the
 * group may exist) or `repeat` (the same name a few minutes ago). Only
 * `repeat` offers another group; the wizard's entries are kept either way.
 */
export function CreateOutcomePanel({
  kind,
  onBack,
  onCheck,
  onCreateAnother,
}: {
  kind: 'unconfirmed' | 'repeat';
  onBack: () => void;
  onCheck: () => void;
  onCreateAnother: () => void;
}) {
  const t = useTranslations('Groups.create');
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div
        className="border-warning/30 bg-warning-soft text-foreground space-y-2 rounded-lg border p-3 text-sm"
        role="alert"
      >
        <p className="font-semibold">{t(`${kind}Headline`)}</p>
        <p>{t(`${kind}Body`)}</p>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onBack}>
          {t('back')}
        </Button>
        {kind === 'repeat' && (
          <Button type="button" variant="outline" onClick={onCreateAnother}>
            {t('createAnother')}
          </Button>
        )}
        <Button type="button" onClick={onCheck}>
          {t('checkGroups')}
        </Button>
      </div>
    </div>
  );
}
