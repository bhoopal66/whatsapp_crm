'use client';

// /contacts/[id] — one customer's calls, WhatsApp, notes and internal
// shares on one timeline, with their open tasks, the team on them and
// this month's calls (module 015). Every read is the viewer's own (RLS
// or the viewer's API routes), so it shows only what they may see.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Hash,
  MessageCircle,
  Phone,
  PhoneMissed,
  StickyNote,
} from 'lucide-react';

import { ShareCallButton } from '@/components/chat/share-to-chat-dialog';
import { DealRoomLinks } from '@/components/deal-rooms/room-links';
import { CallButton } from '@/components/pbx/call-button';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { ConsentFields } from '@/lib/pbx/call-ui';
import {
  TIMELINE_FILTERS,
  callTone,
  entryHeading,
  filterTimeline,
  groupByDay,
  initials,
  maskPhone,
  mergeTimeline,
  missedTaskFor,
  monthSummaryParts,
  openTaskLine,
  putComposerPrefill,
  recentPeople,
  sessionStore,
  sourcesToPage,
  taskStrip,
  teamOnCustomer,
  timelineHorizon,
  withinHorizon,
  type MonthTotals,
  type Part,
  type TimelineCall,
  type TimelineEntry,
  type TimelineFilter,
  type TimelinePaging,
  type TimelineSource,
  type TimelineTask,
} from '@/lib/pbx/timeline';
import { PresenceDot } from '@/components/presence/presence-dot';
import { usePhonePresence } from '@/hooks/use-phone-presence';
import { usePresence } from '@/hooks/use-presence';
import { PERSON_PRESENCE_KEY, presenceOf } from '@/lib/person-presence';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

import { RecordingPlayer } from './recording-player';

const PAGE = 50;
type Sb = ReturnType<typeof createClient>;

interface Customer extends ConsentFields {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  user_id: string | null;
}
interface Basics {
  contact: Customer;
  conversation: { id: string; assignedTo: string | null } | null;
  deal: { id: string; title: string; stage: string | null } | null;
}
interface RawMessage {
  id: string;
  sender_type: string;
  sender_id: string | null;
  content_text: string | null;
  content_type: string;
  created_at: string;
}
interface RawNote {
  id: string;
  note_text: string;
  user_id: string | null;
  created_at: string;
}
interface RawPost {
  id: string;
  channelName: string;
  authorId: string | null;
  body: string;
  createdAt: string;
}
interface Rows {
  calls: TimelineCall[];
  messages: RawMessage[];
  notes: RawNote[];
  internal: RawPost[];
}
type Load =
  | { state: 'loading' | 'failed' | 'missing' }
  | ({ state: 'ready'; rows: Rows; paging: TimelinePaging } & Basics);
interface Side {
  tasks: TimelineTask[];
  summary: MonthTotals | null;
}

const getJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });
const must = (r: { data: unknown; error: { message: string } | null }) => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
const atOf: Record<TimelineSource, (row: never) => string> = {
  calls: (r: TimelineCall) => r.startedAt,
  messages: (r: RawMessage) => r.created_at,
  notes: (r: RawNote) => r.created_at,
  internal: (r: RawPost) => r.createdAt,
};

/** One page of a source, older than `before` (exclusive) when given. */
async function readPage(
  sb: Sb,
  source: Exclude<TimelineSource, 'internal'>,
  ids: { contactId: string; conversationId: string | null },
  before: string | null
): Promise<unknown[]> {
  if (source === 'calls') {
    const q = new URLSearchParams({
      contactId: ids.contactId,
      scope: 'all',
      limit: String(PAGE),
    });
    if (before) q.set('to', before);
    return (await getJson(`/api/pbx/calls?${q}`)).calls ?? [];
  }
  if (source === 'messages' && !ids.conversationId) return [];
  let q =
    source === 'messages'
      ? sb
          .from('messages')
          .select(
            'id, sender_type, sender_id, content_text, content_type, created_at'
          )
          .eq('conversation_id', ids.conversationId as string)
      : sb
          .from('contact_notes')
          .select('id, note_text, user_id, created_at')
          .eq('contact_id', ids.contactId);
  if (before) q = q.lt('created_at', before);
  return must(
    await q.order('created_at', { ascending: false }).limit(PAGE)
  ) as unknown[];
}

