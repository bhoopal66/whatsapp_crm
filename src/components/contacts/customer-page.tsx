'use client';

// /contacts/[id] — one customer's calls, WhatsApp, notes and internal
// shares on one timeline, with their open tasks, the team on them and
// this month's calls (module 015). Every read is the viewer's own (RLS
// or the viewer's API routes), so it shows only what they may see.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Hash,
  MessageCircle,
  Phone,
  PhoneMissed,
  StickyNote,
  Trash2,
} from 'lucide-react';

import { ShareCallButton } from '@/components/chat/share-to-chat-dialog';
import { DealRoomLinks } from '@/components/deal-rooms/room-links';
import { CustomerInsightsCard } from '@/components/insights/customer-insights-card';
import { MemoryPanel } from '@/components/memory/memory-panel';
import { useContactOutreach } from '@/components/contacts/contact-outreach';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactJourneySections } from '@/components/journeys/contact-journey';
import { CallButton } from '@/components/pbx/call-button';
import { BackLink } from '@/components/layout/back-link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  type TimelineEntry,
  type TimelineFilter,
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
import { NO_THREAD } from '@/lib/contacts/contact-thread';
import { customerAccess } from '@/lib/contacts/customer-access';
import {
  getJson,
  paged,
  startCustomerLoad,
  readPage,
} from '@/lib/contacts/customer-load';
import { contactsListPath } from '@/lib/contacts/customer-links';
import {
  applyPart,
  cacheAction,
  customerSections,
  customerViewKey,
  startView,
  mayLandPage,
  canEditContact,
  viewOwner,
  type CustomerPart,
  type CustomerView,
  type ViewOwner,
} from '@/lib/contacts/customer-view';
import { CONTACT_LIST_QUESTION_PREFIX } from '@/lib/contacts/list-query';
import { predictSendChannels } from '@/lib/contacts/predict-send-channels';
import { sessionCache, sessionKey } from '@/lib/session-cache';
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
import { DocumentsCard } from './customer/documents-card';
import { CustomerHeader } from './customer/customer-header';
import { FailedLine } from './customer/failed-line';
import { RecordingPlayer } from './recording-player';

/** The view on screen, tagged with the contact it belongs to. */
interface Held {
  contactId: string;
  view: CustomerView;
}
type FailedPart = Extract<CustomerPart, { kind: 'failed' }>['part'];
/** Parts of one load: basics, timeline, thread, tasks, this month. */
const LOAD_PARTS = 5;

