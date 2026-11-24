'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { GraduationCap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  KB_LEARN_SWITCH_LOADING,
  kbLearnSwitchReduce,
  kbLearnSwitchView,
  type KbLearnLine,
  type KbLearnSwitchEvent,
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
  const ts = useTranslations('States');
  const format = useFormatter();
  const [state, setState] = useState(KB_LEARN_SWITCH_LOADING);
  // When the setting was last read: what "is running" is judged against.
  const [readAt, setReadAt] = useState(0);
  const dispatch = useCallback((event: KbLearnSwitchEvent) => {
    if (event.type !== 'load') setReadAt(Date.now());
    setState((s) => kbLearnSwitchReduce(s, event));
  }, []);
  const loadedAccountIdRef = useRef<string | null>(null);

  const load = useCallback(
    () =>
      fetch('/api/ai/kb/learn', { cache: 'no-store' })
        .then(async (res) => ({
          ok: res.ok,
          json: (await res.json().catch(() => null)) as unknown,
        }))
        .catch(() => ({ ok: false, json: null }))
        .then((answer) => dispatch({ type: 'loaded', ...answer })),
    [dispatch]
  );

  useEffect(() => {
    if (!canEdit || !accountId || loadedAccountIdRef.current === accountId)
      return;
    loadedAccountIdRef.current = accountId;
    void load();
  }, [accountId, canEdit, load]);

  const view = kbLearnSwitchView(state, readAt);

  const save = async (enabled: boolean) => {
    if (view.kind !== 'switch' || view.disabled) return;
    dispatch({ type: 'save', enabled });
    try {
      const res = await fetch('/api/ai/kb/learn', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const json: unknown = await res.json().catch(() => null);
      dispatch({ type: 'saved', ok: res.ok, json });
      if (res.ok) toast.success(enabled ? t('switchedOn') : t('switchedOff'));
      else toast.error(t('saveFailed'));
    } catch {
      dispatch({ type: 'saved', ok: false, json: null });
      toast.error(t('saveFailed'));
    }
  };

  if (!canEdit) return null;

  const lineText = (line: KbLearnLine) => {
    if ('at' in line) {
      const when = format.dateTime(new Date(line.at), { dateStyle: 'medium' });
      return line.key === 'lastRun'
        ? t('lastRun', { when })
        : t('lastRunDrafts', { when, count: line.count });
    }
    if (!('retryAt' in line)) return t(line.key);
    const again = line.retryAt
      ? t('triesAgain', {
          when: format.dateTime(new Date(line.retryAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        })
      : t('triesSoon');
    return `${t(line.key)} ${again}`;
  };

  return (
    <div className="border-border bg-card flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="flex min-w-0 gap-2">
        <GraduationCap
          className="text-primary mt-0.5 h-4 w-4 shrink-0"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">{t('title')}</p>
          <p className="text-muted-foreground text-xs">{t('description')}</p>
          {view.kind === 'failed' ? (
            <p role="alert" className="text-destructive mt-1 text-xs">
              {t('loadFailed')}
            </p>
          ) : view.kind === 'switch' && view.line ? (
            <p
              className={
                view.line.key === 'notApplied' || 'retryAt' in view.line
                  ? 'text-warning mt-1 text-xs'
                  : 'text-muted-foreground mt-1 text-xs'
              }
            >
              {lineText(view.line)}
            </p>
          ) : null}
        </div>
      </div>
      {view.kind === 'failed' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            dispatch({ type: 'load' });
            void load();
          }}
        >
          {ts('retry')}
        </Button>
      ) : (
        <Switch
          checked={view.kind === 'switch' && view.checked}
          onCheckedChange={(v) => void save(v)}
          disabled={view.kind !== 'switch' || view.disabled}
          aria-label={t('title')}
        />
      )}
    </div>
  );
}
