// The customer page's reads (/contacts/[id], module 015), kept out of
// the component so the load plan can be tested without a DOM.
//
// Why the plan is shaped this way: behind the Cloudflare tunnel a
// browser round trip is ~700 ms, so what the user waits for is the
// number of *sequential* trips. Everything that needs only the contact
// id starts at once; only the messages, the internal-chat shares and
// the thread's last message wait, and only for the conversation id
// (shared_conversations.conversation_id has no FK, so it cannot be
// reached through an embed). Each part is handed back as it lands
// (`startCustomerLoad`), so the screen never waits for its slowest
// read. Every read is the viewer's own (RLS, or the viewer's API
// routes).

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  contactThreadFrom,
  readLastMessage,
  THREAD_COLUMNS,
  type ContactThread,
  type ThreadRow,
} from '@/lib/contacts/contact-thread';
import {
  CUSTOMER_INSIGHT_COLUMNS,
  type CustomerInsightFigures,
} from '@/lib/insights/customer-view';
import type { ConsentFields } from '@/lib/pbx/call-ui';
import type {
  TimelineCall,
  TimelinePaging,
  TimelineSource,
} from '@/lib/pbx/timeline';

export const PAGE = 50;

export interface Customer extends ConsentFields {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  created_at: string | null;
  user_id: string | null;
}
export interface PersonalChat {
  id: string;
  /** The auth user id of the person whose own WhatsApp it is. */
  ownerId: string;
}
export interface Basics {
  contact: Customer;
  conversation: { id: string; assignedTo: string | null } | null;
  /** The personal chats (migration 191) the viewer may see: RLS returns
   *  only theirs, their team's, or all for an admin. Oldest first. */
  personalChats: PersonalChat[];
  /** The conversation's Smart insights figures; null without one. */
  insights: CustomerInsightFigures | null;
  deal: { id: string; title: string; stage: string | null } | null;
  /** pbx_settings.missed_call_whatsapp_draft: missed calls offer a draft. */
  draftOn: boolean;
}
export interface RawMessage {
  id: string;
  sender_type: string;
  sender_id: string | null;
  content_text: string | null;
  content_type: string;
  created_at: string;
}
export interface RawNote {
  id: string;
  note_text: string;
  user_id: string | null;
  created_at: string;
}
export interface RawPost {
  id: string;
  channelName: string;
  authorId: string | null;
  body: string;
  createdAt: string;
}
export interface Rows {
  calls: TimelineCall[];
  messages: RawMessage[];
  notes: RawNote[];
  internal: RawPost[];
}
export type CustomerLoad =
  | { state: 'missing' }
  | ({ state: 'ready'; rows: Rows; paging: TimelinePaging } & Basics);

export const getJson = (url: string) =>
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

/**
 * One page of a source, older than `before` (exclusive) when given.
 * Messages are read by `conversationId` (the per-conversation index of
 * migration 059 answers that directly); none: no messages.
 */
export async function readPage(
  sb: SupabaseClient,
  source: Exclude<TimelineSource, 'internal'>,
  contactId: string,
  before: string | null,
  conversationId: string | null = null
): Promise<unknown[]> {
  if (source === 'calls') {
    const q = new URLSearchParams({
      contactId,
      scope: 'all',
      limit: String(PAGE),
    });
    if (before) q.set('to', before);
    return (await getJson(`/api/pbx/calls?${q}`)).calls ?? [];
  }
  if (source === 'messages' && !conversationId) return [];
  // Not a `conversations!inner(contact_id)` join on the contact: its
  // plan on a large messages table with the per-row can_view_conversation
  // policy is unproven, so the conversation id is waited for instead.
  let q =
    source === 'messages'
      ? sb
          .from('messages')
          .select(
            'id, sender_type, sender_id, content_text, content_type, created_at'
          )
          .eq('conversation_id', conversationId)
      : sb
          .from('contact_notes')
          .select('id, note_text, user_id, created_at')
          .eq('contact_id', contactId);
  if (before) q = q.lt('created_at', before);
  return must(
    await q.order('created_at', { ascending: false }).limit(PAGE)
  ) as unknown[];
}

