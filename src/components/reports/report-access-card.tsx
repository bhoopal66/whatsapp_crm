'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Skeleton } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { isAccountRole } from '@/lib/auth/roles';
import {
  parseReportAccessPeople,
  type ReportAccessPerson,
  type ReportKey,
} from '@/lib/reports/access';

/**
 * "Who can see this report": the owner ticks the people who may open a
 * per-person report (migration 255). Rendered only for the owner; the
 * access route and `report_access_set` refuse anyone else anyway.
 */
export function ReportAccessCard({ report }: { report: ReportKey }) {
  const t = useTranslations('TagReport.access');
  const tr = useTranslations('TagReport.roles');
  const [people, setPeople] = useState<ReportAccessPerson[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch(`/api/reports/access?report=${report}`);
      const body = (await res.json().catch(() => null)) as {
        people?: unknown;
      } | null;
      if (!res.ok || !body) throw new Error('load');
      const list = parseReportAccessPeople(body.people);
      setPeople(list);
      setChosen(new Set(list.filter((p) => p.granted).map((p) => p.userId)));
    } catch {
      setError(true);
    }
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = useMemo(
    () => new Set((people ?? []).filter((p) => p.granted).map((p) => p.userId)),
    [people]
  );
  const dirty =
    chosen.size !== saved.size || [...chosen].some((id) => !saved.has(id));

  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/reports/access?report=${report}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [...chosen] }),
      });
      if (!res.ok) throw new Error('save');
      toast.success(t('saved'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const roleLabel = (role: string) => (isAccountRole(role) ? tr(role) : role);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="text-primary h-4 w-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('explain')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <div className="text-destructive flex flex-wrap items-center gap-2 text-sm">
            {t('loadFailed')}
            <Button type="button" variant="outline" size="sm" onClick={load}>
              {t('retry')}
            </Button>
          </div>
        ) : people === null ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : people.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('nobody')}</p>
        ) : (
          <ul className="divide-border border-border max-h-80 divide-y overflow-y-auto rounded-lg border">
            {people.map((p) => {
              const id = `report-access-${p.userId}`;
              return (
                <li
                  key={p.userId}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <Checkbox
                    id={id}
                    checked={chosen.has(p.userId)}
                    onCheckedChange={(on) => toggle(p.userId, on === true)}
                    disabled={saving}
                  />
                  <label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-baseline justify-between gap-x-3"
                  >
                    <span className="text-foreground truncate text-sm">
                      {p.name || t('unnamed')}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {roleLabel(p.role)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {people && people.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              {t('count', { count: chosen.size })}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
