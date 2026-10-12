/**
 * The team-chat composer's pure logic (no DOM, no I/O): readable
 * mentions in the input ("@Sara Ahmed") and the <@uuid> tokens
 * chat_post_message (087) records, the mention popover's candidates,
 * per-channel drafts, attachment chips, the body the RPC accepts and
 * the gate that mirrors chat_assert_can_write.
 */
import type { ChatErrorKey } from './errors';
import { formatMention, isUuid, mentionQueryAt } from './mentions';
import type { BroadcastKind, ChannelKind, ChatPerson } from './types';
import { CHAT_FILE_MAX_BYTES, CHAT_MAX_ATTACHMENTS } from './uploads';

/** internal_messages_body_len: 1–8000 characters (char_length, i.e. code points). */
export const CHAT_BODY_MAX = 8000;

/** One person picked from the popover; `label` is what follows the '@' in the input. */
export interface PickedMention {
  userId: string;
  label: string;
}

const WORD = '[\\p{L}\\p{N}_]';
const USER_TOKEN =
  /<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Character count as Postgres's char_length sees it. */
export const bodyLength = (s: string): number => [...s].length;

/**
 * The label a pick gets: the person's name, unless a DIFFERENT picked
 * person already shows that name, then "Name (2)", "Name (3)" … so
 * every label in the draft names exactly one person. Picking the same
 * person again reuses their label.
 */
export function mentionLabel(
  name: string,
  userId: string,
  picked: readonly PickedMention[]
): string {
  const id = userId.toLowerCase();
  const mine = picked.find((p) => p.userId === id);
  if (mine) return mine.label;
  const base = name.trim().replace(/\s+/g, ' ');
  const taken = new Set(picked.map((p) => p.label));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const label = `${base} (${n})`;
    if (!taken.has(label)) return label;
  }
}

/** `picked` plus one person (once per person). */
export function withPick(
  picked: readonly PickedMention[],
  pick: PickedMention
): PickedMention[] {
  const p = { userId: pick.userId.toLowerCase(), label: pick.label };
  return picked.some((x) => x.userId === p.userId)
    ? [...picked]
    : [...picked, p];
}

/**
 * The text as it is sent: every exact "@<label>" of a picked person
 * becomes their <@uuid> token. A match needs no letter, digit or '_'
 * right before the '@' or right after the label, and the longest label
 * wins ("@Sara Ahmed" over "@Sara"). A label the user edited ("@Sara
 * Ahme") or whose '@' they deleted is left as plain text.
 */
export function serializeDraft(
  text: string,
  picked: readonly PickedMention[]
): string {
  const byLabel = new Map<string, string>();
  for (const p of picked)
    if (p.label && isUuid(p.userId) && !byLabel.has(p.label))
      byLabel.set(p.label, p.userId);
  if (byLabel.size === 0) return text;
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(
    `(?<!${WORD})@(${labels.map(escapeRe).join('|')})(?!${WORD})`,
    'gu'
  );
  return text.replace(re, (_, label: string) =>
    formatMention(byLabel.get(label) as string)
  );
}

/**
 * A stored body back to editable text: known people's tokens become
 * "@Name" picks, an unknown person's token stays as it is. With
 * serializeDraft this round-trips the body.
 */
export function deserializeBody(
  body: string,
  people: ReadonlyMap<string, Pick<ChatPerson, 'fullName'>>
): { text: string; picked: PickedMention[] } {
  let picked: PickedMention[] = [];
  const text = body.replace(USER_TOKEN, (raw, id: string) => {
    const userId = id.toLowerCase();
    const name = people.get(userId)?.fullName?.trim();
    if (!name) return raw;
    const label = mentionLabel(name, userId, picked);
    picked = withPick(picked, { userId, label });
    return `@${label}`;
  });
  return { text, picked };
}

/**
 * Replaces the '@query' typed before the caret with `insert` (e.g.
 * "@Sara Ahmed") and a space; returns the new text and the caret after
 * that space.
 */
export function insertAtMention(
  text: string,
  caret: number,
  insert: string
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const q = mentionQueryAt(text, at);
  const start = q ? q.start : at;
  const lead = !q && start > 0 && !/\s/u.test(text[start - 1]) ? ' ' : '';
  const rest = text.slice(at);
  const token = lead + insert + (rest.startsWith(' ') ? '' : ' ');
  return {
    text: text.slice(0, start) + token + rest,
    caret: start + lead.length + insert.length + 1,
  };
}

export type MentionCandidate =
  | { type: 'person'; person: ChatPerson; name: string }
  | { type: 'broadcast'; kind: BroadcastKind };

/**
 * The popover's list for '@query': named people whose name (or a word
 * of it) starts with the query, name-prefix matches first, then
 * @channel / @here when `broadcasts` (team and private channels).
 */