/** Internal-chat posts that shared this customer's chat, in one read. */
export async function readShares(
  sb: SupabaseClient,
  conversationId: string
): Promise<RawPost[]> {
  // The FK is named: message_pins (channel_id, message_id) is a second
  // path from internal_messages to chat_channels, and an unnamed embed
  // is ambiguous (PGRST201, answered as HTTP 300).
  const rows = must(
    await sb
      .from('shared_conversations')
      .select(
        'message_id, internal_messages!inner(id, author_id, body, created_at, chat_channels!internal_messages_channel_id_fkey(name))'
      )
      .eq('conversation_id', conversationId)
      .is('internal_messages.deleted_at', null)
      .is('internal_messages.erased_at', null)
  ) as {
    internal_messages: {
      id: string;
      author_id: string | null;
      body: string;
      created_at: string;
      chat_channels: { name: string } | null;
    } | null;
  }[];
  // A channel the viewer cannot see embeds as null: its posts stay out.
  return rows.flatMap(({ internal_messages: p }) =>
    p?.chat_channels
      ? [
          {
            id: p.id,
            channelName: p.chat_channels.name,
            authorId: p.author_id,
            body: p.body,
            createdAt: p.created_at,
          },
        ]
      : []
  );
}

export const paged = (source: TimelineSource, rows: unknown[]) => ({
  oldest: rows.length ? atOf[source](rows[rows.length - 1] as never) : null,
  more: rows.length === PAGE,
});

export interface CustomerTimeline {
  rows: Rows;
  paging: TimelinePaging;
}

/** The page's first load, one promise per part of the screen. */
export interface CustomerParts {
  /** Wave 1. Null: no such contact (or not one the viewer may see). */
  basics: Promise<Basics | null>;
  /** Wave 2: the messages wait for the conversation id. */
  timeline: Promise<CustomerTimeline>;
  /** Wave 2: the last message waits for the conversation id. */
  thread: Promise<ContactThread>;
}

type ConvRow = {
  id: string;
  assigned_agent_id: string | null;
  personal_owner_id?: string | null;
} & ThreadRow &
  CustomerInsightFigures;

/**
 * The company chat (no `personal_owner_id`) is THE conversation of the
 * page; a person's own-WhatsApp chats (migration 191) are listed apart.
 * Both stay oldest first, as read.
 */
export function splitConversations<
  T extends { id: string; personal_owner_id?: string | null },
>(rows: T[]): { company: T[]; personal: PersonalChat[] } {
  const company: T[] = [];
  const personal: PersonalChat[] = [];
  for (const r of rows) {
    if (r.personal_owner_id) {
      personal.push({ id: r.id, ownerId: r.personal_owner_id });
    } else {
      company.push(r);
    }
  }
  return { company, personal };
}

/**
 * Starts every read of the page's first load and hands back each part
 * as its own promise, so the screen shows each one as it lands rather
 * than waiting for the slowest. The conversations are read once, for
 * the header, the insights, the messages and the thread alike.
 *
 * Every part rejects on its own failed reads, except the shares
 * (best-effort: an empty list) and the thread's last message (none).
 * Each promise already has a handler, so a part nobody awaits (the
 * timeline of a missing contact) is never an unhandled rejection.
 */
