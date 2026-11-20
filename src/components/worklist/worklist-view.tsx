'use client';

/**
 * My worklist (package 029c): the pure render of a ranked list. The
 * page loads and ranks (`src/lib/worklist`); this only draws it.
 *
 * Read only: every row links to its existing screen and nothing here
 * acts. Titles are generated from the kind and a short reference, never
 * a name or a message body (the package's privacy rule). Members see
 * their own items; team leaders and up get the "Assigned to" filter.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  worklistKindKey,
  worklistReasonLabel,
  type WorklistItem,
  type WorklistMode,
} from '@/lib/worklist/rank';

export interface WorklistMemberOption {
  /** Auth user id. */
  userId: string;
  name: string;
}

export interface WorklistViewProps {
  /** null: still loading. */
  items: readonly WorklistItem[] | null;
  mode: WorklistMode;
  /** Display name for an auth user id; null when unknown. */
  nameOf: (userId: string) => string | null;
  /** All mode only: the auth user id filtered to, '' for anyone. */
  assignedTo: string;
  onAssignedTo: (userId: string) => void;
  members: readonly WorklistMemberOption[];
}

export function WorklistView({
  items,
  mode,
  nameOf,
  assignedTo,
  onAssignedTo,
  members,
}: WorklistViewProps) {
  const t = useTranslations('Worklist');
  const tAll = useTranslations();
  // A bank guest (or no role yet) has nothing to rank.
  const shown = mode === 'none' ? [] : items;

  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-4"
      data-testid="worklist"
      data-mode={mode}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('help')}</p>
        </div>
        {mode === 'all' && (
          <label className="inline-flex items-center gap-2 text-sm">
            {t('assignedTo')}
            <select
              data-testid="worklist-assigned-to"
              value={assignedTo}
              onChange={(e) => onAssignedTo(e.target.value)}
              className="border-input bg-card dark:bg-input/30 h-8 rounded-md border px-2 text-sm"
            >
              <option value="">{t('anyone')}</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="bg-card rounded-lg border">
        {shown === null ? (
          <p
            role="status"
            className="text-muted-foreground p-6 text-center text-sm"
          >
            {t('loading')}
          </p>
        ) : shown.length === 0 ? (
          <p
            data-testid="worklist-empty"
            className="text-muted-foreground p-6 text-center text-sm"
          >
            {t('empty')}
          </p>
        ) : (
          <Table aria-label={t('list')}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">{t('rank')}</TableHead>
                <TableHead>{t('item')}</TableHead>
                <TableHead>{t('assignedTo')}</TableHead>
                <TableHead className="text-right">{t('score')}</TableHead>
                <TableHead>{t('reasons')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((it, i) => (
                <TableRow
                  key={`${it.kind}:${it.id}`}
                  data-testid="worklist-row"
                  data-kind={it.kind}
                  data-id={it.id}
                >
                  <TableCell className="text-muted-foreground tabular-nums">
                    {i + 1}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={it.href}
                      className="text-primary font-medium hover:underline"
                    >
                      {tAll(worklistKindKey(it.kind), { ref: it.ref })}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {it.assignees.map((u) => nameOf(u) ?? u).join(', ')}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {it.score}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {it.reasons.map((r) => (
                        <Badge
                          key={r}
                          data-reason={r}
                          variant={
                            r === 'sla_overdue' ? 'destructive' : 'secondary'
                          }
                        >
                          {tAll(worklistReasonLabel(r))}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
