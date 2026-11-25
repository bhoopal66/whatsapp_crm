'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Eye,
  FileText,
  Loader2,
  Paperclip,
  ShieldCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { ChannelView } from '@/components/chat/channel-view';
import { useChatWorkspaceContext } from '@/components/chat/chat-context';
import { Composer } from '@/components/chat/composer';
import { LoadFailed } from '@/components/chat/load-failed';
import { MessageMarksProvider } from '@/components/chat/message-marks';
import { ThreadPanel } from '@/components/chat/thread-panel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useGuestRefresh, useTableSignal } from '@/hooks/use-deal-rooms';
import { useAuth } from '@/hooks/use-auth';
import { draftAfterSend } from '@/lib/chat/composer';
import { markRoomBellsRead } from '@/lib/deal-rooms/bells';
import type { MessagePage, RoomDetail } from '@/lib/deal-rooms/reads';
import {
  ROOM_TIMELINE_EMPTY,
  createRoomTimeline,
  timelinePhase,
} from '@/lib/deal-rooms/room-timeline';
import {
  ROOM_SIGNAL_TABLES,
  bubbleOf,
  groupAudience,
  groupComposerMode,
  roomBanner,
  receiptLine,
  roomPhase,
  roomSignalFilter,
  roomTitle,
  templateParamCount,
  windowCountdown,
  type GroupComposerMode,
} from '@/lib/deal-rooms/view';
import {
  ROOM_MEDIA_ACCEPT,
  ROOM_MEDIA_CAPTION_MAX,
  checkRoomMedia,
} from '@/lib/deal-rooms/room-media';
import {
  roomTemplateOptions,
  type RoomTemplateRow,
} from '@/lib/deal-rooms/room-templates';
import { roomSendOutcome } from '@/lib/deal-rooms/send-outcome';
import { rightColumn, withRightColumn } from '@/lib/chat/panels';
import { renderTemplateBody } from '@/lib/whatsapp/template-body';
import { cn } from '@/lib/utils';

export interface RoomContext {
  detail: RoomDetail;
  reload: () => Promise<unknown>;
}

export interface DealRoomViewProps {
  roomId: string;
  /** The right column: the Members panel (a later job). */
  membersPanel?: (ctx: RoomContext) => React.ReactNode;
  /** Beside the tabs: room actions (invite link, close…; a later job). */
  headerActions?: (ctx: RoomContext) => React.ReactNode;
}

