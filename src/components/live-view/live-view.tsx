'use client';

/**
 * The Live view's pure render (/live, Track B item 8): one row per
 * person the viewer may watch (`live_team_view()`, migration 238), a
 * table from `sm` up and a card each on a phone. Status is an icon and
 * a word; the oldest wait is clock time since the customer wrote, with
 * the business-hours part underneath. The page loads and refreshes;
 * this only draws.
 */
import { useTranslations } from 'next-intl';
import {
  Circle,
  CircleDashed,
  Hourglass,
  Moon,
  RefreshCw,
  UserRoundX,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { LivePerson, LiveTeamView } from '@/lib/live-view/view';
import type { PresenceStatus } from '@/lib/presence';
import { cn } from '@/lib/utils';
import { durationParts } from '@/lib/worklist/timing';

const PRESENCE_ICON: Record<PresenceStatus, LucideIcon> = {
  online: Circle,
  away: Moon,
  offline: CircleDashed,
};

const PRESENCE_TONE: Record<PresenceStatus, string> = {
  online: 'text-success',
  away: 'text-warning',
  offline: 'text-muted-foreground',
};

const ROLE_KEYS = ['owner', 'admin', 'team_leader', 'agent', 'viewer'];

export interface LiveViewProps {
  /** null: not loaded yet. */
  view: LiveTeamView | null;
  /** The last load failed (`not_allowed` or `failed`); null: it did not. */
  error: 'not_allowed' | 'failed' | null;
  /** The clock the waits are measured against (epoch ms). */
  now: number;
  /** When the shown view was read, formatted for the viewer; null: never. */
  updatedLabel: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}

export function LiveView({
  view,
  error,
  now,
  updatedLabel,
  refreshing,
  onRefresh,
}: LiveViewProps) {
  const t = useTranslations('LiveView');

  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-4"
      data-testid="live-view"
      data-scope={view?.scope}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground text-sm">{t('help')}</p>
          {view && (
            <p className="text-muted-foreground text-xs">
              {view.scope === 'all' ? t('scopeAll') : t('scopeTeam')}
              {updatedLabel ? ` · ${t('updated', { time: updatedLabel })}` : ''}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="live-refresh"
        >
          <RefreshCw
            className={cn('size-4', refreshing && 'animate-spin')}
            aria-hidden
          />
          {refreshing ? t('refreshing') : t('refresh')}
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          data-testid="live-error"
          className="bg-destructive-soft text-destructive rounded-md px-3 py-2 text-sm"
        >
          {error === 'not_allowed' ? t('notAllowed') : t('failed')}
        </p>
      )}

      {view && view.unassignedWaiting !== null && (
        <p
          data-testid="live-unassigned"
          data-count={view.unassignedWaiting}
          className={cn(
            'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
            view.unassignedWaiting > 0
              ? 'border-destructive/40 bg-destructive-soft text-destructive font-medium'
              : 'bg-card text-muted-foreground'
          )}
        >
          <UserRoundX className="size-4 shrink-0" aria-hidden />
          {t('unassignedWaiting', { count: view.unassignedWaiting })}
        </p>
      )}

      {view === null ? (
        !error && (
          <p
            role="status"
            className="text-muted-foreground bg-card rounded-lg border p-6 text-center text-sm"
          >
            {t('loading')}
          </p>
        )
      ) : view.people.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title={t('empty')}
          hint={t('emptyHint')}
        />
      ) : (
        <>
          {/* Phones: a card per person. */}
          <ul aria-label={t('list')} className="space-y-2 sm:hidden">
            {view.people.map((p) => (
              <li
                key={p.userId}
                data-testid="live-card"
                data-id={p.userId}
                className="bg-card rounded-lg border p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <PersonName person={p} />
                  <PresenceBadge presence={p.presence} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <Figure label={t('openChats')} value={p.openChats} />
                  <Figure label={t('waiting')} value={p.waitingChats} />
                  <div className="col-span-2">
                    <dt className="text-muted-foreground text-xs">
                      {t('oldestWait')}
                    </dt>
                    <dd>
                      <OldestWait person={p} now={now} />
                    </dd>
                  </div>
                  <Figure label={t('repliesToday')} value={p.repliesToday} />
                </dl>
              </li>
            ))}
          </ul>

          {/* sm and up: one table. */}
          <div className="bg-card hidden rounded-lg border sm:block">
            <Table aria-label={t('list')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('person')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead className="text-end">{t('openChats')}</TableHead>
                  <TableHead className="text-end">{t('waiting')}</TableHead>
                  <TableHead>{t('oldestWait')}</TableHead>
                  <TableHead className="text-end">
                    {t('repliesToday')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.people.map((p) => (
                  <TableRow
                    key={p.userId}
                    data-testid="live-row"
                    data-id={p.userId}
                  >
                    <TableCell>
                      <PersonName person={p} />
                    </TableCell>
                    <TableCell>
                      <PresenceBadge presence={p.presence} />
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {p.openChats}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-end tabular-nums',
                        p.waitingChats > 0 && 'text-destructive font-medium'
                      )}
                    >
                      {p.waitingChats}
                    </TableCell>
                    <TableCell>
                      <OldestWait person={p} now={now} />
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {p.repliesToday}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground text-xs">
            {t('waitNote', { timezone: view.timezone })}
          </p>
        </>
      )}
    </div>
  );
}

function PersonName({ person }: { person: LivePerson }) {
  const t = useTranslations('LiveView');
  return (
    <div className="min-w-0">
      <p className="truncate font-medium">{person.name}</p>
      {ROLE_KEYS.includes(person.role) && (
        <p className="text-muted-foreground text-xs">
          {t(`roles.${person.role}`)}
        </p>
      )}
    </div>
  );
}

function PresenceBadge({ presence }: { presence: PresenceStatus }) {
  const t = useTranslations('LiveView');
  const Icon = PRESENCE_ICON[presence];
  return (
    <span
      data-presence={presence}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm whitespace-nowrap',
        PRESENCE_TONE[presence]
      )}
    >
      <Icon
        className={cn(
          'size-3 shrink-0',
          presence === 'online' && 'fill-current'
        )}
        aria-hidden
      />
      {t(`presence.${presence}`)}
    </span>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function OldestWait({ person, now }: { person: LivePerson; now: number }) {
  const t = useTranslations('LiveView');
  if (!person.oldestWaitingSince) {
    return (
      <span className="text-muted-foreground text-sm">{t('noneWaiting')}</span>
    );
  }
  const wall = durationParts(now - Date.parse(person.oldestWaitingSince));
  const bm = person.oldestWaitingBusinessMinutes;
  const business = bm && bm > 0 ? durationParts(bm * 60_000) : null;
  return (
    <div data-testid="live-oldest">
      <span
        className={cn(
          'inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap',
          wall.unit === 'minutes' ? 'text-warning' : 'text-destructive'
        )}
      >
        <Hourglass className="size-3.5 shrink-0" aria-hidden />
        {t('waitTime', { unit: wall.unit, n: wall.n })}
      </span>
      <p className="text-muted-foreground text-xs">
        {business
          ? t('businessTime', { unit: business.unit, n: business.n })
          : t('businessNone')}
      </p>
    </div>
  );
}
