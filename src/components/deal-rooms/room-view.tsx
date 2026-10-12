'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowLeft, Eye, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { ChannelView } from '@/components/chat/channel-view';
import { useChatWorkspaceContext } from '@/components/chat/chat-context';
import { Composer } from '@/components/chat/composer';
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
import type {
  MessagePage,
  RoomDetail,
  RoomMessage,
} from '@/lib/deal-rooms/reads';
import {
  bubbleOf,
  groupAudience,
  groupComposerMode,
  mergeRoomMessages,
  receiptLine,
  roomPhase,
  roomTitle,
  templateParamCount,
  windowCountdown,
  type GroupComposerMode,
} from '@/lib/deal-rooms/view';
import { rightColumn, withRightColumn } from '@/lib/chat/panels';
import { renderTemplateBody } from '@/lib/whatsapp/template-body';
import { cn } from '@/lib/utils';

export interface RoomContext {
  detail: RoomDetail;
  reload: () => Promise<void>;
}

export interface DealRoomViewProps {
  roomId: string;
  /** The right column: the Members panel (a later job). */
  membersPanel?: (ctx: RoomContext) => React.ReactNode;
  /** Beside the tabs: room actions (invite link, close…; a later job). */
  headerActions?: (ctx: RoomContext) => React.ReactNode;
}

