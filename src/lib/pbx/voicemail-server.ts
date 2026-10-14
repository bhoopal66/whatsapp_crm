import type { SupabaseClient } from '@supabase/supabase-js';
import { contactPhoneCandidates, normalizeRemoteNumber } from './phone';
import type { VoicemailItem } from './voicemail';
import {
  parsePbxTime,
  type VoicemailMessage,
  type YeastarApi,
} from './yeastar';

// The /api/pbx/voicemail routes' shared server side. The box is always
// the caller's own extension (pbx_my_extension); an id from the browser
// is acted on only once that box lists it.

/** The list route reads one page of this many. */
export const VOICEMAIL_PAGE_SIZE = 100;
/** Pages read looking for an id before calling it not the caller's. */
export const VOICEMAIL_MAX_PAGES = 10;

/**
 * The message `id` in `extension`'s own box, or null: paged through
 * `vm/get` up to {@link VOICEMAIL_MAX_PAGES}. The ownership check for
 * play, read and delete, so an id alone never reaches another box.
 */
export async function findOwnVoicemail(
  api: Pick<YeastarApi, 'listVoicemail'>,
  extension: string,
  id: string
): Promise<VoicemailMessage | null> {
  for (let page = 1; page <= VOICEMAIL_MAX_PAGES; page++) {
    const { total, items } = await api.listVoicemail({
      number: extension,
      page,
      pageSize: VOICEMAIL_PAGE_SIZE,
    });
    const hit = items.find((m) => m.msgId === id);
    if (hit) return hit;
    if (items.length === 0 || page * VOICEMAIL_PAGE_SIZE >= total) break;
  }
  return null;
}

/**
 * Each caller number's contact in `accountId`, among those the caller's
 * client can see (one read by every digits-only form of every number,
 * as the event processor matches). Internal numbers (another extension)
 * are never matched.
 */
export async function voicemailContacts(
  rls: SupabaseClient,
  accountId: string,
  numbers: string[]
): Promise<Map<string, string>> {
  const forms = new Map<string, string[]>();
  for (const raw of new Set(numbers)) {
    const n = normalizeRemoteNumber(raw);
    if (n && !n.internal) forms.set(raw, contactPhoneCandidates(n.number));
  }
  const out = new Map<string, string>();
  const all = [...new Set([...forms.values()].flat())];
  if (!all.length) return out;
  const { data, error } = await rls
    .from('contacts')
    .select('id, phone_normalized')
    .eq('account_id', accountId)
    .in('phone_normalized', all);
  if (error) throw new Error(`contacts read failed: ${error.message}`);
  const byPhone = new Map<string, string>();
  for (const c of (data ?? []) as {
    id: string;
    phone_normalized: string | null;
  }[])
    if (c.phone_normalized && !byPhone.has(c.phone_normalized))
      byPhone.set(c.phone_normalized, c.id);
  for (const [raw, candidates] of forms) {
    const id = candidates.map((p) => byPhone.get(p)).find(Boolean);
    if (id) out.set(raw, id);
  }
  return out;
}

/** The route's view of the PBX's messages, newest first. */
export function voicemailItems(
  messages: VoicemailMessage[],
  contacts: Map<string, string> = new Map()
): VoicemailItem[] {
  const items = messages.map((m) => ({
    id: m.msgId,
    callerNumber: m.callerNumber,
    callerName: m.callerName,
    at: parsePbxTime(m.time),
    durationSeconds: m.durationSeconds,
    read: m.read,
    contactId: contacts.get(m.callerNumber) ?? null,
  }));
  const time = (i: VoicemailItem) => (i.at ? Date.parse(i.at) : -Infinity);
  return items.sort((a, b) => time(b) - time(a));
}

const AUDIO_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  gsm: 'audio/x-gsm',
};

/** The PBX's audio type when it sends one, else by the file's extension. */
export function voicemailAudioType(
  fileName: string,
  upstream: string | null
): string {
  const sent = (upstream ?? '').split(';')[0].trim().toLowerCase();
  if (sent.startsWith('audio/')) return sent;
  const ext = /\.([a-z0-9]{2,4})$/i.exec(fileName)?.[1]?.toLowerCase();
  return (ext && AUDIO_TYPES[ext]) || 'audio/wav';
}