export function startCustomerLoad(
  sb: SupabaseClient,
  contactId: string
): CustomerParts {
  // Oldest first: the thread's send-number fields come from the oldest
  // (contact-thread.ts), and the page shows the oldest company chat as its one conversation.
  const convRows = Promise.resolve(
    sb
      .from('conversations')
      .select(
        `id, assigned_agent_id, personal_owner_id, ${THREAD_COLUMNS}, ${CUSTOMER_INSIGHT_COLUMNS}`
      )
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
  ).then((r) => (must(r) as ConvRow[] | null) ?? []);
  const split = convRows.then(splitConversations);
  const conv = split.then((s) => s.company[0] ?? null);
  const basics = Promise.all([
    sb
      .from('contacts')
      // `*`: the Edit form saves the whole row back.
      .select('*')
      .eq('id', contactId)
      .maybeSingle(),
    conv,
    split,
    sb
      .from('deals')
      .select('id, title, stage:pipeline_stages(name)')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1),
    // The active workspace's row (RLS); none or unreadable: no draft.
    sb.from('pbx_settings').select('missed_call_whatsapp_draft').maybeSingle(),
  ]).then(([c, cv, sp, deal, pbx]) => toBasics(c, cv, deal, pbx, sp.personal));
  // Second round, once the conversation id is known: the messages, the
  // shares and the last message are issued together. A messages
  // failure rejects (the shares never do); no conversation: no
  // messages and no shares.
  const second = conv.then((cv) =>
    Promise.all([
      readPage(sb, 'messages', contactId, null, cv?.id ?? null),
      cv ? readShares(sb, cv.id).catch((): RawPost[] => []) : ([] as RawPost[]),
    ])
  );
  const last = conv.then((cv) =>
    cv ? readLastMessage(sb, cv.id).catch(() => null) : null
  );
  const timeline = Promise.all([
    readPage(sb, 'calls', contactId, null),
    readPage(sb, 'notes', contactId, null),
    second,
  ]).then(([calls, notes, [msgs, internal]]) => ({
    rows: {
      calls: calls as TimelineCall[],
      messages: msgs as RawMessage[],
      notes: notes as RawNote[],
      internal,
    },
    paging: {
      calls: paged('calls', calls),
      messages: paged('messages', msgs),
      notes: paged('notes', notes),
      internal: { oldest: null, more: false },
    },
  }));
  const thread = Promise.all([split, last]).then(([sp, lm]) =>
    contactThreadFrom(sp.company, contactId, lm)
  );
  for (const p of [basics, timeline, thread]) p.catch(() => {});
  return { basics, timeline, thread };
}

function toBasics(
  c: { data: unknown; error: { message: string } | null },
  cv: ConvRow | null,
  deal: { data: unknown; error: { message: string } | null },
  pbx: { data: unknown; error: unknown },
  personalChats: PersonalChat[] = []
): Basics | null {
  const contact = must(c) as Customer | null;
  if (!contact) return null;
  const d = (
    must(deal) as unknown as {
      id: string;
      title: string;
      stage: { name: string } | null;
    }[]
  )[0];
  return {
    contact,
    conversation: cv ? { id: cv.id, assignedTo: cv.assigned_agent_id } : null,
    personalChats,
    insights: cv
      ? {
          id: cv.id,
          insight_intent: cv.insight_intent ?? null,
          insight_intent_p: cv.insight_intent_p ?? null,
          insight_urgency: cv.insight_urgency ?? null,
          insight_lead_temp: cv.insight_lead_temp ?? null,
          insight_upset: cv.insight_upset ?? null,
          insight_wants_human: cv.insight_wants_human ?? null,
          insight_at: cv.insight_at ?? null,
          insight_sentiment: cv.insight_sentiment ?? null,
          insight_objections: cv.insight_objections ?? null,
          insight_needs_reply: cv.insight_needs_reply ?? null,
          insight_callback: cv.insight_callback ?? null,
          insight_attention_at: cv.insight_attention_at ?? null,
          insight_attention_reason: cv.insight_attention_reason ?? null,
          unread_count: cv.unread_count ?? null,
        }
      : null,
    deal: d ? { id: d.id, title: d.title, stage: d.stage?.name ?? null } : null,
    draftOn:
      !pbx.error &&
      (pbx.data as { missed_call_whatsapp_draft?: unknown } | null)
        ?.missed_call_whatsapp_draft === true,
  };
}

/**
 * The page's first load as one answer. Throws on any failed read but
 * the shares (best-effort: an empty list). A missing contact wins over
 * every timeline failure, as when the timeline was read only after it.
 */
export async function loadCustomer(
  sb: SupabaseClient,
  contactId: string
): Promise<CustomerLoad> {
  const parts = startCustomerLoad(sb, contactId);
  const basics = await parts.basics;
  if (!basics) return { state: 'missing' };
  return { state: 'ready', ...basics, ...(await parts.timeline) };
}
