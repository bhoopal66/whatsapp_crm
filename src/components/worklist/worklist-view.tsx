'use client';

/**
 * My worklist (package 029c): the pure render of a ranked list. The
 * page loads and ranks (`src/lib/worklist`); this only draws it.
 *
 * Read only: every row links to its existing screen and nothing here
 * acts. Titles are generated from the kind and a short reference, never
 * a name or a message body (the package's privacy rule). Members see
 * their own items; team leaders and up get the "Assigned to" filter,
 * with "My team" (the people in the teams they lead, and themselves).
 * The "When" column says the clock behind the ranking in words
 * ("Overdue by 2 h"); the score itself only orders the list.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlarmClock, Clock, Hourglass } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  timingKey,
  timingLabel,
  type WorklistTimingState,
} from '@/lib/worklist/timing';
import { cn } from '@/lib/utils';

/** The filter value for anyone (a Select item value cannot be empty). */
const ANYONE = '__anyone__';
/** The "My team" filter value of `assignedTo`. */
export const WORKLIST_MY_TEAM = '__team__';

const TIMING_ICON = {
  overdue: AlarmClock,
  due_in: Clock,
  waiting: Hourglass,
} as const satisfies Record<WorklistTimingState, unknown>;

const TIMING_TONE: Record<WorklistTimingState, string> = {
  overdue: 'text-destructive',
  due_in: 'text-warning',
  waiting: 'text-foreground',
};

export interface WorklistMemberOption {
  /** Auth user id. */
  userId: string;
  name: string;
}

export interface WorklistViewProps {
  /** null: still loading. */
  items: readonly WorklistItem[] | null;
  /** null: the viewer's role is not known yet, so show loading. */
  mode: WorklistMode | null;
  /** Display name for an auth user id; null when unknown. */
  nameOf: (userId: string) => string | null;
  /**
   * All mode only: the auth user id filtered to, `WORKLIST_MY_TEAM` for
   * "My team", '' for anyone.
   */
  assignedTo: string;
  onAssignedTo: (userId: string) => void;
  members: readonly WorklistMemberOption[];
  /** Offer "My team" (team leader and up). */
  teamOption?: boolean;
  /** "My team" is chosen and the viewer leads nobody: say so. */
  noTeam?: boolean;
  /** The clock the items were ranked against (epoch ms). */
  now: number;
  /**
   * The empty list's wording, when the page knows better than "Nothing
   * needs action" (customers are waiting for a reply above it).
   */
  emptyLabel?: string;
}

export function WorklistView({
  items,
  mode,
  nameOf,
  assignedTo,
  onAssignedTo,
  members,
  teamOption = false,
  noTeam = false,
  now,
  emptyLabel,
}: WorklistViewProps) {
  const t = useTranslations('Worklist');
  const tAll = useTranslations();
  // A bank guest has nothing to rank; an unknown role is still loading.
  const shown = mode === null ? null : mode === 'none' ? [] : items;
  const filterLabel =
    assignedTo === WORKLIST_MY_TEAM
      ? t('myTeam')
      : assignedTo
        ? (members.find((m) => m.userId === assignedTo)?.name ??
          t('unknownPerson'))
        : t('anyone');

  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-4"
      data-testid="worklist"
      data-mode={mode}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-sm">{t('help')}</p>
        </div>
        {mode === 'all' && (
          <div
            className="flex w-full items-center gap-2 text-sm sm:w-auto"
            data-testid="worklist-assigned-to"
            data-value={assignedTo}
          >
            <span id="worklist-assigned-to-label" className="shrink-0">
              {t('assignedTo')}
            </span>
            <Select
              value={assignedTo || ANYONE}
              onValueChange={(v) => {
                if (typeof v !== 'string') return;
                onAssignedTo(v === ANYONE ? '' : v);
              }}
            >
              <SelectTrigger
                aria-labelledby="worklist-assigned-to-label"
                className="min-w-0 flex-1 sm:w-56 sm:flex-none"
              >
                <SelectValue>{filterLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANYONE}>{t('anyone')}</SelectItem>
                {teamOption && (
                  <SelectItem value={WORKLIST_MY_TEAM}>
                    {t('myTeam')}
                  </SelectItem>
                )}
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {mode === 'all' && assignedTo === WORKLIST_MY_TEAM && noTeam && (
        <p
          data-testid="worklist-no-team"
          className="text-muted-foreground text-sm"
        >
          {t('noTeam')}
        </p>
      )}

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
            {emptyLabel ?? t('empty')}
          </p>
        ) : (
          <Table aria-label={t('list')}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">{t('rank')}</TableHead>
                <TableHead>{t('item')}</TableHead>
                <TableHead>{t('assignedTo')}</TableHead>
                <TableHead>{t('when')}</TableHead>
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
                    {it.assignees
                      .map((u) => nameOf(u) ?? t('unknownPerson'))
                      .join(', ')}
                  </TableCell>
                  <TableCell data-testid="worklist-when">
                    <TimingText item={it} now={now} />
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

function TimingText({ item, now }: { item: WorklistItem; now: number }) {
  const t = useTranslations('Worklist');
  const label = timingLabel(item.timing, now);
  if (!label) {
    return (
      <span className="text-muted-foreground" aria-label={t('timing.none')}>
        —
      </span>
    );
  }
  const Icon = TIMING_ICON[label.state];
  return (
    <span
      data-timing={label.state}
      className={cn(
        'inline-flex items-center gap-1 text-sm whitespace-nowrap',
        TIMING_TONE[label.state],
        label.state === 'overdue' && 'font-medium'
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {t(timingKey(label.state), { unit: label.unit, n: label.n })}
    </span>
  );
}
