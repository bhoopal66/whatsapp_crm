/**
 * Deal rooms — the group transcript (module 014c, migration 088): every
 * group message with its sender and time, the files shared, and the
 * membership history from the audit, as one HTML file in the private
 * `deal-files` bucket (`account-<id>/room-<room id>/…`) with a
 * `deal_files` row of source `transcript`. Server-only, service role.
 *
 * Only what WhatsApp carried is in it: Team notes are internal chat and
 * are never read here. People appear by display name and role, never
 * by phone number.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'deal-files';

export interface TranscriptMessage {
  created_at: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  template_name: string | null;
  media: Record<string, unknown> | null;
  status: string | null;
  sender: string;
}

export interface TranscriptData {
  subject: string;
  status: string;
  createdAt: string;
  generatedAt: string;
  messages: TranscriptMessage[];
  files: { name: string; created_at: string }[];
  history: { at: string; text: string }[];
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : iso;
}

function content(m: TranscriptMessage): string {
  if (m.type === 'text') return m.body ?? '';
  if (m.type === 'template') {
    return `[template ${m.template_name ?? ''}]${m.body ? ` ${m.body}` : ''}`;
  }
  const name = m.media?.filename ?? m.media?.name;
  const label = `[${m.type}${typeof name === 'string' ? `: ${name}` : ''}]`;
  return m.body ? `${label} ${m.body}` : label;
}

export function renderTranscript(d: TranscriptData): string {
  const rows = d.messages
    .map(
      (m) =>
        `<tr><td>${esc(when(m.created_at))}</td><td>${esc(m.sender)}</td>` +
        `<td>${esc(content(m)).replace(/\n/g, '<br>')}</td>` +
        `<td>${m.status === 'failed' ? 'not delivered' : ''}</td></tr>`
    )
    .join('\n');
  const files = d.files
    .map((f) => `<li>${esc(f.name)} (${esc(when(f.created_at))})</li>`)
    .join('\n');
  const history = d.history
    .map((h) => `<li>${esc(when(h.at))}: ${esc(h.text)}</li>`)
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(d.subject)}: transcript</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top;text-align:left}</style>
</head><body>
<h1>${esc(d.subject)}</h1>
<p>Deal room transcript. Room created ${esc(when(d.createdAt))}; status ${esc(d.status)}; generated ${esc(when(d.generatedAt))}. WhatsApp group messages only: Team notes are not included.</p>
<h2>Messages (${d.messages.length})</h2>
${d.messages.length ? `<table><thead><tr><th>Time</th><th>From</th><th>Message</th><th></th></tr></thead><tbody>\n${rows}\n</tbody></table>` : '<p>No messages.</p>'}
<h2>Files</h2>
${d.files.length ? `<ul>\n${files}\n</ul>` : '<p>No files.</p>'}
<h2>Membership history</h2>
${d.history.length ? `<ul>\n${history}\n</ul>` : '<p>No membership changes recorded.</p>'}
</body></html>
`;
}

const ROLE_LABEL: Record<string, string> = {
  customer: 'customer',
  partner: 'partner',
  bank_guest: 'bank officer',
  business: 'our number',
};

const HISTORY: Record<string, string> = {
  group_created: 'Group created',
  participant_joined: 'joined',
  participant_left: 'left',
  participant_removed: 'was removed',
  participant_unlisted: 'joined without being listed',
  participant_approved: 'was approved by a team leader',
  participant_rejected: 'was not approved by a team leader',
  join_request: 'asked to join',
  join_requests_decided: 'Join requests decided',
  invite_link_reset: 'Invite link reset',
  status_changed: 'Status changed',
};

interface RoomForTranscript {
  id: string;
  account_id: string;
  deal_id: string | null;
  subject: string;
  status: string;
  created_at: string;
}

async function rows<T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${what} lookup failed: ${error.message}`);
  return (data ?? []) as T[];
}

export async function loadTranscriptData(
  db: SupabaseClient,
  room: RoomForTranscript
): Promise<TranscriptData> {
  const people = await rows<{
    id: string;
    display_name: string;
    role: string | null;
  }>(
    db
      .from('deal_room_participants')
      .select('id, display_name, role')
      .eq('room_id', room.id),
    'participant'
  );
  const byId = new Map(people.map((p) => [p.id, p]));
  const who = (id: unknown): string | null => {
    const p = typeof id === 'string' ? byId.get(id) : undefined;
    return p
      ? `${p.display_name} (${ROLE_LABEL[p.role ?? ''] ?? 'not listed'})`
      : null;
  };
  const messages = await rows<
    Omit<TranscriptMessage, 'sender'> & { sender_participant_id: string | null }
  >(
    db
      .from('group_messages')
      .select(
        'created_at, direction, type, body, template_name, media, status, sender_participant_id'
      )
      .eq('room_id', room.id)
      .order('created_at', { ascending: true }),
    'message'
  );
  const files = await rows<{
    name: string;
    created_at: string;
    source: string;
  }>(
    db
      .from('deal_files')
      .select('name, created_at, source')
      .eq('room_id', room.id),
    'file'
  );
  const events = await rows<{
    at: string;
    action: string;
    detail: Record<string, unknown> | null;
  }>(
    db
      .from('deal_room_audit')
      .select('at, action, detail')
      .eq('room_id', room.id)
      .order('at', { ascending: true }),
    'audit'
  );
  return {
    subject: room.subject,
    status: room.status,
    createdAt: room.created_at,
    generatedAt: new Date().toISOString(),
    messages: messages.map(({ sender_participant_id, ...m }) => ({
      ...m,
      sender:
        who(sender_participant_id) ??
        (m.direction === 'out' ? 'Our number' : 'Unknown'),
    })),
    files: files.filter((f) => f.source !== 'transcript'),
    history: events
      .filter((e) => e.action in HISTORY)
      .map((e) => {
        const person = who(e.detail?.participant_id);
        const text = HISTORY[e.action];
        if (e.action === 'status_changed') {
          return { at: e.at, text: `${text} to ${String(e.detail?.to ?? '')}` };
        }
        return { at: e.at, text: person ? `${person} ${text}` : text };
      }),
  };
}

/**
 * Renders and stores the transcript. `refType: 'close'` marks the copy a
 * close saves, and a retried close reuses it instead of saving another.
 */