export function mentionCandidates(
  people: readonly ChatPerson[],
  query: string,
  opts: { broadcasts: boolean; limit?: number }
): MentionCandidate[] {
  const q = query.toLowerCase();
  const ranked: { c: MentionCandidate & { type: 'person' }; rank: number }[] =
    [];
  for (const person of people) {
    const name = person.fullName?.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const lower = name.toLowerCase();
    const rank = lower.startsWith(q)
      ? 0
      : lower.split(' ').some((w) => w.startsWith(q))
        ? 1
        : -1;
    if (rank >= 0) ranked.push({ c: { type: 'person', person, name }, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name));
  const out: MentionCandidate[] = ranked
    .slice(0, opts.limit ?? 8)
    .map((r) => r.c);
  if (opts.broadcasts)
    for (const kind of ['channel', 'here'] as const)
      if (kind.startsWith(q)) out.push({ type: 'broadcast', kind });
  return out;
}

// ---------- drafts ----------

export interface ComposerDraft {
  text: string;
  picked: PickedMention[];
}

export const draftStorageKey = (
  channelId: string,
  threadRootId?: string | null
): string =>
  `wacrm.chat.draft.${channelId.toLowerCase()}${
    threadRootId ? `.${threadRootId.toLowerCase()}` : ''
  }`;

/** JSON for localStorage; null when there is nothing worth keeping. */
export function encodeDraft(d: ComposerDraft): string | null {
  if (!d.text.trim()) return null;
  const label = (p: PickedMention) => d.text.includes(`@${p.label}`);
  return JSON.stringify({ text: d.text, picked: d.picked.filter(label) });
}

/** Tolerant: anything unreadable is an empty draft. */
export function decodeDraft(raw: string | null | undefined): ComposerDraft {
  const empty = { text: '', picked: [] };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as { text?: unknown; picked?: unknown };
    if (typeof v?.text !== 'string') return empty;
    const picked = Array.isArray(v.picked)
      ? v.picked.flatMap((p: unknown) => {
          const { userId, label } = (p ?? {}) as Record<string, unknown>;
          return isUuid(userId) && typeof label === 'string' && label
            ? [{ userId: userId.toLowerCase(), label }]
            : [];
        })
      : [];
    return { text: v.text, picked };
  } catch {
    return empty;
  }
}

// ---------- body and files ----------

/** The files that fit: none over 25 MB, at most 10 in all; `rejected` names why some did not. */
export function acceptFiles<T extends { name: string; size: number }>(
  currentCount: number,
  incoming: readonly T[]
): { accepted: T[]; rejected: ChatErrorKey | null } {
  const small = incoming.filter((f) => f.size <= CHAT_FILE_MAX_BYTES);
  const room = Math.max(0, CHAT_MAX_ATTACHMENTS - currentCount);
  const accepted = small.slice(0, room);
  const rejected: ChatErrorKey | null =
    small.length < incoming.length
      ? 'fileTooLarge'
      : accepted.length < small.length
        ? 'tooManyFiles'
        : null;
  return { accepted, rejected };
}

/** The body of a message that is only files: their names, within the limit. */
export function filesOnlyBody(names: readonly string[]): string {
  const joined = names
    .map((n) => n.trim())
    .filter(Boolean)
    .join(', ');
  return [...(joined || 'file')].slice(0, CHAT_BODY_MAX).join('');
}

export type ComposedBody =
  { ok: true; body: string } | { ok: false; reason: 'empty' | 'bodyLength' };

/** What Send posts: the serialized text, else the file names; never blank or over 8000. */
export function composeBody(
  text: string,
  picked: readonly PickedMention[],
  fileNames: readonly string[]
): ComposedBody {
  const body = serializeDraft(text, picked).trim();
  if (body)
    return bodyLength(body) > CHAT_BODY_MAX
      ? { ok: false, reason: 'bodyLength' }
      : { ok: true, body };
  return fileNames.length
    ? { ok: true, body: filesOnlyBody(fileNames) }
    : { ok: false, reason: 'empty' };
}

// ---------- who may post ----------

export type ComposerBlock =
  'disabled' | 'archived' | 'guestNotes' | 'guestPrivateOnly' | 'notMember';

/**
 * Why the composer is replaced by a notice, in chat_assert_can_write's
 * order (087); null = may post. A bank guest posts only in private
 * channels they belong to (never a deal room's Team notes); anyone else
 * joins a team channel by posting.
 */
export function composerBlock(i: {
  kind: ChannelKind;
  archived: boolean;
  member: boolean;
  bankGuest: boolean;
  chatEnabled: boolean;
}): ComposerBlock | null {
  if (!i.chatEnabled) return 'disabled';
  if (i.archived) return 'archived';
  if (i.bankGuest && i.kind === 'deal_room') return 'guestNotes';
  if (i.bankGuest && i.kind !== 'private') return 'guestPrivateOnly';
  if (!i.member && i.kind !== 'team') return 'notMember';
  return null;
}

/** A refused post whose reason holds for every later post too. */
export function blockFromError(key: ChatErrorKey): ComposerBlock | null {
  switch (key) {
    case 'disabled':
      return 'disabled';
    case 'archived':
      return 'archived';
    case 'notChannelMember':
      return 'notMember';
    default:
      return null;
  }
}
