'use client';

import { Mic, MicOff, MoreVertical, Video, VideoOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import type { ModerationAction } from '@/lib/meetings/room/contract';
import {
  parseRemovedPeople,
  readmitRequest,
  type RemovedPerson,
} from '@/lib/meetings/room/removed';
import {
  parseInviteeIds,
  peopleForPanel,
  peopleSections,
  type NamedPerson,
  type SectionPerson,
} from '@/lib/meetings/room-ui/panels';
import { cn } from '@/lib/utils';

import { PersonAvatar } from '../person-avatars';
import { useWorkspaceMembers } from '../use-workspace-members';
import { ConfirmDialog } from './confirm-dialog';
import { InvitePeople } from './invite-people';
import { RoomHostTools } from './room-host-tools';

/** Everyone in the call, who is still expected, and the host's tools. */
export function RoomPeoplePanel({ call }: { call: MeetingCall }) {
  const t = useTranslations('MeetingRoom');
  const { nameOf, avatarOf } = useWorkspaceMembers();
  const { profile, user } = useAuth();
  const [removing, setRemoving] = useState<SectionPerson | null>(null);
  const [query, setQuery] = useState('');

  const people = peopleForPanel({
    rows: call.participants,
    self: {
      participantId: call.participantId,
      userId: user?.id ?? null,
      name: profile?.full_name ?? '',
      micOn: call.micOn,
      cameraOn: call.cameraOn,
      handRaised: call.handRaised,
    },
    nameOf,
    unknownName: t('tile.unknown'),
  });

  const meetingId = call.meeting?.id ?? null;
  const hostUserId = call.meeting?.host_user_id ?? null;
  const [removed, setRemoved] = useState<RemovedPerson[]>([]);
  const [inviteeIds, setInviteeIds] = useState<string[]>([]);
  // Who was invited, and who the host removed (110, a manager's list
  // only): read on open and after every action.
  const [detailTick, setDetailTick] = useState(0);
  const loadDetail = () => setDetailTick((n) => n + 1);
  useEffect(() => {
    if (!meetingId) return;
    let live = true;
    fetch(`/api/meetings/${meetingId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live || !body) return;
        setRemoved(parseRemovedPeople(body));
        setInviteeIds(parseInviteeIds(body));
      })
      // Keep the last lists; the next open or action reads them again.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [meetingId, detailTick]);

  const removedIds = removed.map((r) => r.userId);
  const {
    hands,
    here,
    invited,
    removed: removedRows,
    searchable,
  } = peopleSections({
    people,
    hostUserId,
    inviteeUserIds: inviteeIds,
    removedUserIds: removedIds,
    nameOf,
    unknownName: t('tile.unknown'),
    query,
  });
  const takenKey = [
    ...people.map((p) => p.userId),
    ...inviteeIds,
    ...removedIds,
    hostUserId ?? '',
  ].join();
  const taken = useMemo(() => takenKey.split(','), [takenKey]);

  const moderate = async (p: SectionPerson, action: ModerationAction) => {
    if (!(await call.moderate(p.id, action)))
      toast.error(t('tile.moderateFailed'));
    loadDetail();
  };

  const letBackIn = async (userId: string) => {
    let ok = false;
    try {
      const res = await fetch(`/api/meetings/${meetingId}/moderate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(readmitRequest(userId)),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) toast.error(t('removedPeople.letBackInFailed'));
    loadDetail();
  };

  const row = (p: SectionPerson) => (
    <PersonRow
      key={p.id}
      person={p}
      avatarUrl={avatarOf(p.userId)}
      speaking={!!call.speaking[p.id]}
      canModerate={call.canModerate}
      onMute={() => void moderate(p, 'mute')}
      onLowerHand={() =>
        void (p.isSelf ? call.toggleHand() : moderate(p, 'lower_hand'))
      }
      onRemove={() => setRemoving(p)}
    />
  );
  const nothingShown =
    hands.length + here.length + invited.length + removedRows.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pb-2">
        <InvitePeople call={call} taken={taken} onInvited={loadDetail} />
        {call.canModerate && (
          <RoomHostTools
            call={call}
            anyHandUp={people.some((p) => p.handRaisedAt)}
          />
        )}
        {searchable && (
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panels.people.search')}
            aria-label={t('panels.people.search')}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <Section title={t('panels.people.hands')} count={hands.length}>
          {hands.map(row)}
        </Section>
        <Section title={t('panels.people.here')} count={here.length}>
          {here.map(row)}
        </Section>
        <Section title={t('panels.people.invited')} count={invited.length}>
          {invited.map((p) => (
            <NameRow key={p.userId} person={p} avatarUrl={avatarOf(p.userId)} />
          ))}
        </Section>
        <Section
          title={t('removedPeople.removedSection')}
          count={removedRows.length}
        >
          {removedRows.map((p) => (
            <NameRow key={p.userId} person={p} avatarUrl={avatarOf(p.userId)}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t('removedPeople.letBackInName', { name: p.name })}
                onClick={() => void letBackIn(p.userId)}
              >
                {t('removedPeople.letBackIn')}
              </Button>
            </NameRow>
          ))}
        </Section>
        {nothingShown && (
          <p className="text-muted-foreground px-2 py-6 text-center text-sm">
            {t('panels.people.noMatch')}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('tile.removeTitle', { name: removing?.name ?? '' })}
        description={t('tile.removeBody')}
        confirmLabel={t('tile.remove')}
        destructive
        onConfirm={() => {
          if (removing) void moderate(removing, 'remove');
        }}
      />
    </div>
  );
}

/** A heading with its count; a section with nobody in it isn't drawn. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section aria-label={title} className="pb-2">
      <h3 className="text-muted-foreground flex justify-between px-2 py-1 text-xs font-medium">
        <span>{title}</span>
        <span className="tabular-nums">{count}</span>
      </h3>
      <ul>{children}</ul>
    </section>
  );
}

function PersonRow({
  person: p,
  avatarUrl,
  speaking,
  canModerate,
  onMute,
  onLowerHand,
  onRemove,
}: {
  person: SectionPerson;
  avatarUrl: string | null;
  speaking: boolean;
  canModerate: boolean;
  onMute: () => void;
  onLowerHand: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('MeetingRoom');
  const inQueue = p.queuePosition !== null;
  return (
    <li className="hover:bg-muted/60 flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none">
      {inQueue && (
        <span
          className="bg-warning-soft text-warning flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums"
          aria-label={t('panels.people.queuePosition', {
            position: p.queuePosition ?? 0,
          })}
        >
          {p.queuePosition}
        </span>
      )}
      <PersonAvatar
        size="sm"
        className={cn(
          'shrink-0 transition-shadow duration-150 motion-reduce:transition-none',
          speaking && 'ring-2 ring-emerald-500'
        )}
        person={{ userId: p.userId || p.name, name: p.name, avatarUrl }}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm">
          {p.isSelf ? t('tile.you', { name: p.name }) : p.name}
        </span>
        {p.isOrganiser && (
          <Badge variant="secondary" className="shrink-0">
            {t('panels.people.organiser')}
          </Badge>
        )}
      </span>
      {speaking && (
        <span className="sr-only">{t('panels.people.speaking')}</span>
      )}
      {p.micOn ? (
        <Mic
          className="text-muted-foreground size-4 shrink-0"
          aria-label={t('panels.people.micOn')}
        />
      ) : (
        <MicOff
          className="text-destructive size-4 shrink-0"
          aria-label={t('tile.muted')}
        />
      )}
      {!inQueue &&
        (p.cameraOn ? (
          <Video
            className="text-muted-foreground size-4 shrink-0"
            aria-label={t('panels.people.cameraOn')}
          />
        ) : (
          <VideoOff
            className="text-muted-foreground size-4 shrink-0"
            aria-label={t('panels.people.cameraOff')}
          />
        ))}
      {canModerate && inQueue && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t('panels.people.lowerHandOf', { name: p.name })}
          onClick={onLowerHand}
        >
          {t('panels.people.lower')}
        </Button>
      )}
      {canModerate && !p.isSelf ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('panels.people.actions', { name: p.name })}
              />
            }
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent data-mode="dark" align="end" className="w-44">
            <DropdownMenuItem disabled={!p.micOn} onClick={onMute}>
              {t('tile.muteThem')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              {t('tile.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : canModerate && !inQueue ? (
        <span className="size-7 shrink-0" aria-hidden />
      ) : null}
    </li>
  );
}

/** Someone who isn't in the call: invited, or removed. */
function NameRow({
  person,
  avatarUrl,
  children,
}: {
  person: NamedPerson;
  avatarUrl: string | null;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2 rounded-xl px-2 py-1.5">
      <PersonAvatar
        size="sm"
        className="shrink-0 opacity-70"
        person={{ ...person, avatarUrl }}
      />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
        {person.name}
      </span>
      {children}
    </li>
  );
}
