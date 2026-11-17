'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import {
  NOTICE_TEXT_MAX,
  type NewChatNotice,
} from '@/lib/team-activity/new-chat-notice';

/**
 * The "New chat reminder" settings (migration 207). Loads and saves on
 * its own route, apart from the limits form, so it has its own button.
 */
export function NewChatNoticeSection() {
  const t = useTranslations('TeamActivity.newChatNotice');
  const numbers = useAccountNumbers();
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [channelId, setChannelId] = useState('');
  const [text, setText] = useState('');

  const apply = (n: NewChatNotice) => {
    setEnabled(n.enabled);
    setChannelId(n.channelId ?? '');
    setText(n.text ?? '');
  };

  useEffect(() => {
    let cancelled = false;
    fetch('/api/team-activity/new-chat-notice')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { notice?: NewChatNotice } | null) => {
        if (cancelled) return;
        if (body?.notice) apply(body.notice);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const companyNumbers = (numbers ?? []).filter((n) => !n.is_personal);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/team-activity/new-chat-notice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          channelId: channelId || null,
          text: text.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        notice?: unknown;
        error?: string;
      } | null;
      if (!res.ok) {
        toast.error(body?.error ?? t('settings.saveFailed'));
        return;
      }
      toast.success(t('settings.saved'));
    } catch {
      toast.error(t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-border space-y-3 rounded-lg border p-3">
      <div>
        <p className="text-foreground text-sm font-medium">
          {t('settings.title')}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {t('settings.description')}
        </p>
      </div>

      <div className="flex items-start justify-between gap-4">
        <p className="text-foreground text-sm">{t('settings.enabled')}</p>
        <Switch
          checked={enabled}
          disabled={!loaded}
          onCheckedChange={setEnabled}
          aria-label={t('settings.enabled')}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="ta-notice-number">{t('settings.number')}</Label>
        <select
          id="ta-notice-number"
          value={channelId}
          disabled={!loaded}
          onChange={(e) => setChannelId(e.target.value)}
          className="border-input bg-card dark:bg-input/30 h-8 rounded-lg border px-2 text-sm"
        >
          <option value="">{t('settings.none')}</option>
          {companyNumbers.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label || n.waba_id || n.phone_number_id}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-xs">
          {t('settings.numberHelp')}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="ta-notice-text">{t('settings.text')}</Label>
        <textarea
          id="ta-notice-text"
          value={text}
          disabled={!loaded}
          maxLength={NOTICE_TEXT_MAX}
          rows={3}
          placeholder={t('default')}
          onChange={(e) => setText(e.target.value)}
          className="border-input bg-card dark:bg-input/30 rounded-lg border px-2.5 py-1.5 text-sm"
        />
        <p className="text-muted-foreground text-xs">
          {t('settings.textHelp', { max: NOTICE_TEXT_MAX })}
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => void save()}
          disabled={saving || !loaded}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('settings.save')}
        </Button>
      </div>
    </div>
  );
}