/** Internal-chat posts that shared this customer's chat (one read). */
async function readShares(sb: Sb, conversationId: string): Promise<RawPost[]> {
  const shared = must(
    await sb
      .from('shared_conversations')
      .select('message_id')
      .eq('conversation_id', conversationId)
  ) as { message_id: string }[];
  if (!shared.length) return [];
  const posts = must(
    await sb
      .from('internal_messages')
      .select('id, channel_id, author_id, body, created_at')
      .in('id', [...new Set(shared.map((s) => s.message_id))])
      .is('deleted_at', null)
      .is('erased_at', null)
  ) as {
    id: string;
    channel_id: string;
    author_id: string | null;
    body: string;
    created_at: string;
  }[];
  const channelIds = [...new Set(posts.map((p) => p.channel_id))];
  const channels = channelIds.length
    ? (must(
        await sb.from('chat_channels').select('id, name').in('id', channelIds)
      ) as { id: string; name: string }[])
    : [];
  const name = new Map(channels.map((c) => [c.id, c.name]));
  return posts
    .filter((p) => name.has(p.channel_id))
    .map((p) => ({
      id: p.id,
      channelName: name.get(p.channel_id) as string,
      authorId: p.author_id,
      body: p.body,
      createdAt: p.created_at,
    }));
}

const paged = (source: TimelineSource, rows: unknown[]) => ({
  oldest: rows.length ? atOf[source](rows[rows.length - 1] as never) : null,
  more: rows.length === PAGE,
});

