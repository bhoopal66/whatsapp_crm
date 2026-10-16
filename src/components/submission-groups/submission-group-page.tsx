'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Eye,
  FolderKanban,
  Loader2,
  RotateCcw,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { shouldSendOnKey } from '@/lib/groups/group-page';
import { createClient } from '@/lib/supabase/client';
import {
  canRetryCreate,
  endReasonView,
  groupBanners,
  SEND_TEXT_MAX,
  sendErrorKey,
  sentAsPreview,
  type SgDetail,
  type SgMessage,
} from '@/lib/submission-groups/ui';

import { MessageList } from './message-list';
import { PeoplePanel } from './people-panel';

/** Realtime bursts (a send and its status update) collapse into one re-read. */
const REFETCH_DEBOUNCE_MS = 400;

type State = 'loading' | 'ok' | 'gone' | 'forbidden' | 'error';
type Confirm = 'end' | 'retry' | 'archive' | null;

/** /submission-groups/[id] — header, banners, chat or archive, people. */
export function SubmissionGroupPage({ groupId }: { groupId: string }) {
  const t = useTranslations('SubmissionGroups.page');
  const tl = useTranslations('SubmissionGroups.labels');
  const locale = useLocale();
  const { user, profile } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [detail, setDetail] = useState<SgDetail | null>(null);
  const [archive, setArchive] = useState<SgMessage[] | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [acting, setActing] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/submission-groups/${groupId}`, {
        cache: 'no-store',
      });
      if (!mounted.current) return;
      if (res.status === 404) return setState('gone');
      if (res.status === 403) return setState('forbidden');
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as SgDetail;
      if (!mounted.current) return;
      setDetail(json);
      setState('ok');
    } catch {
      // Keep what is on screen on a failed refresh; fail only a first load.
      if (mounted.current) setState((s) => (s === 'ok' ? s : 'error'));
    }
  }, [groupId]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  // Live: a new or updated message row re-reads the group, which applies
  // the access rules server-side. One unique topic per mount.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), REFETCH_DEBOUNCE_MS);
    };
    const supabase = createClient();
    const channel = supabase
      .channel(
        `submission-group-messages:${groupId}:${Math.random().toString(36).slice(2)}`
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'submission_group_messages',
          filter: `group_id=eq.${groupId}`,
        },
        soon
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'submission_group_messages',
          filter: `group_id=eq.${groupId}`,
        },
        soon
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [groupId, reload]);

  const shown = archive ?? detail?.messages ?? [];

  // Follow new messages only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [archive, detail]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !detail?.can_send) return;
    stickRef.current = true;
    setSending(true);
    setText('');
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          reason?: string;
        } | null;
        toast.error(t(`sendErrors.${sendErrorKey(res.status, json?.reason)}`));
        // A refused send is kept as a blocked/failed row: show it, and
        // give the text back unless WhatsApp may already hold it.
        if (res.status !== 502) setText(body);
      } else if (res.status === 202) {
        // WhatsApp has it; only the CRM copy is unrecorded (it may later
        // show as failed). Do not resend.
        toast.warning(t('sendErrors.sentNotRecorded'));
      }
    } catch {
      setText(body);
      toast.error(t('sendErrors.unknown'));
    } finally {
      setSending(false);
      void reload();
    }
  };

  const post = async (path: 'end' | 'retry') => {
    setConfirm(null);
    setActing(true);
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/${path}`, {
        method: 'POST',
      });
      if (!res.ok) toast.error(t(path === 'end' ? 'endFailed' : 'retryFailed'));
      else toast.success(t(path === 'end' ? 'endDone' : 'retryDone'));
    } catch {
      toast.error(t(path === 'end' ? 'endFailed' : 'retryFailed'));
    } finally {
      setActing(false);
      void reload();
    }
  };

  const openArchive = async () => {
    setConfirm(null);
    setArchiveLoading(true);
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/archive`, {
        method: 'POST',
      });
      if (!res.ok) {
        toast.error(
          t(res.status === 403 ? 'archiveForbidden' : 'archiveFailed')
        );
        return;
      }
      const json = (await res.json()) as { messages?: SgMessage[] };
      stickRef.current = true;
      setArchive(json.messages ?? []);
    } catch {
      toast.error(t('archiveFailed'));
    } finally {
      setArchiveLoading(false);
    }
  };

  const back = (
    <Link
      href="/submission-groups"
      aria-label={t('back')}
      className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
    >
      <ArrowLeft className="size-4" />
    </Link>
  );

  if (state === 'loading') {
    return (
      <div className="space-y-4 p-4" aria-busy="true">
        <div className="bg-muted h-12 w-64 animate-pulse rounded" />
        <div className="bg-muted h-[50vh] animate-pulse rounded-lg" />
      </div>
    );
  }

  if (state !== 'ok' || !detail) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <Link
          href="/submission-groups"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
        <p className="text-muted-foreground text-sm">
          {state === 'gone'
            ? t('notFound')
            : state === 'forbidden'
              ? t('forbidden')
              : t('loadFailed')}
        </p>
        {state === 'error' && (
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t('retry')}
          </Button>
        )}
      </div>
    );
  }

  const { group } = detail;
  const ended = group.status === 'ENDED';
  const banners = groupBanners(group);
  const reason = endReasonView(group.end_reason);
  const myName =
    detail.access.find((a) => a.user_id === user?.id)?.name ??
    profile?.full_name ??
    null;
  const sentAs = sentAsPreview(myName, group.my_label);
  const dateLabel = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
      : '';
  const customer = group.contact
    ? group.contact.name || group.contact.phone || '—'
    : t('contactRemoved');

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <header className="flex items-start gap-3">
        {back}
        <span className="bg-wa-green/15 text-wa-green flex size-12 shrink-0 items-center justify-center rounded-full">
          <FolderKanban className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-semibold sm:text-lg">
              {group.submission_ref}
            </h1>
            <Badge variant={ended ? 'outline' : 'secondary'}>
              {ended ? t('statusEnded') : t('statusActive')}
            </Badge>
            {group.my_label && (
              <Badge variant="secondary">
                {t('you', { label: tl(group.my_label) })}
              </Badge>
            )}
          </div>
          {group.subject && (
            <p className="text-muted-foreground line-clamp-1 text-sm">
              {group.subject}
            </p>
          )}
          <p className="text-muted-foreground mt-0.5 text-xs">
            {[
              t('customer', { name: customer }),
              group.channel
                ? t('number', { name: group.channel.label ?? '' })
                : t('numberRemoved'),
              group.submission_status
                ? t('submissionStatus', { status: group.submission_status })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {ended && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('endedOn', { when: dateLabel(group.ended_at) })}
              {reason.key !== 'none' &&
                ` · ${
                  reason.key === 'finalStatus'
                    ? t('endReason.finalStatus', { status: reason.status })
                    : reason.key === 'other'
                      ? t('endReason.other', { reason: reason.raw })
                      : t(`endReason.${reason.key}`)
                }`}
            </p>
          )}
        </div>
        {detail.can_manage && (
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {canRetryCreate(group) && (
              <Button
                variant="outline"
                size="sm"
                disabled={acting}
                onClick={() => setConfirm('retry')}
              >
                <RotateCcw className="size-4" aria-hidden />
                {t('retryCreate')}
              </Button>
            )}
            {!ended && (
              <Button
                variant="destructive"
                size="sm"
                disabled={acting}
                onClick={() => setConfirm('end')}
              >
                {t('endGroup')}
              </Button>
            )}
          </div>
        )}
      </header>

      {banners.map((b) => (
        <div
          key={b}
          role="status"
          className={
            b === 'pending'
              ? 'bg-muted text-muted-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-sm'
              : 'border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm'
          }
        >
          {b === 'pending' ? (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          )}
          <span>
            {t(`banners.${b}`)}
            {b === 'createError' && group.wa_create_error && (
              <span className="block text-xs opacity-80">
                {group.wa_create_error}
              </span>
            )}
            {b === 'closeError' && group.wa_close_error && (
              <span className="block text-xs opacity-80">
                {group.wa_close_error}
              </span>
            )}
          </span>
        </div>
      ))}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_18rem]">
        <div className="bg-card flex h-[calc(100dvh-16rem)] min-h-80 flex-col overflow-hidden rounded-lg border">
          {archive && (
            <div className="flex items-start gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-800 [[data-mode=dark]_&]:text-amber-200">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{t('archiveViewing')}</span>
            </div>
          )}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 space-y-3 overflow-y-auto p-3"
          >
            {ended && !archive ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
                <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                  <Archive className="size-5" aria-hidden />
                </span>
                <p className="font-semibold">{t('endedTitle')}</p>
                <p className="text-muted-foreground max-w-md text-sm">
                  {detail.archive_available
                    ? t('endedArchiveBody')
                    : t('endedNoArchive')}
                </p>
                {detail.archive_available && (
                  <>
                    <Button
                      variant="outline"
                      disabled={archiveLoading}
                      onClick={() => setConfirm('archive')}
                    >
                      {archiveLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Eye className="size-4" aria-hidden />
                      )}
                      {t('viewArchive')}
                    </Button>
                    <p className="text-muted-foreground text-xs">
                      {t('archiveLogged')}
                    </p>
                  </>
                )}
              </div>
            ) : shown.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                {t('empty')}
              </p>
            ) : (
              <MessageList messages={shown} />
            )}
          </div>

          {!ended && (
            <div className="border-t p-2">
              {detail.can_send ? (
                sentAs && (
                  <p className="text-muted-foreground px-1 pb-1.5 text-xs">
                    {t('sentAs', { who: sentAs })}
                  </p>
                )
              ) : (
                <p className="text-muted-foreground px-1 pb-2 text-xs">
                  {t('cannotSend')}
                </p>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (shouldSendOnKey(e.nativeEvent)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  disabled={!detail.can_send}
                  rows={1}
                  maxLength={SEND_TEXT_MAX}
                  placeholder={t('placeholder')}
                  aria-label={t('placeholder')}
                  className="max-h-32 min-h-9 resize-none"
                />
                <Button
                  size="icon"
                  aria-label={t('send')}
                  disabled={!detail.can_send || sending || !text.trim()}
                  onClick={() => void send()}
                >
                  {sending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        <PeoplePanel
          groupId={groupId}
          access={detail.access}
          editable={detail.can_manage && !ended}
          onChanged={() => void reload()}
        />
      </div>

      <ConfirmDialog
        open={confirm === 'end'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('endTitle')}
        description={t('endBody', { ref: group.submission_ref })}
        cancelLabel={t('cancel')}
        confirmLabel={t('endGroup')}
        onConfirm={() => void post('end')}
        destructive
      />
      <ConfirmDialog
        open={confirm === 'retry'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('retryTitle')}
        description={t('retryBody')}
        cancelLabel={t('cancel')}
        confirmLabel={t('retryCreate')}
        onConfirm={() => void post('retry')}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('archiveTitle')}
        description={t('archiveBody')}
        cancelLabel={t('cancel')}
        confirmLabel={t('viewArchive')}
        onConfirm={() => void openArchive()}
      />
    </div>
  );
}
