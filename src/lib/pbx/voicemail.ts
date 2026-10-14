// Voicemail in the CRM (replacing the Linkus app's): what the
// /api/pbx/voicemail routes answer, and the pure helpers the panel
// formats it with. Client-safe: no server imports.

/** One message in the caller's own box, as GET /api/pbx/voicemail sends it. */
export interface VoicemailItem {
  /** The PBX's msg_id. */
  id: string;
  callerNumber: string;
  callerName: string;
  /** ISO instant, or null when the PBX's time could not be read. */
  at: string | null;
  durationSeconds: number;
  read: boolean;
  /** A contact the caller can see holding the caller's number. */
  contactId: string | null;
}

export interface VoicemailListResponse {
  messages: VoicemailItem[];
  /** Unread among `messages` (the first page only). */
  unread: number;
  /** Every message in the box, as the PBX counts them. */
  total: number;
}

/** A msg_id as the PBX writes them ("1713840555-00000623"). */
const VOICEMAIL_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const isVoicemailId = (id: string): boolean => VOICEMAIL_ID.test(id);

/**
 * Who left the message: the PBX's caller name when it says more than the
 * number, else the number; null for neither (a withheld number).
 */
export function voicemailCaller(
  m: Pick<VoicemailItem, 'callerName' | 'callerNumber'>
): { primary: string; secondary: string | null } | null {
  const name = m.callerName.trim();
  const number = m.callerNumber.trim();
  if (name && name !== number)
    return { primary: name, secondary: number || null };
  if (number) return { primary: number, secondary: null };
  return null;
}

/** "0:42", "12:05", "1:02:09". */
export function voicemailDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The message's time in the viewer's locale; '' when unknown. */
export function voicemailTime(
  at: string | null,
  locale: string,
  timeZone?: string
): string {
  const ms = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(ms));
}

/** The list after `id` was marked read, and its unread count. */
export function markedRead(
  list: VoicemailListResponse,
  id: string
): VoicemailListResponse {
  const hit = list.messages.find((m) => m.id === id && !m.read);
  if (!hit) return list;
  return {
    ...list,
    messages: list.messages.map((m) => (m === hit ? { ...m, read: true } : m)),
    unread: Math.max(0, list.unread - 1),
  };
}

/** The list after `id` was deleted. */
export function removed(
  list: VoicemailListResponse,
  id: string
): VoicemailListResponse {
  const hit = list.messages.find((m) => m.id === id);
  if (!hit) return list;
  return {
    messages: list.messages.filter((m) => m !== hit),
    unread: hit.read ? list.unread : Math.max(0, list.unread - 1),
    total: Math.max(0, list.total - 1),
  };
}

/** The audio route of a message, for an <audio> src. */
export const voicemailAudioPath = (id: string) =>
  `/api/pbx/voicemail/${encodeURIComponent(id)}/audio`;
