'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Loader2, FileText, ArrowRight, Plus } from 'lucide-react';
import { SENDABLE_TEMPLATE_STATUS } from '@/lib/broadcasts/draft-state';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import {
  broadcastTemplateSendsFrom,
  offerTemplates,
} from '@/lib/whatsapp/template-offer';
import { templatesSettingsHref } from '@/lib/broadcasts/return-path';
import { useTranslations } from 'next-intl';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const tPicker = useTranslations('Inbox.templatePicker');
  const numbers = useAccountNumbers();
  // Undefined until it is read, or when it could not be.
  const [routedId, setRoutedId] = useState<string | null | undefined>();
  const offer = useMemo(
    () =>
      offerTemplates(templates, broadcastTemplateSendsFrom(numbers, routedId)),
    [templates, numbers, routedId]
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time. Hide them rather than letting
        // the user pick a template that will fail. One Meta refused when
        // it was submitted is APPROVED too: `offerTemplates` blocks it
        // when campaigns go out on the Meta number.
        const [{ data, error: fetchError }, route] = await Promise.all([
          supabase
            .from('message_templates')
            .select('*')
            .eq('status', SENDABLE_TEMPLATE_STATUS)
            .order('created_at', { ascending: false }),
          supabase
            .from('whatsapp_routes')
            .select('config_id')
            .eq('surface', 'broadcast')
            .maybeSingle(),
        ]);
        if (!route.error) setRoutedId(route.data?.config_id ?? null);

        if (fetchError) throw fetchError;
        setTemplates(data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('chooseTemplate.errorLoad'));
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('chooseTemplate.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('chooseTemplate.subtitle')}
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('chooseTemplate.noTemplates')}</p>
          <p className="mt-1 px-4 text-center text-sm text-muted-foreground">
            {t('chooseTemplate.createFirst')}
          </p>
          <Button
            className="mt-3"
            nativeButton={false}
            render={<Link href={templatesSettingsHref()} />}
          >
            <Plus className="h-4 w-4" />
            {t('chooseTemplate.createTemplate')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {offer.offered.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-start transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-sm font-medium text-foreground">{template.name}</h3>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{template.body_text}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{template.language ?? 'en_US'}</span>
                  {/* Status is omitted on purpose — every template
                      shown here is already filtered to APPROVED,
                      so the chip carried no information. */}
                </div>
              </button>
            );
          })}
          {offer.blocked.map(({ template, reason }) => (
            <div
              key={template.id}
              aria-disabled="true"
              className="border-border bg-card/50 flex flex-col gap-3 rounded-xl border p-4"
            >
              <h3 className="text-muted-foreground text-sm font-medium">
                {template.name}
              </h3>
              <p className="text-muted-foreground line-clamp-3 text-xs">
                {template.body_text}
              </p>
              <p className="text-warning text-xs">
                {tPicker(`blocked.${reason}`)}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={
            !selectedTemplate ||
            offer.blocked.some((b) => b.template.id === selectedTemplate.id)
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4 rtl:rotate-180" />
        </Button>
      </div>
    </div>
  );
}
