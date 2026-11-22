import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Two-sentence explainer shown on both the Flows and Automations lists. */
export function FlowVsAutomationHelp() {
  const t = useTranslations('States');
  return (
    <div className="border-border bg-card-2 text-muted-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="text-foreground font-medium">
          {t('flowVsAutomationTitle')}
        </span>{' '}
        {t('flowVsAutomationBody')}
      </p>
    </div>
  );
}
