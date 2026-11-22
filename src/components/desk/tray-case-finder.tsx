'use client';

/**
 * "Find case" on a tray document: search by case number (or caption code)
 * or by customer name, and add what is found to the document's candidate
 * list. Nothing is selected for the person (design 035). Access is the
 * server's: a number is the sorting lookup (the caller's banks and
 * readable cases), a name is the company search (companies the caller
 * may read) expanded to their open cases the caller may write.
 */
import { useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  MAX_COMPANIES,
  classifySearch,
  lookupToCandidate,
  overviewToCandidates,
} from '@/lib/desk/case-search';
import { normaliseCaseRef } from '@/lib/desk/case-ref';
import type { TrayCandidate } from '@/lib/desk/tray';

import { deskApi } from './desk-api';

type Outcome =
  | { kind: 'none' }
  | { kind: 'added'; count: number }
  | { kind: 'short' }
  | { kind: 'error'; message: string };

export function TrayCaseFinder({
  trayId,
  onFound,
}: {
  trayId: string;
  onFound: (found: TrayCandidate[]) => void;
}) {
  const t = useTranslations('DeskForms');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const search = async () => {
    const kind = classifySearch(q);
    if (kind === 'short') {
      setOutcome({ kind: 'short' });
      return;
    }
    setBusy(true);
    setOutcome(null);
    let found: TrayCandidate[] = [];
    if (kind === 'ref') {
      const r = await deskApi.lookup(normaliseCaseRef(q));
      if (!r.ok) {
        setBusy(false);
        setOutcome({ kind: 'error', message: r.error });
        return;
      }
      found = r.data ? [lookupToCandidate(r.data)] : [];
    } else {
      const c = await deskApi.companies(q.trim());
      if (!c.ok) {
        setBusy(false);
        setOutcome({ kind: 'error', message: c.error });
        return;
      }
      const overviews = await Promise.all(
        c.data.slice(0, MAX_COMPANIES).map(async (co) => {
          const o = await deskApi.companyOverview(co.customerId);
          return o.ok ? overviewToCandidates(co, o.data) : [];
        })
      );
      found = overviews.flat();
    }
    setBusy(false);
    onFound(found);
    setOutcome(
      found.length === 0
        ? { kind: 'none' }
        : { kind: 'added', count: found.length }
    );
  };

  const inputId = `tray-find-${trayId}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-foreground text-sm font-medium">
        {t('find.label')}
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          className="min-w-48 flex-1"
          value={q}
          maxLength={100}
          autoComplete="off"
          placeholder={t('find.placeholder')}
          onChange={(e) => {
            setQ(e.target.value);
            setOutcome(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void search()}
        >
          <Search aria-hidden className="size-4" />
          {busy ? t('find.searching') : t('find.button')}
        </Button>
      </div>
      <p role="status" className="text-muted-foreground min-h-4 text-xs">
        {outcome === null && t('find.hint')}
        {outcome?.kind === 'short' && t('find.short')}
        {outcome?.kind === 'none' && t('find.none')}
        {outcome?.kind === 'added' && t('find.added', { count: outcome.count })}
        {outcome?.kind === 'error' && t('find.error')}
      </p>
    </div>
  );
}
