'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowLeft,
  CalendarPlus,
  Clock,
  Hand,
  Link2,
  MessageSquare,
  Pencil,
  PhoneOff,
  Video,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import { buildMeetingIcs, icsFileName } from '@/lib/meetings/ics';
import {
  canJoinMeeting,
  canManageMeeting,
  durationParts,
  formatMeetingWhen,
  linkifyText,
  meetingDisplayStatus,
  meetingDurationMs,
  parseChatMessages,
  parseMeetingDetail,
  type ChatLine,
  type MeetingDetailData,
} from '@/lib/meetings/schedule';
import { cn } from '@/lib/utils';

import { MeetingFormDialog } from './meeting-form-dialog';
import { MeetingStatusBadge } from './meeting-status-badge';
import { PersonAvatar, type AvatarPerson } from './person-avatars';
import {
  useMeetingTimeZone,
  useWorkspaceMembers,
} from './use-workspace-members';

/** How often the page re-reads who is in the call. */
const REFRESH_MS = 20_000;
/** The most chat history the API hands over in one read. */
const CHAT_LIMIT = 200;

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed' }
  | ({ kind: 'ready' } & MeetingDetailData);

type Chat =
  | { kind: 'idle' }
  | { kind: 'failed' }
  | { kind: 'ready'; count: number; lines: ChatLine[] };