export async function saveTranscript(
  db: SupabaseClient,
  room: RoomForTranscript,
  userId: string | null,
  refType: 'close' | null = null
): Promise<{ id: string; storage_path: string; name: string }> {
  if (refType) {
    const { data: existing, error } = await db
      .from('deal_files')
      .select('id, storage_path, name')
      .eq('room_id', room.id)
      .eq('source', 'transcript')
      .eq('ref_type', refType)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`transcript lookup failed: ${error.message}`);
    if (existing)
      return existing as { id: string; storage_path: string; name: string };
  }
  const html = renderTranscript(await loadTranscriptData(db, room));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `transcript-${stamp}.html`;
  const path = `account-${room.account_id}/room-${room.id}/${name}`;
  const bytes = Buffer.from(html, 'utf8');
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, bytes, {
      contentType: 'text/html; charset=utf-8',
      upsert: false,
    });
  if (upErr) throw new Error(`transcript upload failed: ${upErr.message}`);
  const row = {
    id: randomUUID(),
    account_id: room.account_id,
    deal_id: room.deal_id,
    room_id: room.id,
    storage_path: path,
    name,
    mime: 'text/html',
    bytes: bytes.length,
    source: 'transcript',
    ref_type: refType,
    created_by: userId,
  };
  const { error } = await db.from('deal_files').insert(row);
  if (error) throw new Error(`transcript not recorded: ${error.message}`);
  return { id: row.id, storage_path: path, name };
}
