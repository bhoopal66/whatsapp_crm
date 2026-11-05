'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Download, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AttendanceEntry } from '@/lib/meetings/attendance';
import { durationParts } from '@/lib/meetings/schedule';
import {
  attendanceCsvText,
  attendanceFileName,
  groupInvited,
  rejoinCount,
  type MeetingAttendanceData,
} from '@/lib/meetings/summary';

import { PersonAvatar, type AvatarPerson } from './person-avatars';

export type AttendanceRead =
  | { kind: 'idle' }
  | { kind: 'failed' }
  | { kind: 'ready'; data: MeetingAttendanceData };

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card-2 min-w-0 rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums sm:text-xl">
        {value}
      </p>
    </div>
  );
}

/** Summary tiles and the attendance report of a meeting that is over. */
export function MeetingSummaryCard({
  read,
  onRetry,
  ranMs,
  chatCount,
  title,
  nameFor,
  recordNameOf,
  personOf,
  timeOf,
}: {
  read: AttendanceRead;
  onRetry: () => void;
  ranMs: number | null;
  chatCount: number | null;
  title: string;
  nameFor: (userId: string) => string;
  /** The name for the file: "You" means nothing to whoever opens it. */
  recordNameOf: (userId: string) => string;
  personOf: (userId: string) => AvatarPerson;
  timeOf: (iso: string) => string;
}) {
  const t = useTranslations('Meetings');
  const td = useTranslations('Meetings.detail');
  const entries = read.kind === 'ready' ? read.data.entries : [];

  const download = () => {
    const text = attendanceCsvText(entries, recordNameOf, {
      name: td('csvName'),
      joined: td('csvJoined'),
      left: td('csvLeft'),
      minutes: td('csvMinutes'),
      seats: td('csvSeats'),
      removed: td('removedByHost'),
      stillPresent: td('stillInCall'),
      yes: td('csvYes'),
    });
    const url = URL.createObjectURL(
      new Blob([text], { type: 'text/csv;charset=utf-8' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = attendanceFileName(title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const notes = (e: AttendanceEntry): ReactNode => {
    const rejoins = rejoinCount(e);
    return (
      (e.removed || rejoins > 0) && (
        <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
          {e.removed && <span>{td('removedByHost')}</span>}
          {rejoins > 0 && <span>{td('rejoined', { count: rejoins })}</span>}
        </span>
      )
    );
  };
  const left = (e: AttendanceEntry) =>
    e.lastLeftAt ? timeOf(e.lastLeftAt) : td('stillInCall');
  const spent = (e: AttendanceEntry) => t('duration', durationParts(e.totalMs));

  return (
    <section className="bg-card space-y-5 rounded-xl border p-4 md:p-6">
      <div className="space-y-3">
        <h2 className="font-semibold">{td('summary')}</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 [&>*:first-child]:col-span-2 sm:[&>*:first-child]:col-span-1">
          <Tile
            label={td('statDuration')}
            value={ranMs === null ? '–' : t('duration', durationParts(ranMs))}
          />
          <Tile
            label={td('statPeople')}
            value={read.kind === 'ready' ? String(read.data.people) : '–'}
          />
          <Tile
            label={td('statChat')}
            value={chatCount === null ? '–' : String(chatCount)}
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{td('attendance')}</h3>
          {entries.length > 0 && (
            <Button variant="outline" size="sm" onClick={download}>
              <Download className="size-4" aria-hidden />
              {td('downloadCsv')}
            </Button>
          )}
        </div>
        {read.kind === 'idle' ? (
          <div className="bg-muted h-24 animate-pulse rounded-lg" aria-hidden />
        ) : read.kind === 'failed' ? (
          <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
            {td('attendanceFailed')}
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="size-4" aria-hidden />
              {td('retry')}
            </Button>
          </p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">{td('nobodyCame')}</p>
        ) : (
          <>
            <table className="hidden w-full text-sm sm:table">
              <thead>
                <tr className="text-muted-foreground border-b text-left text-xs">
                  <th className="py-2 pr-3 font-medium">{td('colName')}</th>
                  <th className="py-2 pr-3 font-medium">{td('colJoined')}</th>
                  <th className="py-2 pr-3 font-medium">{td('colLeft')}</th>
                  <th className="py-2 font-medium">{td('colTime')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.userId} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <PersonAvatar person={personOf(e.userId)} size="sm" />
                        <div className="min-w-0">
                          <p className="break-words">{nameFor(e.userId)}</p>
                          {notes(e)}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                      {timeOf(e.firstJoinedAt)}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                      {left(e)}
                    </td>
                    <td className="py-2 whitespace-nowrap tabular-nums">
                      {spent(e)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y sm:hidden">
              {entries.map((e) => (
                <li
                  key={e.userId}
                  className="space-y-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <PersonAvatar person={personOf(e.userId)} size="sm" />
                    <div className="min-w-0 text-sm">
                      <p className="break-words">{nameFor(e.userId)}</p>
                      {notes(e)}
                    </div>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-sm tabular-nums">
                    {[
                      [td('colJoined'), timeOf(e.firstJoinedAt)],
                      [td('colLeft'), left(e)],
                      [td('colTime'), spent(e)],
                    ].map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <dt className="text-muted-foreground text-xs">
                          {label}
                        </dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function PersonRow({
  person,
  checked,
  label,
}: {
  person: AvatarPerson;
  checked?: string;
  label?: string;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <PersonAvatar person={person} size="sm" />
      <span className="min-w-0 flex-1 truncate">{label ?? person.name}</span>
      {checked && (
        <Check className="text-success size-4 shrink-0" aria-label={checked} />
      )}
    </li>
  );
}

/** Who was asked. Once the record is in, who of them came and who did not. */
export function MeetingInvited({
  inviteeUserIds,
  openToWorkspace,
  read,
  personOf,
}: {
  inviteeUserIds: string[];
  openToWorkspace: boolean;
  /** Null until the meeting is over; "didn't join" needs a real answer. */
  read: AttendanceRead | null;
  personOf: (userId: string) => AvatarPerson;
}) {
  const t = useTranslations('Meetings');
  const td = useTranslations('Meetings.detail');
  const groups =
    read?.kind === 'ready'
      ? groupInvited(inviteeUserIds, read.data.entries)
      : null;
  const heading =
    'text-muted-foreground text-xs font-semibold tracking-wide uppercase';

  return (
    <aside className="bg-card h-fit space-y-3 rounded-xl border p-4">
      <h2 className={heading}>{td('invitees')}</h2>
      {inviteeUserIds.length === 0 ? (
        <p className="text-muted-foreground text-sm">{td('noInvitees')}</p>
      ) : groups ? (
        <>
          {groups.attended.length > 0 && (
            <ul className="space-y-2">
              {groups.attended.map((id) => (
                <PersonRow
                  key={id}
                  person={personOf(id)}
                  checked={td('attendedMark')}
                />
              ))}
            </ul>
          )}
          {groups.noShow.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-muted-foreground text-xs">{td('noShow')}</h3>
              <ul className="text-muted-foreground space-y-2">
                {groups.noShow.map((id) => (
                  <PersonRow key={id} person={personOf(id)} />
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <ul className="space-y-2">
          {inviteeUserIds.map((id) => (
            <PersonRow key={id} person={personOf(id)} />
          ))}
        </ul>
      )}
      {openToWorkspace && (
        <p className="text-muted-foreground text-xs">{t('openToWorkspace')}</p>
      )}
    </aside>
  );
}