/** /meetings/[id] — a meeting's details, Join, and the host's controls. */
export function MeetingDetail({ meetingId }: { meetingId: string }) {
  const t = useTranslations('Meetings');
  const td = useTranslations('Meetings.detail');
  const locale = useLocale();
  const timeZone = useMeetingTimeZone();
  const { user, accountRole } = useAuth();
  const { nameOf, avatarOf } = useWorkspaceMembers();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [chat, setChat] = useState<Chat>({ kind: 'idle' });
  const [editKey, setEditKey] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'end' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (signal?: { cancelled: boolean }) =>
      fetch(`/api/meetings/${meetingId}`)
        .then(async (r) => {
          if (signal?.cancelled) return;
          if (r.status === 404) return setState({ kind: 'missing' });
          if (!r.ok) throw new Error(String(r.status));
          const detail = parseMeetingDetail(await r.json());
          if (signal?.cancelled) return;
          setState(detail ? { kind: 'ready', ...detail } : { kind: 'missing' });
        })
        .catch(() => {
          // Keep what is on screen through a failed refresh.
          if (!signal?.cancelled)
            setState((s) => (s.kind === 'ready' ? s : { kind: 'failed' }));
        }),
    [meetingId]
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    const timer = setInterval(() => void load(signal), REFRESH_MS);
    return () => {
      signal.cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  // Chat history: read when the count first arrives and again whenever
  // it changes. An API without `chat_count` leaves the section hidden.
  const chatCount = state.kind === 'ready' ? state.chatCount : null;
  useEffect(() => {
    if (chatCount === null || chatCount === 0) return;
    let cancelled = false;
    fetch(`/api/meetings/${meetingId}/messages?kind=chat&limit=${CHAT_LIMIT}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const lines = parseChatMessages(await r.json());
        if (!cancelled) setChat({ kind: 'ready', count: chatCount, lines });
      })
      .catch(() => {
        // Keep the lines already shown through a failed re-read.
        if (!cancelled)
          setChat((c) => (c.kind === 'ready' ? c : { kind: 'failed' }));
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId, chatCount]);

  const act = async (kind: 'cancel' | 'end') => {
    setBusy(true);
    try {
      const res = await fetch(
        kind === 'cancel'
          ? `/api/meetings/${meetingId}`
          : `/api/meetings/${meetingId}/end`,
        { method: kind === 'cancel' ? 'DELETE' : 'POST' }
      );
      if (!res.ok) throw new Error(String(res.status));
      toast.success(kind === 'cancel' ? td('cancelled') : td('ended'));
      await load();
    } catch {
      toast.error(td('actionFailed'));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/meetings/${meetingId}`
      );
      toast.success(td('linkCopied'));
    } catch {
      toast.error(td('copyFailed'));
    }
  };

  const back = (
    <Link
      href="/meetings"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {td('back')}
    </Link>
  );

  if (state.kind !== 'ready') {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
        {back}
        {state.kind === 'loading' ? (
          <div className="bg-muted h-40 animate-pulse rounded-xl" aria-hidden />
        ) : (
          <p
            className={cn(
              'text-sm',
              state.kind === 'failed'
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {state.kind === 'failed' ? t('loadFailed') : td('notFound')}
          </p>
        )}
      </div>
    );
  }

  const m = state.meeting;
  const status = meetingDisplayStatus(m, new Date());
  const joinable = canJoinMeeting(m);
  // The server's `meeting_can_manage` when it answered; the TS mirror
  // otherwise. UI only either way: the routes and RLS decide.
  const manage =
    joinable && (state.canManage ?? canManageMeeting(accountRole, user?.id, m));
  const nameFor = (userId: string) =>
    userId === user?.id ? t('you') : (nameOf(userId) ?? t('unknownPerson'));
  const personOf = (userId: string): AvatarPerson => ({
    userId,
    name: nameFor(userId),
    avatarUrl: avatarOf(userId),
  });
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const lasted = meetingDurationMs(m);
  const lastedLabel =
    lasted === null ? null : t('duration', durationParts(lasted));

  const downloadIcs = () => {
    const ics = buildMeetingIcs(m, {
      origin: window.location.origin,
      now: new Date(),
    });
    if (!ics) return;
    const url = URL.createObjectURL(
      new Blob([ics], { type: 'text/calendar;charset=utf-8' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = icsFileName(m.title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
      {back}

      <section
        className={cn(
          'border-border bg-card space-y-4 rounded-xl border p-4 md:p-6',
          status === 'live' &&
            'border-emerald-300 [[data-mode=dark]_&]:border-emerald-900'
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <MeetingStatusBadge status={status} />
            <h1 className="text-2xl font-bold break-words">{m.title}</h1>
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <Clock className="size-4 shrink-0" aria-hidden />
              {formatMeetingWhen(m, { locale, timeZone }) ?? t('instant')}
            </p>
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <PersonAvatar person={personOf(m.hostUserId)} size="sm" />
              {t('hostedBy', { name: nameFor(m.hostUserId) })}
            </p>
          </div>
          {joinable && (
            <Link
              href={`/meetings/${m.id}/room`}
              className={cn(buttonVariants({ size: 'lg' }), 'shrink-0')}
            >
              <Video className="size-4" aria-hidden />
              {td('joinNow')}
            </Link>
          )}
        </div>

        {m.description && (
          <p className="text-sm whitespace-pre-wrap">{m.description}</p>
        )}

        {!joinable && (
          <p className="text-muted-foreground text-sm">
            {lastedLabel ? td('lasted', { duration: lastedLabel }) : td('over')}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void copyLink()}>
            <Link2 className="size-4" aria-hidden />
            {td('copyLink')}
          </Button>
          {joinable && m.scheduledStart && (
            <Button variant="outline" onClick={downloadIcs}>
              <CalendarPlus className="size-4" aria-hidden />
              {td('addToCalendar')}
            </Button>
          )}
          {manage && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setEditKey((k) => k + 1);
                  setEditOpen(true);
                }}
              >
                <Pencil className="size-4" aria-hidden />
                {td('edit')}
              </Button>
              {m.presentCount > 0 ? (
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirm('end')}
                >
                  <PhoneOff className="size-4" aria-hidden />
                  {td('end')}
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirm('cancel')}
                >
                  <X className="size-4" aria-hidden />
                  {td('cancelMeeting')}
                </Button>
              )}
            </>
          )}
        </div>
      </section>

      {joinable && (
        <section className="border-border bg-card space-y-3 rounded-xl border p-4 md:p-6">
          <h2 className="text-sm font-semibold">
            {td('inCall')}{' '}
            <span className="text-muted-foreground font-normal tabular-nums">
              {t('inCall', { count: m.presentCount })}
            </span>
          </h2>
          {m.present.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {m.present.map((p) => (
                <li
                  key={p.userId}
                  className="bg-muted/60 flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm"
                >
                  <PersonAvatar person={personOf(p.userId)} size="sm" />
                  {nameFor(p.userId)}
                  {p.handRaisedAt && (
                    <Hand
                      className="size-4 text-amber-600 [[data-mode=dark]_&]:text-amber-300"
                      aria-label={td('handRaised')}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="border-border bg-card space-y-3 rounded-xl border p-4 md:p-6">
        <h2 className="text-sm font-semibold">{td('invitees')}</h2>
        {m.inviteeUserIds.length === 0 ? (
          <p className="text-muted-foreground text-sm">{td('noInvitees')}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {m.inviteeUserIds.map((id) => (
              <li key={id} className="flex min-w-0 items-center gap-2 text-sm">
                <PersonAvatar person={personOf(id)} />
                <span className="truncate">{nameFor(id)}</span>
              </li>
            ))}
          </ul>
        )}
        {m.openToWorkspace && (
          <p className="text-muted-foreground text-xs">
            {t('openToWorkspace')}
          </p>
        )}
      </section>

      {/* Before the meeting is over, an empty chat is not worth a section. */}
      {chatCount !== null && (chatCount > 0 || !joinable) && (
        <section className="border-border bg-card space-y-3 rounded-xl border p-4 md:p-6">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageSquare className="size-4" aria-hidden />
            {td('chat')}
          </h2>
          {chatCount === 0 ? (
            <p className="text-muted-foreground text-sm">{td('chatEmpty')}</p>
          ) : chat.kind === 'failed' ? (
            <p className="text-destructive text-sm">{td('chatFailed')}</p>
          ) : chat.kind === 'idle' ? (
            <div
              className="bg-muted h-16 animate-pulse rounded-lg"
              aria-hidden
            />
          ) : (
            <>
              {chat.count > chat.lines.length && (
                <p className="text-muted-foreground text-xs">
                  {td('chatPartial', {
                    shown: chat.lines.length,
                    total: chat.count,
                  })}
                </p>
              )}
              <ol className="max-h-96 space-y-3 overflow-y-auto">
                {chat.lines.map((line) => (
                  <li key={line.id} className="flex gap-2">
                    <PersonAvatar person={personOf(line.userId)} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs">
                        <span className="font-medium">
                          {nameFor(line.userId)}
                        </span>{' '}
                        <time
                          dateTime={line.createdAt}
                          className="text-muted-foreground tabular-nums"
                        >
                          {clock.format(new Date(line.createdAt))}
                        </time>
                      </p>
                      <p className="text-sm break-words whitespace-pre-wrap">
                        {linkifyText(line.body).map((seg, i) =>
                          seg.kind === 'link' ? (
                            <a
                              key={i}
                              href={seg.href}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              className="text-primary underline underline-offset-2"
                            >
                              {seg.text}
                            </a>
                          ) : (
                            <span key={i}>{seg.text}</span>
                          )
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      {manage && (
        <MeetingFormDialog
          key={editKey}
          open={editOpen}
          onOpenChange={setEditOpen}
          meeting={m}
          timeZone={timeZone}
          onSaved={() => void load()}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm === 'end' ? td('endConfirmTitle') : td('cancelConfirmTitle')
        }
        description={
          confirm === 'end' ? td('endConfirmBody') : td('cancelConfirmBody')
        }
        cancelLabel={td('keep')}
        confirmLabel={confirm === 'end' ? td('end') : td('cancelMeeting')}
        destructive
        onConfirm={() => confirm && void act(confirm)}
      />
    </div>
  );
}
