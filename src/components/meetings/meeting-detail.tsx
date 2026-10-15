'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, Link2, Pencil, PhoneOff, Video, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import {
  canJoinMeeting,
  canManageMeeting,
  formatMeetingWhen,
  meetingDisplayStatus,
  parseMeetingDetail,
  type MeetingDetailData,
} from '@/lib/meetings/schedule';
import { cn } from '@/lib/utils';

import { MeetingFormDialog } from './meeting-form-dialog';
import { MeetingStatusBadge } from './meeting-status-badge';
import {
  useMeetingTimeZone,
  useWorkspaceMembers,
} from './use-workspace-members';

/** How often the page re-reads who is in the call. */
const REFRESH_MS = 20_000;

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed' }
  | ({ kind: 'ready' } & MeetingDetailData);

/** /meetings/[id] — a meeting's details, Join, and the host's controls. */
export function MeetingDetail({ meetingId }: { meetingId: string }) {
  const t = useTranslations('Meetings');
  const td = useTranslations('Meetings.detail');
  const locale = useLocale();
  const timeZone = useMeetingTimeZone();
  const { user, accountRole } = useAuth();
  const { nameOf } = useWorkspaceMembers();
  const [state, setState] = useState<State>({ kind: 'loading' });
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

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
      {back}

      <section className="border-border bg-card space-y-4 rounded-xl border p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-bold break-words">{m.title}</h1>
            <p className="text-muted-foreground text-sm">
              {formatMeetingWhen(m, { locale, timeZone }) ?? t('instant')}
            </p>
          </div>
          <MeetingStatusBadge status={status} />
        </div>

        {m.description && (
          <p className="text-sm whitespace-pre-wrap">{m.description}</p>
        )}

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground text-xs">{td('host')}</dt>
            <dd>{nameFor(m.hostUserId)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">{td('inCall')}</dt>
            <dd className="tabular-nums">
              {t('inCall', { count: m.presentCount })}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground text-xs">{td('invitees')}</dt>
            <dd>
              {m.inviteeUserIds.length === 0
                ? td('noInvitees')
                : m.inviteeUserIds.map(nameFor).join(', ')}
            </dd>
            {m.openToWorkspace && (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('openToWorkspace')}
              </p>
            )}
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          {joinable ? (
            <Link href={`/meetings/${m.id}/room`} className={buttonVariants()}>
              <Video className="size-4" aria-hidden />
              {td('join')}
            </Link>
          ) : (
            <p className="text-muted-foreground text-sm">{td('over')}</p>
          )}
          <Button variant="outline" onClick={() => void copyLink()}>
            <Link2 className="size-4" aria-hidden />
            {td('copyLink')}
          </Button>
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
