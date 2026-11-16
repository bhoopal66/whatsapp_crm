'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  automsgSaveTemplate,
  type AutoMsgTemplateView,
} from '@/lib/hr/automsg/api';
import {
  editorPayload,
  editorSlots,
  editorView,
  type EditorForm,
  type EditorSlot,
} from '@/lib/hr/automsg/editor-view';
import { APPROVAL_STATUSES, type ApprovalStatus } from '@/lib/hr/automsg/types';
import { automsgErrorKey, type AutomsgRole } from '@/lib/hr/automsg/view';
import { createClient } from '@/lib/supabase/client';

/**
 * The template editors of the HR Automated messages screen: one card per
 * kind x language. Each card is keyed by its stored row (`slot.key`), so
 * a save re-initialises it from the reloaded config while typing never
 * does. Admins edit; leads read. The database re-checks every save.
 */
export function AutomsgTemplates({
  templates,
  role,
  onSaved,
}: {
  templates: readonly AutoMsgTemplateView[];
  role: AutomsgRole;
  onSaved: () => Promise<void> | void;
}) {
  const t = useTranslations('Hr.automsg.templates');
  return (
    <section className="border-border bg-card space-y-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="font-medium">{t('title')}</h2>
        {role !== 'admin' && (
          <p className="text-muted-foreground text-xs">{t('leadNote')}</p>
        )}
        <p className="text-muted-foreground text-xs">{t.raw('metaNote')}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {editorSlots(templates).map((slot) => (
          <TemplateCard
            key={slot.key}
            slot={slot}
            role={role}
            onSaved={onSaved}
          />
        ))}
      </div>
    </section>
  );
}

function TemplateCard({
  slot,
  role,
  onSaved,
}: {
  slot: EditorSlot;
  role: AutomsgRole;
  onSaved: () => Promise<void> | void;
}) {
  const t = useTranslations('Hr.automsg');
  const [form, setForm] = useState<EditorForm>(slot.initial);
  const [saving, setSaving] = useState(false);
  const view = editorView(slot.kind, form, role, saving);
  const id = `automsg-${slot.kind}-${slot.language}`;

  const save = async () => {
    setSaving(true);
    try {
      const res = await automsgSaveTemplate(
        createClient(),
        editorPayload(slot.kind, slot.language, form)
      );
      if ('error' in res) {
        toast.error(t(`error.${automsgErrorKey(res.error)}`));
        return;
      }
      toast.success(t('templates.saved'));
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-border bg-card-2 space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {t('templates.cardTitle', {
            kind: t(`templateKinds.${slot.kind}`),
            language: t(`templates.languages.${slot.language}`),
          })}
        </h3>
        <span className="bg-info-soft text-info rounded-full px-2 py-0.5 text-xs">
          {t('templates.utility')}
        </span>
      </div>
      {!slot.stored && (
        <p className="text-muted-foreground text-xs">
          {t('templates.seedNote')}
        </p>
      )}

      <div className="space-y-1">
        <label htmlFor={`${id}-body`} className="text-sm font-medium">
          {t('templates.body')}
        </label>
        <Textarea
          id={`${id}-body`}
          dir={slot.language === 'ar' ? 'rtl' : 'ltr'}
          rows={5}
          value={form.body}
          readOnly={view.readOnly}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          className="min-h-28"
        />
        <div className="flex flex-wrap items-start gap-2">
          <ul className="min-w-0 flex-1 space-y-0.5" aria-live="polite">
            {view.messages.map((m, i) => (
              <li key={`${m.key}-${i}`} className="text-destructive text-xs">
                {'values' in m
                  ? t(`templates.check.${m.key}`, m.values)
                  : t(`templates.check.${m.key}`)}
              </li>
            ))}
          </ul>
          <span className="text-muted-foreground text-xs tabular-nums">
            {view.counter}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            {t('templates.metaName')}
          </label>
          <Input
            id={`${id}-name`}
            dir="ltr"
            value={form.metaTemplateName}
            readOnly={view.readOnly}
            onChange={(e) =>
              setForm({ ...form, metaTemplateName: e.target.value })
            }
          />
          <p className="text-muted-foreground text-xs">
            {t('templates.metaNameHelp')}
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-approval`} className="text-sm font-medium">
            {t('templates.approval')}
          </label>
          <select
            id={`${id}-approval`}
            value={form.approvalStatus}
            disabled={view.readOnly}
            onChange={(e) =>
              setForm({
                ...form,
                approvalStatus: e.target.value as ApprovalStatus,
              })
            }
            className="border-input bg-card dark:bg-input/30 h-8 w-full rounded-md border px-2 text-sm disabled:opacity-60"
          >
            {APPROVAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`templates.approvalStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!view.readOnly && (
        <div>
          <Button
            size="sm"
            disabled={!view.canSave}
            onClick={() => void save()}
          >
            {t('templates.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
