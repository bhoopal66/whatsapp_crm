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
  followSlot,
  SMS_NAME_ALLOWANCE,
  storedMoved,
  type EditorForm,
  type EditorSlot,
  type EditorState,
} from '@/lib/hr/automsg/editor-view';
import { MAX_SMS_SEGMENTS } from '@/lib/hr/automsg/sms-text';
import { APPROVAL_STATUSES, type ApprovalStatus } from '@/lib/hr/automsg/types';
import { automsgErrorKey, type AutomsgRole } from '@/lib/hr/automsg/view';
import { createClient } from '@/lib/supabase/client';

/**
 * The template editors of the HR Automated messages screen: a WhatsApp /
 * RCS / SMS tab switch, then one card per kind x language of that channel.
 * An untouched card shows what is stored now; a touched one keeps its text,
 * and is saved only over the row it was filled from (317). Admins edit on
 * every channel; leads read. The database re-checks every save.
 */
export function AutomsgTemplates({
  templates,
  role,
  onSaved,
  rcsConnected = false,
  smsConnected = false,
}: {
  templates: readonly AutoMsgTemplateView[];
  role: AutomsgRole;
  onSaved: () => Promise<void> | void;
  /** An RCS provider is connected; until then the RCS tab says so. */
  rcsConnected?: boolean;
  /** The SMS gateway is connected; until then the SMS tab says so. */
  smsConnected?: boolean;
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
          edits on a tab switch. The `rcs|` / `sms|` slot keys keep them
          apart. */}
      {AUTOMSG_CHANNELS.map((c) => (
        <div key={c} hidden={c !== channel}>
          <TemplatesPanel
            channel={c}
            templates={templates}
            role={role}
            onSaved={onSaved}
            rcsConnected={rcsConnected}
            smsConnected={smsConnected}
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
  smsConnected = false,
}: {
  channel: AutomsgChannel;
  templates: readonly AutoMsgTemplateView[];
  role: AutomsgRole;
  onSaved: () => Promise<void> | void;
  rcsConnected?: boolean;
  smsConnected?: boolean;
}) {
  const t = useTranslations('Hr.automsg.templates');
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {role !== 'admin' && (
          <p className="text-muted-foreground text-xs">
            {channel === 'rcs'
              ? t('rcsReadOnly')
              : channel === 'sms'
                ? t('smsReadOnly')
                : t('leadNote')}
          </p>
        )}
        {channel === 'rcs' ? (
          !rcsConnected && (
            <p className="text-muted-foreground text-xs">
              {t('rcsNotConnected')}
            </p>
          )
        ) : channel === 'sms' ? (
          !smsConnected && (
            <p className="text-muted-foreground text-xs">
              {t('smsNotConnected')}
            </p>
          )
        ) : (
          <p className="text-muted-foreground text-xs">{t.raw('metaNote')}</p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {editorSlots(templates, channel).map((slot) => (
          <TemplateCard
            key={`${slot.channel}|${slot.kind}|${slot.language}`}
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
  const [editor, setEditor] = useState<EditorState>({
    base: slot,
    form: slot.initial,
  });
  const [refused, setRefused] = useState(false);
  const [saving, setSaving] = useState(false);
  const { base, form } = followSlot(editor, slot);
  const setForm = (next: EditorForm) => setEditor({ base, form: next });
  const changed = refused || storedMoved(base, slot);
  const rcs = slot.channel === 'rcs';
  const sms = slot.channel === 'sms';
  const view = editorView(slot.kind, form, role, saving, slot.channel);
  const id =
    slot.channel === 'whatsapp'
      ? `automsg-${slot.kind}-${slot.language}`
      : `automsg-${slot.channel}-${slot.kind}-${slot.language}`;
  const language = t(`templates.languages.${slot.language}`);

  const save = async () => {
    setSaving(true);
    setEditor({ base, form });
    try {
      const res = await automsgSaveTemplate(createClient(), {
        ...editorPayload(slot.kind, slot.language, form, slot.channel),
        expectedUpdatedAt: base.stored?.updatedAt ?? null,
      });
      if ('error' in res) {
        if (res.error === 'STALE') setRefused(true);
        toast.error(t(`error.${automsgErrorKey(res.error)}`));
        return;
      }
      toast.success(t('templates.saved'));
      // The row just stored is this editor's own; typing meanwhile stays.
      const saved = editorSlots(res.data.templates, slot.channel).find(
        (s) => s.kind === slot.kind && s.language === slot.language
      );
      if (saved)
        setEditor((cur) => ({
          base: saved,
          form: cur.form === form ? saved.initial : cur.form,
        }));
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  const reload = () => {
    setRefused(false);
    setEditor({ base: slot, form: slot.initial });
    void onSaved();
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
        <span className="border-border text-muted-foreground rounded-full border px-1.5 text-xs leading-4 font-medium">
          {t(CHANNEL_LABEL_KEYS[slot.channel])}
        </span>
      </legend>
      {!slot.stored && (
        <p className="text-muted-foreground text-xs">
          {rcs
            ? t('templates.rcsSeedNote')
            : sms
              ? t('templates.smsSeedNote')
              : t('templates.seedNote')}
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
        {view.sms && (
          <div className="space-y-0.5" aria-live="polite">
            <p className="text-muted-foreground text-xs tabular-nums">
              {t('templates.smsCounter', {
                length: view.sms.length,
                segments: view.sms.segments,
                encoding: t(
                  view.sms.encoding === 'gsm-7bit'
                    ? 'templates.smsEncoding.gsm'
                    : 'templates.smsEncoding.unicode'
                ),
              })}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('templates.smsCounterHint', { allowance: SMS_NAME_ALLOWANCE })}
            </p>
            {!view.sms.fits && (
              <p className="bg-warning-soft text-warning rounded px-1.5 py-0.5 text-xs">
                {t('templates.smsTooLong', { max: MAX_SMS_SEGMENTS })}
              </p>
            )}
          </div>
        )}
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
          {rcs
            ? t('templates.rcsId', { language })
            : sms
              ? t('templates.smsLabel', { language })
              : t('templates.metaName')}
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

      {changed && (
        <div
          role="alert"
          className="bg-warning-soft text-warning flex flex-wrap items-center justify-between gap-2 rounded px-2 py-1 text-xs"
        >
          <span>{t('templates.changed')}</span>
          <Button size="sm" variant="outline" onClick={reload}>
            {t('templates.reload')}
          </Button>
        </div>
      )}

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
            disabled={!view.canSave || changed}
            onClick={() => void save()}
          >
            {rcs
              ? t('templates.saveRcs', { language })
              : sms
                ? t('templates.saveSms', { language })
                : t('templates.save')}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
