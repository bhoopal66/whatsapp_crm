'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Workflow } from 'lucide-react';

import {
  RULE_TRIGGERS,
  parseRuleRuns,
  parseRules,
  summariseRun,
  type RuleRunView,
  type RulesT,
} from '@/lib/cases/rules-ui';

type Loaded = { runs: RuleRunView[]; names: Map<string, string> } | 'error';

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/**
 * The case's automation-rule runs (migration 187), newest first, read
 * only. Shown only once a rule has run on the case, so a workspace with
 * no rules sees no change. Rule names come from `/api/cases/rules`; a
 * deleted rule (or a reader the list refuses) gets a generic name.
 */
export function CaseRuleRuns({ caseId }: { caseId: string }) {
  const t = useTranslations('CaseRules');
  const tr = t as unknown as RulesT;
  const locale = useLocale();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const runs = parseRuleRuns(
          await getJson(`/api/cases/${caseId}/rule-runs`)
        );
        if (!runs) throw new Error('unreadable');
        const names = new Map<string, string>();
        if (runs.length > 0) {
          const rules = parseRules(
            await getJson('/api/cases/rules').catch(() => null)
          );
          for (const r of rules ?? []) names.set(r.ruleId, r.name);
        }
        if (current) setLoaded({ runs: [...runs].reverse(), names });
      } catch {
        if (current) setLoaded('error');
      }
    })();
    return () => {
      current = false;
    };
  }, [caseId]);

  if (loaded === null || (loaded !== 'error' && loaded.runs.length === 0))
    return null;

  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  const triggerLabel = (k: string) =>
    (RULE_TRIGGERS as readonly string[]).includes(k) ? t(`trigger.${k}`) : k;

  return (
    <section className="bg-card space-y-2 rounded-lg border p-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Workflow className="text-muted-foreground size-4" aria-hidden />
        {t('caseTab.title')}
      </h2>
      {loaded === 'error' ? (
        <p className="text-destructive text-sm">{t('caseTab.loadFailed')}</p>
      ) : (
        <ol className="divide-y">
          {loaded.runs.map((run, i) => (
            <li
              key={`${run.ruleId}-${run.at}-${i}`}
              className="flex min-w-0 flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0"
            >
              <span className="font-medium break-words">
                {loaded.names.get(run.ruleId) ?? t('caseTab.deletedRule')}
              </span>
              <span className="text-muted-foreground text-xs">
                {t('caseTab.line', {
                  trigger: triggerLabel(run.trigger),
                  when: when(run.at),
                })}
              </span>
              <span
                className={
                  run.matched ? 'text-foreground' : 'text-muted-foreground'
                }
              >
                {summariseRun(run, tr)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