/** Re-renders every 30 s, for the window countdown and composer mode. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function DealRoomView({
  roomId,
  membersPanel,
  headerActions,
}: DealRoomViewProps) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const { isBankGuest } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useNow();
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>(
    'loading'
  );
  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/deal-rooms/${roomId}`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        // Gone, or no longer ours (a guest whose access was withdrawn):
        // drop what is on screen rather than keep showing it.
        setDetail(null);
        setState('gone');
        return true;
      }
      if (!res.ok) throw new Error(String(res.status));
      setDetail((await res.json()) as RoomDetail);
      setState('ok');
      return true;
    } catch {
      setState((s) => (s === 'ok' ? s : 'error'));
      return false;
    }
  }, [roomId]);
  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload]);
  useTableSignal(
    ws.sb,
    ROOM_SIGNAL_TABLES,
    (table) => roomSignalFilter(table, roomId),
    reload,
    !isBankGuest
  );
  // A guest cannot read `deal_rooms`, so that signal never reaches them.
  // On the viewer, not the detail: a failed first read has no detail yet.
  useGuestRefresh(isBankGuest, reload);

  if (!detail) {
    if (state === 'error')
      return (
        <LoadFailed
          message={t('rooms.loadFailed')}
          onRetry={() => {
            setState('loading');
            void reload();
          }}
        />
      );
    return (
      <p className="text-muted-foreground p-8 text-center text-sm">
        {state === 'gone' ? t('rooms.notFound') : ''}
      </p>
    );
  }

  const { room } = detail;
  const guest = detail.access === 'guest';
  const tab = !guest && params.get('tab') === 'notes' ? 'notes' : 'group';
  const setTab = (next: 'group' | 'notes') => {
    const q = new URLSearchParams(params.toString());
    if (next === 'notes') q.set('tab', 'notes');
    else q.delete('tab');
    const s = q.toString();
    router.replace(`${pathname}${s ? `?${s}` : ''}`, { scroll: false });
  };
  // Team notes threads open beside the timeline (?thread=), as on a
  // channel's own page.
  const right = rightColumn(params);
  const threadRoot =
    tab === 'notes' && right?.kind === 'thread' ? right.rootId : null;
  const showThread = (rootId: string | null) =>
    router.replace(
      `${pathname}${withRightColumn(
        params.toString(),
        rootId ? { kind: 'thread', rootId } : null
      )}`,
      { scroll: false }
    );
  const phase = roomPhase(room.status, room.participantCount);
  const creator = room.createdBy
    ? ws.peopleById.get(room.createdBy.toLowerCase())?.fullName
    : null;
  const sub = [
    t('rooms.kindLine'),
    creator ? t('rooms.openedBy', { name: creator }) : null,
    room.dealId ? t('rooms.linkedDeal') : null,
  ].filter(Boolean);
  const countdown = windowCountdown(room.windowUntil, now);
  const ctx: RoomContext = { detail, reload };
  const mode = groupComposerMode({ ...room, now, guest });

  const layout = (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Link
              href="/chat/rooms"
              className="hover:bg-muted -ms-1 rounded p-1 lg:hidden"
              aria-label={t('channel.back')}
            >
              <ArrowLeft className="size-4 rtl:rotate-180" />
            </Link>
            <h2 className="min-w-0 flex-1 truncate text-base font-bold">
              {roomTitle(room)}
            </h2>
            {headerActions?.(ctx)}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {sub.join(' · ')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <div
              role="tablist"
              aria-label={t('rooms.tabs.label')}
              className="bg-muted inline-flex rounded-lg p-0.5"
            >
              {(guest
                ? (['group'] as const)
                : (['group', 'notes'] as const)
              ).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs font-medium',
                    tab === k
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(`rooms.tabs.${k}`)}
                </button>
              ))}
            </div>
            {tab === 'group' && phase === 'active' && (
              <span className="text-muted-foreground text-xs">
                {countdown.open
                  ? t('rooms.window.open', {
                      hours: countdown.hours,
                      minutes: countdown.minutes,
                    })
                  : t('rooms.window.closed')}
              </span>
            )}
          </div>
        </header>
        {tab === 'group' ? (
          <>
            <div className="border-warning/40 bg-warning-soft text-foreground mx-4 mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <Eye className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <p>
                {t.rich('rooms.everyone', {
                  b: (c) => <strong>{c}</strong>,
                })}
              </p>
            </div>
            {phase !== 'active' && (
              <p
                role="status"
                className="bg-muted text-foreground mx-4 mt-2 rounded-md px-3 py-2 text-xs"
              >
                {t(`rooms.banner.${roomBanner(phase, room.cancelledAt)}`)}
              </p>
            )}
            <GroupTimeline roomId={roomId} />
          </>
        ) : (
          <>
            <div className="px-4 pt-3">
              <span className="bg-success-soft text-success inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium">
                <ShieldCheck className="size-3.5" aria-hidden />
                {t('channel.internal')}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <ChannelView
                embedded
                channelId={room.channelId}
                onOpenThread={(rootId) => showThread(rootId)}
                footer={
                  <Composer key={room.channelId} channelId={room.channelId} />
                }
              />
            </div>
          </>
        )}
        {/* Hidden, not unmounted, on Team notes: the typed text, the staged
            file, the template values and the "unconfirmed, do not resend"
            warning are the sender's, and a tab switch must not lose them.
            `hidden` also takes it out of focus order and the a11y tree. */}
        <div hidden={tab !== 'group'}>
          <GroupComposer
            roomId={roomId}
            mode={mode}
            audience={groupAudience(room.participantCount)}
          />
        </div>
      </div>
      {threadRoot && (
        <ThreadPanel
          key={threadRoot}
          channelId={room.channelId}
          rootId={threadRoot}
          onClose={() => showThread(null)}
        />
      )}
      {membersPanel?.(ctx)}
    </div>
  );
  // The notes timeline and its thread share one marks provider (saved,
  // pinned), as on a channel's own page. Staff keep it across the tabs so
  // switching does not remount the room; a guest never has Team notes.
  return guest ? (
    layout
  ) : (
    <MessageMarksProvider key={room.channelId} channelId={room.channelId}>
      {layout}
    </MessageMarksProvider>
  );
}

const PAGE = 50;

