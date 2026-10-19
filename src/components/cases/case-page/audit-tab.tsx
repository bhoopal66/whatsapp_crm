'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { CaseTabProps } from '@/lib/cases/case-page';
import { parseAuditRows, type CaseAuditRow } from '@/lib/cases/case-tabs';

type State = 'loading' | 'ok' | 'error';

/** Audit (owners / admins): who opened this case's conversation, newest first. */
export function AuditTab({ caseId }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const locale = useLocale();
  const { nameOf } = useWorkspaceMembers();
  const [rows, setRows] = useState<CaseAuditRow[]>([]);
  const [state, setState] = useState<State>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    (async () => {
      setState('loading');
      try {
        const res = await fetch(`/api/cases/${caseId}/audit?limit=100`, {
          cache: 'no-store',
        });
        const json: unknown = res.ok
          ? await res.json().catch(() => null)
          : null;
        if (!current) return;
        if (!res.ok) {
          setState('error');
          return;
        }
        setRows(parseAuditRows(json));
        setState('ok');
      } catch {
        if (current) setState('error');
      }
    })();
    return () => {
      current = false;
    };
  }, [caseId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  const role = (r: string) =>
    t.has(`audit.roles.${r}`) ? t(`audit.roles.${r}`) : r;

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">{t('audit.explain')}</p>
      {state === 'loading' ? (
        <p className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('tabLoading')}
        </p>
      ) : state === 'error' ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm">
          <p className="text-destructive">{t('audit.loadFailed')}</p>
          <Button variant="outline" onClick={retry}>
            {t('retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t('audit.empty')}
        </p>
      ) : (
        <div className="bg-card overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('audit.who')}</TableHead>
                <TableHead>{t('audit.role')}</TableHead>
                <TableHead>{t('audit.when')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {nameOf(r.viewerId) ?? t('unknownPerson')}
                  </TableCell>
                  <TableCell>{role(r.viewerRole)}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {when(r.viewedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
