'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { GraduationCap } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { AiKbLearnedSkills } from '@/components/settings/ai-kb-learned-skills';
import {
  KB_LEARN_SETTINGS_OFF,
  parseKbLearnResponse,
  type KbLearnSettings,
} from '@/lib/kb/learn-settings';

/**
 * "Learn from team answers" (migration 290), beside the knowledge-gap
 * topics: once a week, draft an approved-answer entry from how people on
 * the team answered an open gap. Drafts only; an admin approves them.
 * Admin-only, like the gaps card: for anyone else it is not rendered.
 */
export function AiKbLearnSwitch({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('KbLearn');
  const format = useFormatter();
  const [settings, setSettings] = useState<KbLearnSettings>(
    KB_LEARN_SETTINGS_OFF
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/kb/learn', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok && data && typeof data === 'object') {
        setSettings(parseKbLearnResponse(data));
      } else toast.error(data?.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!canEdit || !accountId || loadedAccountIdRef.current === accountId)
      return;
    loadedAccountIdRef.current = accountId;
    void load();
  }, [accountId, canEdit, load]);

  const save = async (enabled: boolean) => {
    setSaving(true);
    const before = settings;
    setSettings({ ...settings, enabled });
    try {
      const res = await fetch('/api/ai/kb/learn', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setSettings(before);
        toast.error(data?.error ?? t('saveFailed'));
        return;
      }
      setSettings(parseKbLearnResponse(data));
      toast.success(enabled ? t('switchedOn') : t('switchedOff'));
    } catch {
      setSettings(before);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit) return null;

  return (
    <div className="space-y-2">
      <div className="border-border bg-card flex items-start justify-between gap-4 rounded-md border p-3">
        <div className="flex min-w-0 gap-2">
          <GraduationCap
            className="text-primary mt-0.5 h-4 w-4 shrink-0"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">{t('title')}</p>
            <p className="text-muted-foreground text-xs">{t('description')}</p>
            {!settings.available ? (
              <p className="text-warning mt-1 text-xs">{t('notApplied')}</p>
            ) : settings.enabled ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {settings.lastRunAt
                  ? settings.lastRunDrafted === null
                    ? t('lastRun', {
                        when: format.dateTime(new Date(settings.lastRunAt), {
                          dateStyle: 'medium',
                        }),
                      })
                    : t('lastRunDrafts', {
                        when: format.dateTime(new Date(settings.lastRunAt), {
                          dateStyle: 'medium',
                        }),
                        count: settings.lastRunDrafted,
                      })
                  : t('notRunYet')}
              </p>
            ) : null}
          </div>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(v) => void save(v)}
          disabled={loading || saving || !settings.available}
          aria-label={t('title')}
        />
      </div>
      {settings.available ? <AiKbLearnedSkills accountId={accountId} /> : null}
    </div>
  );
}
