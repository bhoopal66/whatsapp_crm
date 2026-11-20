'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  automsgSaveTemplate,
  type AutoMsgTemplateView,
} from '@/lib/hr/automsg/api';
import {
  AUTOMSG_CHANNELS,
  CHANNEL_LABEL_KEYS,
  type AutomsgChannel,
} from '@/lib/hr/automsg/channel';
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
 * The template editors of the HR Automated messages screen: a WhatsApp /
 * RCS tab switch, then one card per kind x language of that channel.
 * Each card is keyed by its stored row (`slot.key`), so a save
 * re-initialises it from the reloaded config while typing never does.
 * Admins edit on both channels; leads read. The database re-checks every
 * save.
 */
export function AutomsgTemplates({
  templates,
  role,
  onSaved,
  rcsConnected = false,
}: {
  templates: readonly AutoMsgTemplateView[];
  role: AutomsgRole;
  onSaved: () => Promise<void> | void;
  /** An RCS provider is connected; until then the RCS tab says so. */
  rcsConnected?: boolean;
}) {
  const t = useTranslations('Hr.automsg');
  const [channel, setChannel] = useState<AutomsgChannel>('whatsapp');
  return (
    <section className="border-border bg-card space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t('templates.title')}</h2>
        <Tabs
          value={channel}
          onValueChange={(v) => setChannel(v as AutomsgChannel)}
        >
          <TabsList aria-label={t('templates.channelTabs')}>
            {AUTOMSG_CHANNELS.map((c) => (
              <TabsTrigger key={c} value={c}>
                {t(CHANNEL_LABEL_KEYS[c])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {/* Both panels stay mounted: unmounting one would drop its unsaved
          edits on a tab switch. The `rcs|` slot keys keep them apart. */}
      {AUTOMSG_CHANNELS.map((c) => (
        <div key={c} hidden={c !== channel}>
          <TemplatesPanel
            channel={c}
            templates={templates}
            role={role}
            onSaved={onSaved}
            rcsConnected={rcsConnected}
          />
        </div>
      ))}
    </section>
  );
}

/** One channel's notes and editors. */
export function TemplatesPanel({
  channel,
  templates,
  role,
  onSaved,
  rcsConnected = false,
}: {
  channel: AutomsgChannel;
  templates: readonly AutoMsgTemplateView[];
  role: AutomsgRole;
  onSaved: () => Promise<void> | void;
  rcsConnected?: boolean;
}) {
  const t = useTranslations('Hr.automsg.templates');
  const rcs = channel === 'rcs';
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {role !== 'admin' && (
          <p className="text-muted-foreground text-xs">
            {rcs ? t('rcsReadOnly') : t('leadNote')}
          </p>
        )}
        {rcs ? (
          !rcsConnected && (
            <p className="text-muted-foreground text-xs">
              {t('rcsNotConnected')}
            </p>
          )
        ) : (
          <p className="text-muted-foreground text-xs">{t.raw('metaNote')}</p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {editorSlots(templates, channel).map((slot) => (
          <TemplateCard
            key={slot.key}
            slot={slot}
            role={role}
            onSaved={onSaved}
          />
        ))}
      </div>
    </div>
  );
}

export function TemplateCard({
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
  const rcs = slot.channel === 'rcs';
  const view = editorView(slot.kind, form, role, saving, slot.channel);
  const id = rcs
    ? `automsg-rcs-${slot.kind}-${slot.language}`
    : `automsg-${slot.kind}-${slot.language}`;
  const language = t(`templates.languages.${slot.language}`);

  const save = async () => {
    setSaving(true);
    try {
      const res = await automsgSaveTemplate(
        createClient(),
        editorPayload(slot.kind, slot.language, form, slot.channel)
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
    <fieldset className="border-border bg-card-2 min-w-0 space-y-2 rounded-lg border px-3 pt-1 pb-3">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
        <span>
          {t('templates.cardTitle', {
            kind: t(`templateKinds.${slot.kind}`),
            language,
          })}
        </span>
        <span className="border-border text-muted-foreground rounded-full border px-1.5 text-[10px] leading-4 font-medium">
          {t(CHANNEL_LABEL_KEYS[slot.channel])}
        </span>
      </legend>
      {!slot.stored && (
        <p className="text-muted-foreground text-xs">
          {rcs ? t('templates.rcsSeedNote') : t('templates.seedNote')}
        </p>
      )}

      <div className="space-y-1">
        <label htmlFor={`${id}-body`} className="text-sm">
          {t('templates.body')}
        </label>
        <Textarea
          id={`${id}-body`}
          dir={slot.language === 'ar' ? 'rtl' : 'ltr'}
          rows={4}
          value={form.body}
          readOnly={view.readOnly}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          className="min-h-24"
        />
        <p className="text-muted-foreground text-xs tabular-nums">
          {t('templates.counter', view.counter)}
        </p>
        {view.messages.length > 0 && (
          <ul className="space-y-0.5" aria-live="polite">
            {view.messages.map((m, i) => (
              <li key={`${m.key}-${i}`} className="text-destructive text-xs">
                {'values' in m
                  ? t(`templates.check.${m.key}`, m.values)
                  : t(`templates.check.${m.key}`)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label
          htmlFor={`${id}-name`}
          className="shrink-0 text-sm whitespace-nowrap"
        >
          {rcs ? t('templates.rcsId', { language }) : t('templates.metaName')}
        </label>
        <Input
          id={`${id}-name`}
          dir="ltr"
          className="min-w-0 flex-1"
          value={form.metaTemplateName}
          readOnly={view.readOnly}
          onChange={(e) =>
            setForm({ ...form, metaTemplateName: e.target.value })
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-approval`} className="text-sm">
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
          className="border-input bg-card dark:bg-input/30 h-8 rounded-md border px-2 text-sm disabled:opacity-60"
        >
          {APPROVAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`templates.approvalStatus.${s}`)}
            </option>
          ))}
        </select>
        {!view.readOnly && (
          <Button
            size="sm"
            disabled={!view.canSave}
            onClick={() => void save()}
          >
            {rcs ? t('templates.saveRcs', { language }) : t('templates.save')}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
