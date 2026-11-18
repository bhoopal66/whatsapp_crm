'use client';

// ============================================================
// Taamul Compass → Settings (migration 209): the Meta template a
// status update goes as when the customer's 24-hour window is closed.
//
// Owners and admins write `compass_settings` directly; RLS is the
// guard. Only templates the send path would accept are offered
// (`compassTemplateProblem`), and the send path checks again at send
// time, so a template edited or paused later is caught there.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { compassTemplateProblem } from '@/lib/compass/meta-template';
import type { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';

type TemplateRow = Pick<
  MessageTemplate,
  | 'id'
  | 'name'
  | 'language'
  | 'status'
  | 'category'
  | 'body_text'
  | 'header_type'
  | 'header_content'
  | 'buttons'
>;

/** `name|language`, the select's value for one template. */
const keyOf = (name: string, language: string | null | undefined) =>
  `${name}|${language ?? ''}`;

export function CompassSettings({ accountId }: { accountId: string }) {
  const t = useTranslations('Compass.settings');
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [choice, setChoice] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createClient();
      const [settings, rows] = await Promise.all([
        supabase
          .from('compass_settings')
          .select('meta_template_name, meta_template_language')
          .eq('account_id', accountId)
          .maybeSingle(),
        supabase
          .from('message_templates')
          .select(
            'id, name, language, status, category, body_text, header_type, header_content, buttons'
          )
          .eq('account_id', accountId)
          .order('name', { ascending: true }),
      ]);
      if (cancelled) return;
      if (settings.error || rows.error) {
        setError(t('loadFailed'));
        setTemplates([]);
        return;
      }
      setError(null);
      const name = settings.data?.meta_template_name as string | null;
      const current = name
        ? keyOf(name, settings.data?.meta_template_language as string | null)
        : '';
      setSaved(current);
      setChoice(current);
      setTemplates((rows.data ?? []) as TemplateRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, t]);

  const usable = useMemo(
    () => (templates ?? []).filter((r) => compassTemplateProblem(r) === null),
    [templates]
  );
  const savedRow = (templates ?? []).find(
    (r) => keyOf(r.name, r.language) === saved
  );
  const savedUsable = usable.some((r) => keyOf(r.name, r.language) === saved);
  const preview = usable.find((r) => keyOf(r.name, r.language) === choice);

  const save = async () => {
    setSaving(true);
    const [name, language] = choice ? choice.split('|') : [null, null];
    const { error: err } = await createClient()
      .from('compass_settings')
      .upsert(
        {
          account_id: accountId,
          meta_template_name: name,
          meta_template_language: name ? language || null : null,
        },
        { onConflict: 'account_id' }
      );
    setSaving(false);
    if (err) {
      toast.error(t('saveFailed'));
      return;
    }
    setSaved(choice);
    toast.success(t('saved'));
  };

  if (templates === null) {
    return (
      <Loader2 className="text-muted-foreground mx-auto h-6 w-6 animate-spin" />
    );
  }

  return (
    <div className="border-border bg-card max-w-2xl space-y-4 rounded-xl border p-5">
      <div className="space-y-1">
        <h2 className="text-foreground text-base font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('explain')}</p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {saved && !savedUsable && (
        <p className="border-warning/40 bg-warning-soft text-warning rounded-lg border px-3 py-2 text-sm">
          {savedRow
            ? t('savedUnusable', { name: savedRow.name })
            : t('savedMissing', { name: saved.split('|')[0] })}
        </p>
      )}
      {!saved && (
        <p className="border-warning/40 bg-warning-soft text-warning rounded-lg border px-3 py-2 text-sm">
          {t('noneChosen')}
        </p>
      )}

      <div className="space-y-2">
        <label
          htmlFor="compass-template"
          className="text-foreground text-sm font-medium"
        >
          {t('templateLabel')}
        </label>
        <select
          id="compass-template"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="border-input bg-card dark:bg-input/30 h-9 w-full rounded-md border px-3 text-sm"
        >
          <option value="">{t('none')}</option>
          {usable.map((r) => (
            <option key={r.id} value={keyOf(r.name, r.language)}>
              {r.name}
              {r.language ? ` (${r.language})` : ''}
            </option>
          ))}
        </select>
        {usable.length === 0 && (
          <p className="text-muted-foreground text-xs">{t('noUsable')}</p>
        )}
        <p className="text-muted-foreground text-xs">{t('requirements')}</p>
      </div>

      {preview && (
        <div className="bg-card-2 rounded-lg p-3 text-sm whitespace-pre-wrap">
          {preview.body_text}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving || choice === saved}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