export function CustomerPage({ contactId }: { contactId: string }) {
  const tl = useTranslations('CustomerTimeline');
  const locale = useLocale();
  const router = useRouter();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [side, setSide] = useState<Side>({
    tasks: [],
    summary: null,
  });
  // Live, shared with any other dot on the page: the phone's call or
  // chosen status over the app's (lib/person-presence.ts).
  const phone = usePhonePresence();
  const { getPresence } = usePresence();
  const [names, setNames] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [paging, setPaging] = useState(false);
  const [ticking, setTicking] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const sentinel = useRef<HTMLDivElement>(null);
  const say = (p: Part) =>
    typeof p === 'string' ? p : tl(p.key as never, p.values as never);

  useEffect(() => {
    let live = true;
    const sb = createClient();
    void (async () => {
      const [c, conv, deal] = await Promise.all([
        sb
          .from('contacts')
          .select(
            'id, name, company, phone, user_id, do_not_contact_at, do_not_contact_reason, marketing_opt_in_at, opted_out_at'
          )
          .eq('id', contactId)
          .maybeSingle(),
        sb
          .from('conversations')
          .select('id, assigned_agent_id')
          .eq('contact_id', contactId)
          .limit(1),
        sb
          .from('deals')
          .select('id, title, stage:pipeline_stages(name)')
          .eq('contact_id', contactId)
          .eq('status', 'open')
          .order('created_at', { ascending: false })
          .limit(1),
      ]);
      const contact = must(c) as Customer | null;
      if (!contact) return live && setLoad({ state: 'missing' });
      const cv = (
        must(conv) as { id: string; assigned_agent_id: string | null }[]
      )[0];
      const d = (
        must(deal) as unknown as {
          id: string;
          title: string;
          stage: { name: string } | null;
        }[]
      )[0];
      const ids = { contactId, conversationId: cv?.id ?? null };
      const [calls, messages, notes, internal] = await Promise.all([
        readPage(sb, 'calls', ids, null),
        readPage(sb, 'messages', ids, null),
        readPage(sb, 'notes', ids, null),
        cv ? readShares(sb, cv.id).catch(() => []) : [],
      ]);
      if (!live) return;
      setLoad({
        state: 'ready',
        contact,
        conversation: cv
          ? { id: cv.id, assignedTo: cv.assigned_agent_id }
          : null,
        deal: d
          ? { id: d.id, title: d.title, stage: d.stage?.name ?? null }
          : null,
        rows: {
          calls: calls as TimelineCall[],
          messages: messages as RawMessage[],
          notes: notes as RawNote[],
          internal,
        },
        paging: {
          calls: paged('calls', calls),
          messages: paged('messages', messages),
          notes: paged('notes', notes),
          internal: { oldest: null, more: false },
        },
      });
    })().catch(() => live && setLoad({ state: 'failed' }));
    return () => {
      live = false;
    };
  }, [contactId]);

  useEffect(() => {
    let live = true;
    void Promise.all([
      getJson(`/api/tasks?scope=contact&contactId=${contactId}&status=open`)
        .then((b) => (b.tasks ?? []) as TimelineTask[])
        .catch(() => []),
      getJson(
        `/api/pbx/calls/summary?contactId=${contactId}&tz=${encodeURIComponent(timeZone)}`
      ).catch(() => null),
    ]).then(([tasks, summary]) => {
      if (live) setSide({ tasks, summary });
    });
    return () => {
      live = false;
    };
  }, [contactId, timeZone]);

  const ready = load.state === 'ready' ? load : null;
  const all = useMemo(() => {
    if (!ready) return [];
    const r = ready.rows;
    return mergeTimeline({
      calls: r.calls,
      messages: r.messages.map((m) => ({
        id: m.id,
        senderType: m.sender_type,
        senderId: m.sender_id,
        senderName: (m.sender_id && names[m.sender_id]) || null,
        text: m.content_text,
        contentType: m.content_type,
        createdAt: m.created_at,
      })),
      notes: r.notes.map((n) => ({
        id: n.id,
        text: n.note_text,
        authorName: (n.user_id && names[n.user_id]) || null,
        createdAt: n.created_at,
      })),
      internal: r.internal.map((p) => ({
        id: p.id,
        channelId: '',
        channelName: p.channelName,
        authorName: (p.authorId && names[p.authorId]) || null,
        body: p.body,
        createdAt: p.createdAt,
      })),
    });
  }, [ready, names]);
  const team = ready
    ? teamOnCustomer({
        ownerId: ready.contact.user_id,
        assigneeId: ready.conversation?.assignedTo ?? null,
        recent: recentPeople(all),
      })
    : [];

  // Names of everyone the page mentions, each asked for once.
  const wanted = ready
    ? [
        ...team.map((p) => p.userId),
        ...ready.rows.notes.map((n) => n.user_id),
        ...ready.rows.internal.map((p) => p.authorId),
        ...side.tasks.map((t) => t.assigned_to),
      ].filter((id): id is string => !!id && !asked.current.has(id))
    : [];
  const wantedKey = [...new Set(wanted)].sort().join(',');
  useEffect(() => {
    if (!wantedKey) return;
    const ids = wantedKey.split(',');
    ids.forEach((id) => asked.current.add(id));
    void createClient()
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', ids)
      .then(({ data }) => {
        const found = (data ?? []) as { user_id: string; full_name: string }[];
        if (found.length)
          setNames((prev) => ({
            ...prev,
            ...Object.fromEntries(found.map((p) => [p.user_id, p.full_name])),
          }));
      });
  }, [wantedKey]);

  const horizon = ready ? timelineHorizon(ready.paging, filter) : null;
  const toPage = ready ? sourcesToPage(ready.paging, filter) : [];
  const visible = withinHorizon(filterTimeline(all, filter), horizon);

  const loadMore = async () => {
    if (!ready || paging || !toPage.length) return;
    setPaging(true);
    try {
      const sb = createClient();
      const ids = {
        contactId,
        conversationId: ready.conversation?.id ?? null,
      };
      const pages = await Promise.all(
        toPage.map((s) =>
          readPage(
            sb,
            s as Exclude<TimelineSource, 'internal'>,
            ids,
            ready.paging[s]?.oldest ?? null
          )
        )
      );
      setLoad((prev) => {
        if (prev.state !== 'ready') return prev;
        const rows = { ...prev.rows };
        const next = { ...prev.paging };
        toPage.forEach((s, i) => {
          const have = new Set((rows[s] as { id: string }[]).map((r) => r.id));
          const fresh = (pages[i] as { id: string }[]).filter(
            (r) => !have.has(r.id)
          );
          (rows as Record<string, unknown[]>)[s] = [...rows[s], ...fresh];
          next[s] = paged(s, pages[i]).oldest
            ? paged(s, pages[i])
            : { oldest: prev.paging[s]?.oldest ?? null, more: false };
        });
        return { ...prev, rows, paging: next };
      });
    } catch {
      toast.error(tl('loadFailed'));
    } finally {
      setPaging(false);
    }
  };
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  });
  const canPage = toPage.length > 0;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canPage) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) void loadMoreRef.current();
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canPage, visible.length]);

  if (load.state !== 'ready')
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
        <BackLink label={tl('back')} />
        {load.state === 'loading' ? (
          <div className="bg-muted h-24 animate-pulse rounded-xl" aria-hidden />
        ) : (
          <p className="text-muted-foreground text-sm">
            {load.state === 'missing' ? tl('notFound') : tl('loadFailed')}
          </p>
        )}
      </div>
    );

  const { contact, conversation, deal } = load;
  const title = contact.company || contact.name || maskPhone(contact.phone);
  const ownerName = contact.user_id ? names[contact.user_id] : null;
  const subline = [
    contact.company && contact.name
      ? `${contact.name} ${tl('ownerSuffix')}`
      : null,
    maskPhone(contact.phone) || null,
    ownerName ? tl('ownerRm', { name: ownerName }) : null,
  ].filter(Boolean);

  const draftWhatsApp = () => {
    if (!conversation) return void toast.error(tl('noConversation'));
    putComposerPrefill(sessionStore(), conversation.id, tl('missedDraft'));
    router.push(`/inbox?c=${conversation.id}`);
  };
  const tickTask = async (task: TimelineTask) => {
    setTicking(task.id);
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }).catch(() => null);
    setTicking(null);
    if (!res?.ok) return void toast.error(tl('taskFailed'));
    toast.success(tl('taskDone'));
    setSide((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => t.id !== task.id),
    }));
  };
  const dateLabel = (key: string) =>
    new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${key}T12:00:00Z`));

  const entry = (e: TimelineEntry) => {
    const h = entryHeading(e, { timeZone, locale, contactName: contact.name });
    const missed = e.kind === 'call' && callTone(e.call) === 'missed';
    const [Icon, tone] =
      e.kind === 'call'
        ? missed
          ? [
              PhoneMissed,
              'bg-red-100 text-red-600 [[data-mode=dark]_&]:bg-red-950 [[data-mode=dark]_&]:text-red-300',
            ]
          : [
              Phone,
              'bg-emerald-100 text-emerald-700 [[data-mode=dark]_&]:bg-emerald-950 [[data-mode=dark]_&]:text-emerald-300',
            ]
        : e.kind === 'whatsapp'
          ? [
              MessageCircle,
              'bg-green-100 text-green-700 [[data-mode=dark]_&]:bg-green-950 [[data-mode=dark]_&]:text-green-300',
            ]
          : e.kind === 'note'
            ? [
                StickyNote,
                'bg-amber-100 text-amber-800 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-300',
              ]
            : [
                Hash,
                'bg-sky-100 text-sky-700 [[data-mode=dark]_&]:bg-sky-950 [[data-mode=dark]_&]:text-sky-300',
              ];
    const task =
      missed && e.kind === 'call' ? missedTaskFor(e.call.id, side.tasks) : null;
    const text =
      e.kind === 'whatsapp'
        ? e.message.text
        : e.kind === 'note'
          ? e.note.text
          : e.kind === 'internal'
            ? e.post.body
            : e.call.notes;
    return (
      <li key={`${e.kind}:${e.id}`} className="flex gap-3">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            tone
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-semibold">{say(h.label)}</span>
            <span className="text-muted-foreground">
              {h.details.map((d) => ` · ${say(d)}`).join('')}
            </span>
          </p>
          {text ? (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {text}
            </p>
          ) : (
            e.kind === 'whatsapp' && (
              <p className="text-muted-foreground mt-1 text-sm italic">
                {tl('mediaMessage')}
              </p>
            )
          )}
          {missed && (
            <div
              className={cn(
                'mt-2 flex flex-wrap items-center gap-2 rounded-lg',
                task &&
                  'border border-amber-300 bg-amber-50 px-3 py-2 [[data-mode=dark]_&]:border-amber-800 [[data-mode=dark]_&]:bg-amber-950/40'
              )}
            >
              {task && (
                <span className="flex-1 text-sm text-amber-900 [[data-mode=dark]_&]:text-amber-200">
                  {say(
                    taskStrip(
                      task,
                      (task.assigned_to && names[task.assigned_to]) || null,
                      timeZone
                    )
                  )}
                </span>
              )}
              <CallButton contact={contact} label={tl('callBack')} size="xs" />
              <Button size="xs" variant="outline" onClick={draftWhatsApp}>
                {tl('draftWhatsApp')}
              </Button>
            </div>
          )}
          {e.kind === 'call' && !missed && (
            <RecordingPlayer call={e.call} dealId={deal?.id ?? null} />
          )}
        </div>
        {e.kind === 'call' && (
          <ShareCallButton
            callId={e.call.id}
            recordingState={e.call.recordingState}
          />
        )}
      </li>
    );
  };

  const month = side.summary ? monthSummaryParts(side.summary) : null;
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <BackLink label={tl('back')} />
      <header className="flex flex-wrap items-start gap-4">
        <div className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl text-base font-semibold">
          {initials(title)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold">{title}</h1>
          {subline.length > 0 && (
            <p className="text-muted-foreground text-sm">
              {subline.join(' · ')}
            </p>
          )}
          {deal && (
            <span className="mt-1.5 inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-200">
              {[deal.title, deal.stage].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <CallButton contact={contact} conversationId={conversation?.id} />
          {conversation ? (
            <Link
              href={`/inbox?c=${conversation.id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <MessageCircle className="size-4" />
              {tl('whatsappButton')}
            </Link>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled
              title={tl('noConversation')}
            >
              <MessageCircle className="size-4" />
              {tl('whatsappButton')}
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0 space-y-4">
          <nav className="flex flex-wrap gap-2">
            {TIMELINE_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm',
                  filter === f
                    ? 'bg-foreground text-background border-transparent'
                    : 'border-border text-muted-foreground hover:bg-muted'
                )}
              >
                {tl(`filters.${f}`)}
              </button>
            ))}
          </nav>
          {visible.length === 0 && !canPage ? (
            <p className="text-muted-foreground text-sm">{tl('empty')}</p>
          ) : (
            groupByDay(visible, (e) => e.at, Date.now(), timeZone).map((g) => (
              <section key={g.key} className="space-y-3">
                <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  {g.label === 'date' ? dateLabel(g.key) : tl(g.label)}
                </h2>
                <ul className="space-y-4">{g.items.map(entry)}</ul>
              </section>
            ))
          )}
          {canPage && (
            <div ref={sentinel} className="flex justify-center py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={paging}
                onClick={() => void loadMore()}
              >
                {tl('loadMore')}
              </Button>
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <Card title={tl('openTasks')}>
            {side.tasks.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {tl('noOpenTasks')}
              </p>
            ) : (
              <ul className="space-y-2">
                {side.tasks.map((task) => (
                  <li key={task.id} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={false}
                      disabled={ticking === task.id}
                      onCheckedChange={() => void tickTask(task)}
                      aria-label={task.title}
                      className="mt-0.5"
                    />
                    <span>{say(openTaskLine(task, timeZone))}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <DealRoomLinks
            contact={contact}
            frame={(title, body) => <Card title={title}>{body}</Card>}
          />
          <Card title={tl('team')}>
            {team.length === 0 ? (
              <p className="text-muted-foreground text-sm">{tl('noTeam')}</p>
            ) : (
              <ul className="space-y-2">
                {team.map((p) => {
                  const state = presenceOf(p.userId, phone, getPresence);
                  return (
                    <li
                      key={p.userId}
                      className="flex items-center gap-2 text-sm"
                    >
                      <PresenceDot status={state} className="size-2.5" />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {names[p.userId] ?? '—'}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {tl(`roles.${p.role}`)} ·{' '}
                        {tl(`presence.${PERSON_PRESENCE_KEY[state]}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title={tl('thisMonth')}>
            {month ? (
              <div className="space-y-1 text-sm">
                <p>{say(month.counts)}</p>
                <p className="text-muted-foreground">{say(month.talk)}</p>
              </div>
            ) : (
              <div
                className="bg-muted h-10 animate-pulse rounded"
                aria-hidden
              />
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/contacts"
      className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline"
    >
      <ArrowLeft className="size-4" />
      {label}
    </Link>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-xl border p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