const cachedView = (key: ReturnType<typeof customerViewKey>) =>
  startView(key ? sessionCache.get<CustomerView>(key)?.value : undefined);

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
  const { accountRole, accountId, user, salesRestricted } = useAuth();
  const access = customerAccess(accountRole);
  const tm = useTranslations('Memory');
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
  // One view, shown part by part as each read lands, started from what
  // this tab last showed for the contact (lib/contacts/customer-view.ts).
  const viewKey = customerViewKey(accountId, user?.id, contactId);
  const [held, setHeld] = useState<Held>(() => ({
    contactId,
    view: cachedView(viewKey),
  }));
  if (held.contactId !== contactId)
    setHeld({ contactId, view: cachedView(viewKey) });
  const view = held.contactId === contactId ? held.view : cachedView(viewKey);
  const sections = customerSections(view);
  // Lands a part on the contact's own view; a part for any other
  // contact is dropped, even mid-transition.
  const landOn = (id: string, part: CustomerPart) =>
    setHeld((h) =>
      h.contactId === id ? { ...h, view: applyPart(h.view, part) } : h
    );
  // Bumped by every load and every restart, so a part from an older
  // load never lands; `inflight` counts this load's unsettled parts.
  const loadGen = useRef(0);
  const inflight = useRef(0);
  const deleted = useRef(false);
  const owner = useRef<ViewOwner | null>(null);
  // Live, shared with any other dot on the page: the phone's call or
  // chosen status over the app's (lib/person-presence.ts).
  const phone = usePhonePresence();
  const { getPresence } = usePresence();
  const names = view.names;
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [paging, setPaging] = useState(false);
  const [ticking, setTicking] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const sentinel = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The chat tag and send prediction, as the side sheet reads them.
  const { tree: chatTagTree } = useChatTags();
  const channels = useAccountNumbers(access.send);
  const myNumberIds = useMyNumberIds();
  const thread = view.thread ?? NO_THREAD;
  const prediction = useMemo(
    () => predictSendChannels(channels ?? [], thread, myNumberIds),
    [channels, myNumberIds, thread]
  );
  // A fresh load; parts of the running one are dropped from here on.
  const restart = () => {
    loadGen.current += 1;
    setReloadKey((k) => k + 1);
  };
  // Retry of a failed part: every part is read again, and the failed
  // ones show as loading meanwhile.
  const retry = () => {
    setHeld((h) =>
      h.contactId === contactId ? { ...h, view: startView(h.view) } : h
    );
    restart();
  };
  const outreach = useContactOutreach({
    contact: view.basics
      ? { id: contactId, phone: view.basics.contact.phone }
      : null,
    thread,
    prediction,
    onSent: restart,
  });
  const say = (p: Part) =>
    typeof p === 'string' ? p : tl(p.key as never, p.values as never);

  useEffect(() => {
    const gen = ++loadGen.current;
    inflight.current = LOAD_PARTS;
    // One load: the thread comes from the same conversations read; the
    // tasks and this month's calls are asked for beside it.
    const parts = startCustomerLoad(createClient(), contactId);
    const land = <T,>(
      p: Promise<T>,
      ok: (v: T) => CustomerPart,
      part: FailedPart
    ) =>
      void p
        .then(ok, (): CustomerPart => ({ kind: 'failed', part }))
        .then((cp) => {
          if (loadGen.current !== gen) return;
          inflight.current -= 1;
          landOn(contactId, cp);
        });
    land(parts.basics, (value) => ({ kind: 'basics', value }), 'basics');
    land(parts.timeline, (value) => ({ kind: 'timeline', value }), 'timeline');
    land(parts.thread, (value) => ({ kind: 'thread', value }), 'thread');
    land(
      getJson(
        `/api/tasks?scope=contact&contactId=${contactId}&status=open`
      ).then((b) => (b.tasks ?? []) as TimelineTask[]),
      (value) => ({ kind: 'tasks', value }),
      'tasks'
    );
    land(
      getJson(
        `/api/pbx/calls/summary?contactId=${contactId}&tz=${encodeURIComponent(timeZone)}`
      ) as Promise<MonthTotals>,
      (value) => ({ kind: 'summary', value }),
      'summary'
    );
    return () => {
      loadGen.current += 1;
    };
  }, [contactId, reloadKey, timeZone]);

  // Keeps the view for a revisit, under the key this page first saw
  // (customer-view.ts `cacheAction`); a missing contact's entry goes.
  useEffect(() => {
    owner.current = viewOwner(owner.current, contactId, viewKey);
    if (deleted.current || held.contactId !== contactId) return;
    const act = cacheAction(held.view, viewKey, owner.current);
    if (act === 'store' && viewKey) sessionCache.set(viewKey, held.view);
    if (act === 'drop' && viewKey) sessionCache.delete(viewKey);
  }, [held, contactId, viewKey]);

  // A local edit (note, task) while a load runs: the running load may
  // have read before the edit, so it is replaced by one that reads
  // after it, and the edit is never undone on screen.
  const edit = (fn: (v: CustomerView) => CustomerView) => {
    setHeld((h) =>
      h.contactId === contactId ? { ...h, view: fn(h.view) } : h
    );
    if (inflight.current > 0) restart();
  };

  const ready = view.basics;
  const timeline = view.timeline;
  const all = useMemo(() => {
    if (!timeline) return [];
    const r = timeline.rows;
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
  }, [timeline, names]);
  const team = ready
    ? teamOnCustomer({
        ownerId: ready.contact.user_id,
        assigneeId: ready.conversation?.assignedTo ?? null,
        recent: recentPeople(all),
      })
    : [];

  // Names of everyone the page mentions, asked for as each part lands,
  // each once per contact (the view keeps the names it found).
  const askedKey = (id: string) => `${contactId}:${id}`;
  const wanted = [
    ...team.map((p) => p.userId),
    ...(ready?.personalChats.map((c) => c.ownerId) ?? []),
    ...(timeline?.rows.notes.map((n) => n.user_id) ?? []),
    ...(timeline?.rows.internal.map((p) => p.authorId) ?? []),
    ...(view.tasks?.map((t) => t.assigned_to) ?? []),
  ].filter((id): id is string => !!id && !asked.current.has(askedKey(id)));
  const wantedKey = [...new Set(wanted)].sort().join(',');
  useEffect(() => {
    if (!wantedKey) return;
    const ids = wantedKey.split(',');
    ids.forEach((id) => asked.current.add(`${contactId}:${id}`));
    void createClient()
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', ids)
      .then(({ data }) => {
        const found = (data ?? []) as { user_id: string; full_name: string }[];
        if (found.length)
          landOn(contactId, {
            kind: 'names',
            value: Object.fromEntries(
              found.map((p) => [p.user_id, p.full_name])
            ),
          });
      });
  }, [wantedKey, contactId]);

  const horizon = timeline ? timelineHorizon(timeline.paging, filter) : null;
  const toPage = timeline ? sourcesToPage(timeline.paging, filter) : [];
  const visible = withinHorizon(filterTimeline(all, filter), horizon);

  const loadMore = async () => {
    if (!ready || !timeline || paging || !toPage.length) return;
    // A page read against a timeline a newer load has replaced is
    // dropped: its cursor belongs to the older rows.
    const gen = loadGen.current;
    setPaging(true);
    try {
      const sb = createClient();
      const pages = await Promise.all(
        toPage.map((s) =>
          readPage(
            sb,
            s as Exclude<TimelineSource, 'internal'>,
            contactId,
            timeline.paging[s]?.oldest ?? null,
            ready.conversation?.id ?? null
          )
        )
      );
      if (loadGen.current !== gen) return;
      setHeld((h) => {
        const prev = h.view.timeline;
        if (
          h.contactId !== contactId ||
          !prev ||
          !mayLandPage(h.view, timeline)
        )
          return h;
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
        return {
          ...h,
          view: { ...h.view, timeline: { rows, paging: next } },
        };
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

  if (sections.page === 'missing' || sections.page === 'failed')
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
        <BackLink fallbackHref={contactsListPath(fromTeam)} />
        {sections.page === 'missing' ? (
          <p className="text-muted-foreground text-sm">{tl('notFound')}</p>
        ) : (
          <FailedLine onRetry={retry} />
        )}
      </div>
    );

  const contact = ready?.contact ?? null;
  const conversation = ready?.conversation ?? null;
  const deal = ready?.deal ?? null;
  const draft = ready ? missedDraftOffer(ready.draftOn, ready.contact) : null;
  const tasks = view.tasks ?? [];
  const ownerName = contact?.user_id ? names[contact.user_id] : null;
  const addNote = (n: SavedNote) =>
    edit((v) =>
      v.timeline
        ? {
            ...v,
            timeline: {
              ...v.timeline,
              rows: {
                ...v.timeline.rows,
                notes: [n, ...v.timeline.rows.notes],
              },
            },
          }
        : v
    );

  const deleteNote = async (id: string) => {
    if (!window.confirm(td('confirmDeleteNote'))) return;
    const { error } = await createClient()
      .from('contact_notes')
      .delete()
      .eq('id', id);
    if (error) return void toast.error(td('toastNoteDeleteFailed'));
    edit((v) =>
      v.timeline
        ? {
            ...v,
            timeline: {
              ...v.timeline,
              rows: {
                ...v.timeline.rows,
                notes: v.timeline.rows.notes.filter((n) => n.id !== id),
              },
            },
          }
        : v
    );
    toast.success(td('toastNoteDeleted'));
  };

  // Before leaving for the list: neither this page nor the list may
  // show the deleted contact from the cache.
  const forgetDeleted = () => {
    deleted.current = true;
    loadGen.current += 1;
    if (viewKey) sessionCache.delete(viewKey);
    const lists = sessionKey(accountId, user?.id, CONTACT_LIST_QUESTION_PREFIX);
    if (lists) sessionCache.deletePrefix(lists);
  };

  const draftWhatsApp = () => {
    if (!conversation) return void toast.error(tl('noConversation'));
    const text = say(missedDraftText(contact?.name ?? null));
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
    edit((v) =>
      v.tasks ? { ...v, tasks: v.tasks.filter((t) => t.id !== task.id) } : v
    );
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
    if (!contact || !draft) return null;
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
      missed && e.kind === 'call' ? missedTaskFor(e.call.id, tasks) : null;
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

  const month = view.summary ? monthSummaryParts(view.summary) : null;
  // The contact's cases (read-only): agent and up, as GET /api/cases/leads.
  const canSeeCases =
    !!accountRole && canSendMessages(accountRole) && !salesRestricted;
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <BackLink fallbackHref={contactsListPath(fromTeam)} />
      {contact ? (
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
          canEdit={canEditContact(view)}
          listPath={contactsListPath(fromTeam)}
          onDeleted={forgetDeleted}
        />
      ) : (
        <div className="bg-muted h-24 animate-pulse rounded-xl" aria-hidden />
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="order-1 min-w-0 space-y-4">
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
                    ? 'bg-primary text-primary-foreground border-transparent'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted dark:bg-transparent'
                )}
              >
                {tl(`filters.${f}`)}
              </button>
            ))}
          </nav>
          {sections.timeline === 'failed' ? (
            <FailedLine onRetry={retry} />
          ) : sections.timeline === 'loading' ? (
            <div
              className="bg-muted h-40 animate-pulse rounded-xl"
              aria-hidden
            />
          ) : visible.length === 0 && !canPage ? (
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

        <aside className="order-2 min-w-0 space-y-4">
          {/* The cards that read by contact id alone mount at once (their
              reads stay silent for a missing contact); the rest wait for
              the basics. */}
          {contact && <DetailsCard contact={contact} canEdit={access.edit} />}
          {ready && (
            <CustomerInsightsCard
              conversation={ready.insights}
              frame={(title, body) => <Card title={title}>{body}</Card>}
            />
          )}
          {ready && ready.personalChats.length > 0 && (
            <PersonalChatLinks
              chats={ready.personalChats}
              names={names}
              label={(name) =>
                name ? tl('personalChatBy', { name }) : tl('personalChat')
              }
            />
          )}
          <DealsCard key={contactId} contactId={contactId} />
          {canSeeCases && <CasesCard contactId={contactId} />}
          <DocumentsCard key={contactId} contactId={contactId} />
          <Card title={tl('openTasks')}>
            {sections.tasks === 'loading' ? (
              <div
                className="bg-muted h-10 animate-pulse rounded"
                aria-hidden
              />
            ) : sections.tasks === 'failed' ? (
              <FailedLine onRetry={retry} />
            ) : tasks.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {tl('noOpenTasks')}
              </p>
            ) : (
              <ul className="space-y-2">
                {tasks.map((task) => (
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
          {contact && (
            <DealRoomLinks
              contact={contact}
              frame={(title, body) => <Card title={title}>{body}</Card>}
            />
          )}
          {ready && (
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
          )}
          <Card title={tl('thisMonth')}>
            {month ? (
              <div className="space-y-1 text-sm">
                <p>{say(month.counts)}</p>
                <p className="text-muted-foreground">{say(month.talk)}</p>
              </div>
            ) : sections.month === 'failed' ? (
              <FailedLine onRetry={retry} />
            ) : (
              <div
                className="bg-muted h-10 animate-pulse rounded"
                aria-hidden
              />
            )}
          </Card>
          {/* Journey + consent (module 016); it gates its own actions on
              the same role rules (set: agent and up, clear: admin). */}
          {/* After the basics: its reads toast on an error, and a
              malformed id is one. */}
          {ready && (
            <div className="border-border divide-border divide-y overflow-hidden rounded-xl border">
              <ContactJourneySections
                key={contactId}
                contactId={contactId}
                SectionTitle={ConsentTitle}
              />
            </div>
          )}
        </aside>
      </div>
      {outreach.dialogs}
      {access.edit && contact && (
        <ContactForm
          open={editing}
          onOpenChange={setEditing}
          contact={contact as unknown as Contact}
          onSaved={restart}
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

/** The viewer's visible personal chats (migration 191) as small links. */
function PersonalChatLinks({
  chats,
  names,
  label,
}: {
  chats: { id: string; ownerId: string }[];
  names: Record<string, string>;
  label: (ownerName: string | null) => string;
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {chats.map((c) => (
        <Link
          key={c.id}
          href={`/inbox?c=${c.id}`}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        >
          {label(names[c.ownerId] ?? null)}
        </Link>
      ))}
    </div>
  );
}
