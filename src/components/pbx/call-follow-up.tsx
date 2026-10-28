'use client';

// The in-call window's follow-up reminder: one tap files a callback
// task for the caller (POST /api/tasks, assigned to them by default),
// with an Undo that cancels it. Agent and up only, as the route is.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { canSendMessages } from '@/lib/auth/roles';
import {
  FOLLOW_UP_PRESETS,
  followUpDueAt,
  followUpTitleKey,
  parseCustomDueAt,
  toDateTimeLocal,
} from '@/lib/pbx/follow-up';
import { TASK_TITLE_MAX } from '@/lib/tasks/types';

const chipButton =
  'border-border bg-card hover:bg-muted rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50';

export function FollowUpReminder({
  contactId,
  conversationId,
  customerName,
}: {
  contactId: string | null;
  conversationId?: string | null;
  customerName?: string | null;
}) {
  const t = useTranslations('CallContext.followUp');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const titleKey = followUpTitleKey(customerName);
  const defaultTitle =
    titleKey.key === 'titleNamed'
      ? t('titleNamed', titleKey.values)
      : t('titleBare');
  // null = the default title, until the agent types.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState('');
  const [pickError, setPickError] = useState<'pickInvalid' | 'pickPast' | null>(
    null
  );
  const [saved, setSaved] = useState<{ id: string; when: string } | null>(null);

  if (!contactId || !accountRole || !canSendMessages(accountRole)) return null;

  const title = (typed ?? defaultTitle).trim();

  const create = async (due: Date) => {
    if (!title || saving) return;
    setSaving(true);
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        kind: 'callback',
        contactId,
        ...(conversationId ? { conversationId } : {}),
        dueAt: due.toISOString(),
      }),
    }).catch(() => null);
    const body = res?.ok
      ? ((await res.json().catch(() => null)) as {
          task?: { id?: string };
        } | null)
      : null;
    setSaving(false);
    const id = body?.task?.id;
    if (!id) return void toast.error(t('failed'));
    setPicking(false);
    setSaved({
      id,
      when: due.toLocaleString(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  };

  const undo = async () => {
    if (!saved) return;
    setSaving(true);
    const res = await fetch(`/api/tasks/${saved.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) return void toast.error(t('undoFailed'));
    setSaved(null);
    toast.success(t('undone'));
  };

  const setCustomTime = () => {
    const r = parseCustomDueAt(custom, new Date());
    if (!r.ok)
      return setPickError(r.reason === 'past' ? 'pickPast' : 'pickInvalid');
    setPickError(null);
    void create(r.at);
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      {saved ? (
        <div className="bg-success-soft text-success flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm">
          <span>{t('saved', { when: saved.when })}</span>
          <button
            type="button"
            className="font-medium underline disabled:opacity-50"
            disabled={saving}
            onClick={() => void undo()}
          >
            {t('undo')}
          </button>
        </div>
      ) : (
        <>
          <input
            type="text"
            value={typed ?? defaultTitle}
            maxLength={TASK_TITLE_MAX}
            onChange={(e) => setTyped(e.target.value)}
            aria-label={t('titleLabel')}
            className="border-input bg-card dark:bg-input/30 w-full rounded-md border px-2.5 py-1.5 text-sm"
          />
          <div className="flex flex-wrap gap-1.5">
            {FOLLOW_UP_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={chipButton}
                disabled={saving || !title}
                onClick={() => void create(followUpDueAt(p, new Date()))}
              >
                {t(p)}
              </button>
            ))}
            <button
              type="button"
              className={chipButton}
              disabled={saving}
              aria-expanded={picking}
              onClick={() => {
                setPicking((v) => !v);
                if (!custom)
                  setCustom(toDateTimeLocal(followUpDueAt('in1h', new Date())));
              }}
            >
              {t('pick')}
            </button>
          </div>
          {picking && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <input
                  type="datetime-local"
                  value={custom}
                  onChange={(e) => {
                    setCustom(e.target.value);
                    setPickError(null);
                  }}
                  aria-label={t('pickLabel')}
                  className="border-input bg-card dark:bg-input/30 min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  className={chipButton}
                  disabled={saving || !title}
                  onClick={setCustomTime}
                >
                  {t('set')}
                </button>
              </div>
              {pickError && (
                <p className="text-destructive text-xs">{t(pickError)}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
