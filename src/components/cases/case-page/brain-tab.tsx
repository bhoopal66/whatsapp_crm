'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import {
  brainPageState,
  builtAgo,
  parseRebuildResult,
  shortCitationId,
  type BrainPageState,
} from '@/lib/brain/page-view';
import type { CaseTabProps } from '@/lib/cases/case-page';

import { TabStatus } from './tab-kit';

/**
 * The case's Brain tab (022e): the AI-generated summary page with its
 * version, build time and sources. A 404 is the normal "no summary yet";
 * every source belongs to this case, so none links anywhere. Rebuild
 * changes data, so it is the owner's / admin's, as the rebuild route
 * rules.
 */
export function BrainTab({ caseId }: CaseTabProps) {
  const t = useTranslations('CasePage.brain');
  const tp = useTranslations('CasePage');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const canRebuild = !!accountRole && hasMinRole(accountRole, 'admin');
  const [state, setState] = useState<BrainPageState | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/brain/pages/case/${caseId}`, {
        cache: 'no-store',
      });
      const json: unknown = await res.json().catch(() => null);
      if (mounted.current) setState(brainPageState(res.status, json));
    } catch {
      if (mounted.current) setState({ kind: 'error' });
    }
  }, [caseId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const rebuild = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/brain/pages/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const r = res.ok ? parseRebuildResult(await res.json()) : null;
      if (!r) throw new Error(String(res.status));
      toast.success(t('rebuilt', { count: r.rebuilt, remaining: r.remaining }));
      await load();
    } catch {
      toast.error(t('rebuildFailed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!state || state.kind === 'error')
    return (
      <TabStatus
        failed={state?.kind === 'error'}
        loading={tp('tabLoading')}
        error={t('loadFailed')}
        onRetry={() => void load()}
      />
    );

  if (state.kind === 'off')
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {t('off')}
      </p>
    );

  const when = (iso: string | null): string => {
    const ago = builtAgo(iso, Date.now());
    if (!ago) return t('unknownTime');
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    return ago.unit === 'now'
      ? rtf.format(0, 'second')
      : rtf.format(-ago.value, ago.unit);
  };

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        {canRebuild && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void rebuild()}
          >
            {t('rebuild')}
          </Button>
        )}
      </div>

      {state.kind === 'none' ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t('none')}
        </p>
      ) : (
        <article className="bg-card flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">
              <Sparkles aria-hidden />
              {t('ai')}
            </Badge>
            <span className="text-muted-foreground">{t('notice')}</span>
          </div>
          <p className="text-muted-foreground text-xs">
            {t('meta', {
              version: state.page.version,
              when: when(state.page.builtAt),
            })}
          </p>
          <p className="text-sm whitespace-pre-wrap">{state.page.summary}</p>
          {state.page.citations.length > 0 && (
            <div className="bg-card-2 flex flex-col gap-1 rounded-md p-3">
              <h3 className="text-sm font-medium">{t('sources')}</h3>
              <ul className="flex flex-col gap-0.5 text-sm">
                {state.page.citations.map((c) => (
                  <li key={`${c.kind}:${c.id}`} className="flex gap-2">
                    <span className="text-muted-foreground">{c.kind}</span>
                    <span className="font-mono text-xs leading-5">
                      {shortCitationId(c.id)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
