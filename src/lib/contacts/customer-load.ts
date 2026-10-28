// The customer page's reads (/contacts/[id], module 015), kept out of
// the component so the load plan can be tested without a DOM.
//
// Why the plan is shaped this way: behind the Cloudflare tunnel a
// browser round trip is ~700 ms, so what the user waits for is the
// number of *sequential* trips. Everything that needs only the contact
// id starts at once; only the messages and the internal-chat shares
// wait, and only for the conversation id (shared_conversations.conversation_id has no FK,
// so it cannot be reached through an embed). Every read is the viewer's
// own (RLS, or the viewer's API routes).

import type { SupabaseClient } from '@supabase/supabase-js';

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
export interface Basics {
  contact: Customer;
  conversation: { id: string; assignedTo: string | null } | null;
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

/**
 * The page's first load. Throws on any failed read but the shares
 * (best-effort: an empty list). A missing contact wins over every
 * timeline failure, as when the timeline was read only after it.
 */
export async function loadCustomer(
  sb: SupabaseClient,
  contactId: string
): Promise<CustomerLoad> {
  const conv = Promise.resolve(
    sb
      .from('conversations')
      .select('id, assigned_agent_id')
      .eq('contact_id', contactId)
      .limit(1)
  ).then(
    (r) =>
      (must(r) as { id: string; assigned_agent_id: string | null }[])[0] ?? null
  );
  const basics = Promise.all([
    sb
      .from('contacts')
      // `*`: the Edit form saves the whole row back.
      .select('*')
      .eq('id', contactId)
      .maybeSingle(),
    conv,
    sb
      .from('deals')
      .select('id, title, stage:pipeline_stages(name)')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1),
    // The active workspace's row (RLS); none or unreadable: no draft.
    sb.from('pbx_settings').select('missed_call_whatsapp_draft').maybeSingle(),
  ]);
  // Second round, once the conversation id is known: the messages and
  // the shares are issued together. A messages failure rejects (the
  // shares never do); no conversation: no messages and no shares.
  const second = conv.then((cv) =>
    Promise.all([
      readPage(sb, 'messages', contactId, null, cv?.id ?? null),
      cv ? readShares(sb, cv.id).catch((): RawPost[] => []) : ([] as RawPost[]),
    ])
  );
  const timeline = Promise.all([
    readPage(sb, 'calls', contactId, null),
    readPage(sb, 'notes', contactId, null),
    second,
  ]);
  // Awaited only after the basics: until then a rejection is not
  // unhandled, and it is ignored if the contact turns out missing.
  timeline.catch(() => {});

  const [c, cv, deal, pbx] = await basics;
  const contact = must(c) as Customer | null;
  if (!contact) return { state: 'missing' };
  const d = (
    must(deal) as unknown as {
      id: string;
      title: string;
      stage: { name: string } | null;
    }[]
  )[0];
  const [calls, notes, [msgs, internal]] = await timeline;
  return {
    state: 'ready',
    contact,
    conversation: cv ? { id: cv.id, assignedTo: cv.assigned_agent_id } : null,
    deal: d ? { id: d.id, title: d.title, stage: d.stage?.name ?? null } : null,
    draftOn:
      !pbx.error &&
      (pbx.data as { missed_call_whatsapp_draft?: unknown } | null)
        ?.missed_call_whatsapp_draft === true,
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
  };
}
