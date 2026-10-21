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
  Trash2,
} from 'lucide-react';

import { ShareCallButton } from '@/components/chat/share-to-chat-dialog';
import { DealRoomLinks } from '@/components/deal-rooms/room-links';
import { MemoryPanel } from '@/components/memory/memory-panel';
import { useContactOutreach } from '@/components/contacts/contact-outreach';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactJourneySections } from '@/components/journeys/contact-journey';
import { CallButton } from '@/components/pbx/call-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { ConsentFields } from '@/lib/pbx/call-ui';
import {
  COMPOSER_PREFILL_EVENT,
  TIMELINE_FILTERS,
  callTone,
  entryHeading,
  filterTimeline,
  groupByDay,
  mergeTimeline,
  missedDraftOffer,
  missedDraftText,
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
import { useAuth } from '@/hooks/use-auth';
import { usePhonePresence } from '@/hooks/use-phone-presence';
import { usePresence } from '@/hooks/use-presence';
import { PERSON_PRESENCE_KEY, presenceOf } from '@/lib/person-presence';
import { useChatTags } from '@/hooks/use-chat-tags';
import { canSendMessages, hasMinRole } from '@/lib/auth/roles';
import {
  useAccountNumbers,
  useMyNumberIds,
} from '@/hooks/use-whatsapp-numbers';
import { contactChatTagChip } from '@/lib/contacts/chat-tag-column';
import {
  loadContactThread,
  NO_THREAD,
  type ContactThread,
} from '@/lib/contacts/contact-thread';
import { customerAccess } from '@/lib/contacts/customer-access';
import { contactsListPath } from '@/lib/contacts/customer-links';
import { predictSendChannels } from '@/lib/contacts/predict-send-channels';
import type { Contact } from '@/types';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

import {
  DealsCard,
  DetailsCard,
  NoteComposer,
  SideCard as Card,
  type SavedNote,
} from './customer/customer-cards';
import { CasesCard } from './customer/cases-card';
import { CustomerHeader } from './customer/customer-header';
import { RecordingPlayer } from './recording-player';

const PAGE = 50;
type Sb = ReturnType<typeof createClient>;

interface Customer extends ConsentFields {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  created_at: string | null;
  user_id: string | null;
}
interface Basics {
  contact: Customer;
  conversation: { id: string; assignedTo: string | null } | null;
  deal: { id: string; title: string; stage: string | null } | null;
  /** pbx_settings.missed_call_whatsapp_draft: missed calls offer a draft. */
  draftOn: boolean;
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

export function CustomerPage({
  contactId,
  fromTeam = false,
}: {
  contactId: string;
  /** Opened from the team list: back and delete return there. */
  fromTeam?: boolean;
}) {
  const tl = useTranslations('CustomerTimeline');
  const td = useTranslations('Contacts.detailView');
  const locale = useLocale();
  const router = useRouter();
  const { accountRole } = useAuth();
  const access = customerAccess(accountRole);
  const tm = useTranslations('Memory');
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
  const [editing, setEditing] = useState(false);
  const [leadOpen, setLeadOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The chat tag and send prediction, as the side sheet reads them.
  const { tree: chatTagTree } = useChatTags();
  const channels = useAccountNumbers(access.send);
  const myNumberIds = useMyNumberIds();
  const [thread, setThread] = useState<ContactThread>(NO_THREAD);
  useEffect(() => {
    let live = true;
    void loadContactThread(createClient(), contactId).then(
      (t) => live && setThread(t)
    );
    return () => {
      live = false;
    };
  }, [contactId, reloadKey]);
  const prediction = useMemo(
    () => predictSendChannels(channels ?? [], thread, myNumberIds),
    [channels, myNumberIds, thread]
  );
  const outreach = useContactOutreach({
    contact:
      load.state === 'ready'
        ? { id: contactId, phone: load.contact.phone }
        : null,
    thread,
    prediction,
    onSent: () => setReloadKey((k) => k + 1),
  });
  const say = (p: Part) =>
    typeof p === 'string' ? p : tl(p.key as never, p.values as never);

  useEffect(() => {
    let live = true;
    const sb = createClient();
    void (async () => {
      const [c, conv, deal, pbx] = await Promise.all([
        sb
          .from('contacts')
          // `*`: the Edit form saves the whole row back.
          .select('*')
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
        // The active workspace's row (RLS); none or unreadable: no draft.
        sb
          .from('pbx_settings')
          .select('missed_call_whatsapp_draft')
          .maybeSingle(),
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
        draftOn:
          !pbx.error &&
          (pbx.data as { missed_call_whatsapp_draft?: unknown } | null)
            ?.missed_call_whatsapp_draft === true,
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
  }, [contactId, reloadKey]);

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
        <BackLink label={tl('back')} href={contactsListPath(fromTeam)} />
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
  const draft = missedDraftOffer(load.draftOn, contact);
  const ownerName = contact.user_id ? names[contact.user_id] : null;
  const addNote = (n: SavedNote) =>
    setLoad((prev) =>
      prev.state === 'ready'
        ? { ...prev, rows: { ...prev.rows, notes: [n, ...prev.rows.notes] } }
        : prev
    );

  const deleteNote = async (id: string) => {
    if (!window.confirm(td('confirmDeleteNote'))) return;
    const { error } = await createClient()
      .from('contact_notes')
      .delete()
      .eq('id', id);
    if (error) return void toast.error(td('toastNoteDeleteFailed'));
    setLoad((prev) =>
      prev.state === 'ready'
        ? {
            ...prev,
            rows: {
              ...prev.rows,
              notes: prev.rows.notes.filter((n) => n.id !== id),
            },
          }
        : prev
    );
    toast.success(td('toastNoteDeleted'));
  };

  const draftWhatsApp = () => {
    if (!conversation) return void toast.error(tl('noConversation'));
    const text = say(missedDraftText(contact.name));
    if (putComposerPrefill(sessionStore(), conversation.id, text))
      window.dispatchEvent(
        new CustomEvent(COMPOSER_PREFILL_EVENT, { detail: conversation.id })
      );
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
    const h = entryHeading(e, {
      timeZone,
      locale,
      contactName: contact.name,
      rang: e.kind === 'call' ? e.call.rangNames : undefined,
    });
    const missed = e.kind === 'call' && callTone(e.call) === 'missed';
    const [Icon, tone] =
      e.kind === 'call'
        ? missed
          ? [PhoneMissed, 'bg-destructive-soft text-destructive']
          : [Phone, 'bg-info-soft text-info']
        : e.kind === 'whatsapp'
          ? [MessageCircle, 'bg-success-soft text-success']
          : e.kind === 'note'
            ? [StickyNote, 'bg-warning-soft text-warning']
            : [Hash, 'bg-primary-soft text-primary'];
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
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm">
              <span className="font-semibold">{say(h.label)}</span>
              <span className="text-muted-foreground">
                {h.details.map((d) => ` · ${say(d)}`).join('')}
              </span>
            </p>
            {e.kind === 'note' && access.addNote && (
              <button
                type="button"
                onClick={() => void deleteNote(e.id)}
                aria-label={td('deleteNote')}
                className="text-muted-foreground hover:text-destructive shrink-0 cursor-pointer"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
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
                task && 'border-warning/30 bg-warning-soft border px-3 py-2'
              )}
            >
              {task && (
                <span className="text-foreground flex-1 text-sm">
                  {say(
                    taskStrip(
                      task,
                      (task.assigned_to && names[task.assigned_to]) || null,
                      timeZone
                    )
                  )}
                </span>
              )}
              {access.call && (
                <CallButton
                  contact={contact}
                  label={tl('callBack')}
                  size="xs"
                />
              )}
              {access.send && draft.kind === 'offer' && (
                <Button size="xs" variant="outline" onClick={draftWhatsApp}>
                  {tl('draftWhatsApp')}
                </Button>
              )}
              {draft.kind === 'blocked' && (
                <span className="text-muted-foreground text-xs">
                  {say(draft.reason)}
                </span>
              )}
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
  // Cases and leads (130): agent and up, as /api/cases/leads.
  const canOpenLead = !!accountRole && canSendMessages(accountRole);
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <BackLink label={tl('back')} href={contactsListPath(fromTeam)} />
      <CustomerHeader
        contact={contact}
        ownerName={ownerName}
        conversationId={conversation?.id ?? null}
        chip={contactChatTagChip(thread.chatTags, chatTagTree)}
        access={access}
        outreach={outreach}
        channels={channels}
        prediction={prediction}
        onEdit={() => setEditing(true)}
        onNewLead={canOpenLead ? () => setLeadOpen(true) : undefined}
        listPath={contactsListPath(fromTeam)}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="order-2 min-w-0 space-y-4 lg:order-1">
          {access.addNote && (
            <NoteComposer contactId={contactId} onAdded={addNote} />
          )}
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
            <p className="border-border text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
              {tl(`emptyFor.${filter}`)}
            </p>
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

        <aside className="order-1 min-w-0 space-y-4 lg:order-2">
          <DetailsCard contact={contact} canEdit={access.edit} />
          <DealsCard contactId={contactId} />
          {canOpenLead && (
            <CasesCard
              contactId={contactId}
              opening={leadOpen}
              onOpeningChange={setLeadOpen}
            />
          )}
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
          <Card title={tm('title')}>
            <MemoryPanel
              apiBase={`/api/contacts/${contactId}/memory`}
              canWrite={access.addNote}
              canForget={!!accountRole && hasMinRole(accountRole, 'admin')}
              compact
            />
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
          {/* Journey + consent (module 016); it gates its own actions on
              the same role rules (set: agent and up, clear: admin). */}
          <div className="border-border divide-border divide-y overflow-hidden rounded-xl border">
            <ContactJourneySections
              key={contact.id}
              contactId={contact.id}
              SectionTitle={ConsentTitle}
            />
          </div>
        </aside>
      </div>
      {outreach.dialogs}
      {access.edit && (
        <ContactForm
          open={editing}
          onOpenChange={setEditing}
          contact={contact as unknown as Contact}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

function ConsentTitle({
  icon: Icon,
  children,
}: {
  icon: typeof Phone;
  children: React.ReactNode;
}) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold">
      <Icon className="text-muted-foreground size-3.5" />
      {children}
    </h2>
  );
}

function BackLink({ label, href }: { label: string; href: string }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline"
    >
      <ArrowLeft className="size-4" />
      {label}
    </Link>
  );
}