const SEND_ERRORS = new Set([
  'window_closed',
  'room_not_open',
  'group_not_ready',
  'group_suspended',
  'template_rejected',
  'forbidden',
]);

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
      if (res.status === 404) return setState('gone');
      if (!res.ok) throw new Error(String(res.status));
      setDetail((await res.json()) as RoomDetail);
      setState('ok');
    } catch {
      setState((s) => (s === 'ok' ? s : 'error'));
    }
  }, [roomId]);
  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload]);
  useTableSignal(
    ws.sb,
    ['deal_rooms', 'deal_room_participants'],
    (table) =>
      table === 'deal_rooms' ? `id=eq.${roomId}` : `room_id=eq.${roomId}`,
    reload
  );
  // A guest cannot read `deal_rooms`, so that signal never reaches them.
  useGuestRefresh(detail?.access === 'guest', reload);

  if (!detail) {
    return (
      <p className="text-muted-foreground p-8 text-center text-sm">
        {state === 'gone'
          ? t('rooms.notFound')
          : state === 'error'
            ? t('rooms.loadFailed')
            : ''}
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
  const mode = groupComposerMode({ ...room, now });

  const layout = (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Link
              href="/chat/rooms"
              className="hover:bg-muted -ml-1 rounded p-1 lg:hidden"
              aria-label={t('channel.back')}
            >
              <ArrowLeft className="size-4" />
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
            <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 [[data-mode=dark]_&]:border-amber-500/40 [[data-mode=dark]_&]:bg-amber-500/10 [[data-mode=dark]_&]:text-amber-100">
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
                {t(`rooms.banner.${phase}`)}
              </p>
            )}
            <GroupTimeline roomId={roomId} />
            <GroupComposer
              roomId={roomId}
              mode={mode}
              audience={groupAudience(room.participantCount)}
            />
          </>
        ) : (
          <>
            <div className="px-4 pt-3">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-[#0E7C5A] [[data-mode=dark]_&]:bg-emerald-500/15 [[data-mode=dark]_&]:text-emerald-300">
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
  const [messages, setMessages] = useState<RoomMessage[] | null>(null);
  const [older, setOlder] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The first page sets where paging older starts; refreshes do not.
  const first = useRef(false);
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
  const refresh = useCallback(async () => {
    try {
      const p = await page(null);
      const el = box.current;
      if (!el || el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
        anchor.current = 'bottom';
      }
      if (!first.current) {
        first.current = true;
        setOlder(p.nextBefore);
      }
      setMessages((prev) => mergeRoomMessages(prev ?? [], p.messages));
    } catch {
      setMessages((prev) => prev ?? []);
    }
  }, [page]);
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);
  useTableSignal(sb, ['group_messages'], () => `room_id=eq.${roomId}`, refresh);

  const loadOlder = async () => {
    if (!older || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const p = await page(older);
      const el = box.current;
      if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setOlder(p.nextBefore);
      setMessages((prev) => mergeRoomMessages(prev ?? [], p.messages));
    } catch {
      // The button stays; the next scroll tries again.
    } finally {
      setLoadingOlder(false);
    }
  };

  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current;
    if (!el || !a || messages === null) return;
    el.scrollTop =
      a === 'bottom' ? el.scrollHeight : el.scrollHeight - a.height + a.top;
    anchor.current = null;
  }, [messages]);

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
              <p className="text-muted-foreground text-[11px] font-medium">
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
                <p className="text-muted-foreground text-[11px]">
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
            <p className="text-muted-foreground mb-0.5 flex items-center gap-1.5 text-[11px]">
              <span className="text-foreground font-medium">{b.name}</span>
              {b.tag && (
                <span
                  className={cn(
                    'rounded px-1.5 py-px text-[10px] font-semibold',
                    b.tag === 'bank'
                      ? 'bg-violet-100 text-violet-800 [[data-mode=dark]_&]:bg-violet-500/20 [[data-mode=dark]_&]:text-violet-200'
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
                ours
                  ? 'bg-emerald-50 [[data-mode=dark]_&]:bg-emerald-500/15'
                  : 'bg-muted'
              )}
            >
              {text}
            </div>
            {receipt && (
              <p className="text-muted-foreground mt-0.5 text-[11px]">
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

interface TemplateRow {
  id: string;
  name: string;
  language: string;
  body_text: string | null;
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
  const { sb } = useChatWorkspaceContext();
  const { accountId } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [picked, setPicked] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const wantTemplates = mode.mode === 'template' && !!accountId;

  useEffect(() => {
    if (!wantTemplates) return;
    let off = false;
    void Promise.resolve(
      sb
        .from('message_templates')
        .select('id, name, language, body_text, meta_template_id')
        .eq('account_id', accountId)
        .eq('status', 'APPROVED')
        .not('meta_template_id', 'is', null)
        .order('name')
    ).then(({ data }) => {
      if (!off) setTemplates((data ?? []) as TemplateRow[]);
    });
    return () => {
      off = true;
    };
  }, [sb, accountId, wantTemplates]);

  const template = templates?.find((x) => x.id === picked) ?? null;
  const count = templateParamCount(template?.body_text);
  const filled = values.slice(0, count);
  const ready =
    !!template && filled.length === count && filled.every((v) => v.trim());

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/deal-rooms/${roomId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { code } = (await res.json().catch(() => ({}))) as {
          code?: string;
        };
        toast.error(
          t(
            `composer.errors.${code && SEND_ERRORS.has(code) ? code : 'generic'}`
          )
        );
        return false;
      }
      return true;
    } catch {
      toast.error(t('composer.errors.generic'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (mode.mode === 'disabled') {
    return (
      <div className="text-muted-foreground border-t px-4 py-3 text-center text-sm">
        {t(`banner.${mode.reason}`)}
      </div>
    );
  }
  return (
    <div className="m-3 rounded-lg border border-amber-400 bg-amber-50/70 p-3 [[data-mode=dark]_&]:border-amber-500/50 [[data-mode=dark]_&]:bg-amber-500/10">
      <p className="text-sm font-bold text-amber-900 [[data-mode=dark]_&]:text-amber-200">
        {t('composer.label', { count: audience })}
      </p>
      {mode.mode === 'text' ? (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim() && (await send({ text }))) setText('');
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={4096}
            placeholder={t('composer.placeholder')}
            aria-label={t('composer.placeholder')}
            className="bg-background min-w-0 flex-1 resize-none rounded-md border px-2.5 py-1.5 text-sm outline-none"
          />
          <Button
            type="submit"
            disabled={busy || !text.trim()}
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
            className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="">
              {templates && templates.length === 0
                ? t('composer.noTemplates')
                : t('composer.templatePick')}
            </option>
            {templates?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {x.language}
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
                  className="bg-background w-full rounded-md border px-2.5 py-1.5 text-sm"
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
      <p className="text-muted-foreground mt-2 text-[11px]">
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
                const ok = await send({
                  templateName: template.name,
                  language: template.language,
                  ...(count ? { params: filled } : {}),
                });
                if (ok) {
                  setConfirming(false);
                  setPicked('');
                  setValues([]);
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