/** The group's messages, newest at the bottom; older pages on scroll-up. */
function GroupTimeline({ roomId }: { roomId: string }) {
  const t = useTranslations('Chat.rooms');
  const format = useFormatter();
  const { sb } = useChatWorkspaceContext();
  const [timeline, setTimeline] = useState(ROOM_TIMELINE_EMPTY);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Where the scroll goes after the next render: the bottom, or kept
  // in place while an older page is put above.
  const anchor = useRef<'bottom' | { height: number; top: number } | null>(
    'bottom'
  );

  const page = useCallback(
    async (before: string | null): Promise<MessagePage> => {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (before) q.set('before', before);
      const res = await fetch(`/api/deal-rooms/${roomId}/messages?${q}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as MessagePage;
    },
    [roomId]
  );
  const log = useMemo(() => createRoomTimeline(page), [page]);
  const refresh = useCallback(async () => {
    const ok = await log.refresh();
    if (ok) {
      const el = box.current;
      if (!el || el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
        anchor.current = 'bottom';
      }
      if (document.visibilityState === 'visible') {
        void markRoomBellsRead(sb, roomId);
      }
    }
    setTimeline(log.state());
    return ok;
  }, [log, sb, roomId]);
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);
  // Back on a tab that a message reached while it was hidden.
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState === 'visible') {
        void markRoomBellsRead(sb, roomId);
      }
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, [sb, roomId]);
  useTableSignal(sb, ['group_messages'], () => `room_id=eq.${roomId}`, refresh);

  const loadOlder = async () => {
    if (!timeline.older || loadingOlder) return;
    setLoadingOlder(true);
    if (await log.loadOlder()) {
      const el = box.current;
      if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setTimeline(log.state());
    }
    setLoadingOlder(false);
  };
  const { messages, older } = timeline;
  const phase = timelinePhase(timeline);

  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current;
    if (!el || !a || messages === null) return;
    el.scrollTop =
      a === 'bottom' ? el.scrollHeight : el.scrollHeight - a.height + a.top;
    anchor.current = null;
  }, [messages]);

  if (phase === 'failed') {
    return (
      <LoadFailed
        message={t('timeline.loadFailed')}
        onRetry={() => {
          setTimeline(ROOM_TIMELINE_EMPTY);
          void refresh();
        }}
      />
    );
  }
  if (messages === null) {
    return (
      <p className="text-muted-foreground flex-1 p-8 text-center text-sm">
        {t('timeline.loading')}
      </p>
    );
  }
  return (
    <div
      ref={box}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
      onScroll={(e) => {
        if (e.currentTarget.scrollTop < 80) void loadOlder();
      }}
    >
      {older && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          className="text-muted-foreground hover:text-foreground mx-auto flex items-center gap-1 text-xs"
        >
          {loadingOlder && <Loader2 className="size-3 animate-spin" />}
          {t('timeline.loadOlder')}
        </button>
      )}
      {messages.length === 0 && (
        <p className="text-muted-foreground pt-8 text-center text-sm">
          {t('timeline.empty')}
        </p>
      )}
      {messages.map((m) => {
        const b = bubbleOf(m);
        const c = b.content;
        const text =
          c.kind === 'text' ? (
            <p className="text-sm whitespace-pre-wrap">{c.text}</p>
          ) : c.kind === 'template' ? (
            <>
              <p className="text-muted-foreground text-xs font-medium">
                {t('timeline.template', { name: c.name })}
              </p>
              {c.text && (
                <p className="text-sm whitespace-pre-wrap">{c.text}</p>
              )}
            </>
          ) : c.kind === 'file' ? (
            <div className="bg-background/70 flex items-center gap-2 rounded-md border px-2.5 py-1.5">
              <FileText className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {c.name ?? t('timeline.file')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('timeline.savedToDeal')}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm italic">
              {t('timeline.unsupported')}
            </p>
          );
        if (b.side === 'system') {
          return (
            <div
              key={m.id}
              className="text-muted-foreground flex items-center gap-3 text-xs"
            >
              <span className="bg-border h-px flex-1" />
              <span className="max-w-[80%] text-center">
                {c.kind === 'text' ? c.text : t('timeline.unsupported')}
              </span>
              <span className="bg-border h-px flex-1" />
            </div>
          );
        }
        const time = format.dateTime(new Date(m.createdAt), {
          hour: '2-digit',
          minute: '2-digit',
        });
        const ours = b.side === 'ours';
        const receipt = receiptLine(m);
        return (
          <div
            key={m.id}
            className={cn('flex flex-col', ours ? 'items-end' : 'items-start')}
          >
            <p className="text-muted-foreground mb-0.5 flex items-center gap-1.5 text-xs">
              <span className="text-foreground font-medium">{b.name}</span>
              {b.tag && (
                <span
                  className={cn(
                    'rounded px-1.5 py-px text-xs font-semibold',
                    b.tag === 'bank'
                      ? 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {b.tag === 'bank' && b.bank
                    ? t('tag.bankOf', { bank: b.bank })
                    : t(`tag.${b.tag}`)}
                </span>
              )}
              <span>· {time}</span>
            </p>
            <div
              className={cn(
                'max-w-[80%] rounded-lg px-3 py-2',
                ours ? 'bg-success-soft' : 'bg-muted'
              )}
            >
              {text}
            </div>
            {receipt && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {receipt.key === 'reached'
                  ? t('receipts.reached', {
                      delivered: receipt.delivered,
                      read: receipt.read,
                    })
                  : t(`receipts.${receipt.key}`)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Free text inside the window; an approved template (confirmed) outside it. */
function GroupComposer({
  roomId,
  mode,
  audience,
}: {
  roomId: string;
  mode: GroupComposerMode;
  audience: number;
}) {
  const t = useTranslations('Chat.rooms');
  const tPicker = useTranslations('Inbox.templatePicker');
  const { sb } = useChatWorkspaceContext();
  const { accountId } = useAuth();
  const [text, setText] = useState('');
  // What is in the box now: the box stays live while a send is in flight.
  const textRef = useRef(text);
  const [busy, setBusy] = useState(false);
  // The last send may be in the group: said until the next one starts.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [templates, setTemplates] = useState<RoomTemplateRow[] | null>(null);
  const [picked, setPicked] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const valuesRef = useRef(values);
  const pickedRef = useRef(picked);
  useEffect(() => {
    textRef.current = text;
    valuesRef.current = values;
    pickedRef.current = picked;
  }, [text, values, picked]);
  const [confirming, setConfirming] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const wantTemplates = mode.mode === 'template' && !!accountId;

  useEffect(() => {
    if (!wantTemplates) return;
    let off = false;
    void Promise.resolve(
      sb
        .from('message_templates')
        .select(
          'id, name, language, body_text, status, meta_template_id, submission_error, created_at'
        )
        .eq('account_id', accountId)
        .order('name')
    ).then(({ data }) => {
      if (!off) setTemplates((data ?? []) as RoomTemplateRow[]);
    });
    return () => {
      off = true;
    };
  }, [sb, accountId, wantTemplates]);

  const options = useMemo(
    () => roomTemplateOptions(templates ?? []),
    [templates]
  );
  const template =
    options.find((o) => !o.reason && o.template.id === picked)?.template ??
    null;
  const count = templateParamCount(template?.body_text);
  const filled = values.slice(0, count);
  const ready =
    !!template && filled.length === count && filled.every((v) => v.trim());

  // A file goes as multipart form data, its caption the typed text. True
  // when it went out: what was typed is kept otherwise.
  const send = async (body: Record<string, unknown> | FormData) => {
    setBusy(true);
    setUnconfirmed(false);
    const answer = await fetch(
      `/api/deal-rooms/${roomId}/messages`,
      body instanceof FormData
        ? { method: 'POST', body }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
    ).then(
      async (res) => ({
        status: res.status,
        body: (await res.json().catch(() => null)) as unknown,
      }),
      () => null
    );
    setBusy(false);
    const outcome = roomSendOutcome(answer);
    setUnconfirmed(outcome.kind === 'unconfirmed');
    // Not left open on a Confirm that would send it twice.
    if (outcome.kind === 'unconfirmed') setConfirming(false);
    if (outcome.kind === 'refused') {
      toast.error(t(`composer.errors.${outcome.error}`));
    }
    if (outcome.kind === 'notRecorded') {
      toast.warning(t('composer.notRecorded'), { duration: 15_000 });
    }
    return outcome.kind === 'sent' || outcome.kind === 'notRecorded';
  };

  const pick = (picked: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!picked) return;
    const check = checkRoomMedia(picked);
    if (!check.ok) {
      toast.error(
        check.code === 'media_type'
          ? t('composer.errors.media_type')
          : t('composer.fileTooBig', {
              name: picked.name,
              mb: Math.round(check.maxBytes / 1024 / 1024),
            })
      );
      return;
    }
    setFile(picked);
  };

  if (mode.mode === 'disabled') {
    return (
      <div className="text-muted-foreground border-t px-4 py-3 text-center text-sm">
        {t(`banner.${mode.reason}`)}
      </div>
    );
  }
  return (
    <div className="border-warning/50 bg-warning-soft m-3 rounded-lg border p-3">
      <p className="text-warning text-sm font-bold">
        {t('composer.label', { count: audience })}
      </p>
      {unconfirmed && (text.trim() || file || template) && (
        <p
          role="alert"
          className="bg-destructive-soft text-destructive mt-2 rounded-md px-2.5 py-1.5 text-sm"
        >
          {t('composer.errors.unconfirmed')}
        </p>
      )}
      {mode.mode === 'text' ? (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            // What was typed on while the post was in flight stays.
            const left = (sent: string) =>
              draftAfterSend(
                { text: textRef.current, picked: [] },
                { text: sent, picked: [] }
              ).text;
            const sent = text;
            if (file) {
              const form = new FormData();
              form.set('file', file);
              if (text.trim()) form.set('caption', text);
              if (await send(form)) {
                setFile(null);
                setText(left(sent));
              }
            } else if (text.trim() && (await send({ text }))) {
              setText(left(sent));
            }
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ROOM_MEDIA_ACCEPT}
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={busy}
            aria-label={t('composer.attach')}
            title={t('composer.attach')}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 space-y-1">
            {file && (
              <span className="bg-background inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
                <FileText className="size-3.5 shrink-0" />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={t('composer.removeFile', { name: file.name })}
                  title={t('composer.removeFile', { name: file.name })}
                  disabled={busy}
                  onClick={() => setFile(null)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              maxLength={file ? ROOM_MEDIA_CAPTION_MAX : 4096}
              placeholder={t(
                file ? 'composer.captionPlaceholder' : 'composer.placeholder'
              )}
              aria-label={t(
                file ? 'composer.captionPlaceholder' : 'composer.placeholder'
              )}
              className="bg-card dark:bg-background block w-full resize-none rounded-md border px-2.5 py-1.5 text-sm outline-none"
            />
          </div>
          <Button
            type="submit"
            disabled={busy || (!file && !text.trim())}
            className="bg-amber-800 text-white hover:bg-amber-900"
          >
            {t('composer.send')}
          </Button>
        </form>
      ) : (
        <div className="mt-2 space-y-2">
          <select
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
              setValues([]);
            }}
            aria-label={t('composer.templatePick')}
            className="bg-card dark:bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="">
              {templates && options.every((o) => o.reason)
                ? t('composer.noTemplates')
                : t('composer.templatePick')}
            </option>
            {options.map(({ template: x, reason }) => (
              <option key={x.id} value={x.id} disabled={reason !== null}>
                {x.name} · {x.language}
                {reason &&
                  ` · ${
                    reason === 'not_linked'
                      ? t('composer.templateNotLinked')
                      : tPicker(`blocked.${reason}`)
                  }`}
              </option>
            ))}
          </select>
          {template && (
            <>
              <p className="bg-background rounded-md border px-2.5 py-1.5 text-sm whitespace-pre-wrap">
                {renderTemplateBody(template.body_text ?? '', filled)}
              </p>
              {Array.from({ length: count }, (_, i) => (
                <input
                  key={i}
                  value={values[i] ?? ''}
                  onChange={(e) => {
                    const next = [...values];
                    next[i] = e.target.value;
                    setValues(next);
                  }}
                  placeholder={t('composer.param', { n: i + 1 })}
                  aria-label={t('composer.param', { n: i + 1 })}
                  className="bg-card dark:bg-background w-full rounded-md border px-2.5 py-1.5 text-sm"
                />
              ))}
            </>
          )}
          <Button
            type="button"
            disabled={busy || !ready}
            onClick={() => setConfirming(true)}
            className="bg-amber-800 text-white hover:bg-amber-900"
          >
            {t('composer.review')}
          </Button>
        </div>
      )}
      <p className="text-muted-foreground mt-2 text-xs">
        {t(
          mode.mode === 'text' ? 'composer.footer' : 'composer.templateFooter'
        )}
      </p>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('composer.confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('composer.confirmBody', { count: audience })}
            </DialogDescription>
          </DialogHeader>
          {template && (
            <p className="bg-muted rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
              {renderTemplateBody(template.body_text ?? '', filled)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('composer.cancel')}
            </Button>
            <Button
              disabled={busy || !ready}
              onClick={async () => {
                if (!template) return;
                const sentPicked = picked;
                const sentValues = values;
                const ok = await send({
                  templateName: template.name,
                  language: template.language,
                  ...(count ? { params: filled } : {}),
                });
                if (ok) {
                  setConfirming(false);
                  // Only what was sent is cleared, not a pick made since.
                  if (
                    pickedRef.current === sentPicked &&
                    valuesRef.current === sentValues
                  ) {
                    setPicked('');
                    setValues([]);
                  }
                }
              }}
              className="bg-amber-800 text-white hover:bg-amber-900"
            >
              {t('composer.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
