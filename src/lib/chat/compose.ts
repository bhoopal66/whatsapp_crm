/**
 * The New-channel dialog, the DM picker and the /chat/<id> URL state
 * (?thread=, ?message=): pure pieces, so they test without a DOM.
 */
import type { Channel, ChatPerson } from './types';

export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_TOPIC_MAX = 250;
/** chat_open_dm takes 2–8 people, the caller included. */
export const DM_MAX_OTHERS = 7;

/** As typed: lowercase, every run of whitespace one hyphen. */
export function normalizeChannelName(raw: string): string {
  return [...raw.toLowerCase().replace(/\s+/g, '-')]
    .slice(0, CHANNEL_NAME_MAX)
    .join('');
}

/** As saved: the typed form without leading or trailing hyphens. */
export const finalChannelName = (raw: string): string =>
  normalizeChannelName(raw.trim()).replace(/^-+|-+$/g, '');

export type NameProblem = 'empty' | 'taken';

/**
 * 'taken' is only what the viewer can see (others' private channels are
 * invisible), so the unique index can still refuse: errors.duplicateName.
 */
export function channelNameProblem(
  raw: string,
  channels: readonly Pick<Channel, 'kind' | 'name' | 'archivedAt'>[]
): NameProblem | null {
  const name = finalChannelName(raw);
  if (!name) return 'empty';
  const taken = channels.some(
    (c) =>
      (c.kind === 'team' || c.kind === 'private') &&
      !c.archivedAt &&
      c.name?.trim().toLowerCase() === name
  );
  return taken ? 'taken' : null;
}

/** Adds or removes `id`; adding stops at `max`. */
export function togglePick(
  picked: readonly string[],
  id: string,
  max = Infinity
): string[] {
  if (picked.includes(id)) return picked.filter((x) => x !== id);
  return picked.length >= max ? [...picked] : [...picked, id];
}

/** Everyone a DM may include besides the viewer: no bank guests. */
export function dmCandidates(
  people: readonly ChatPerson[],
  userId: string | null
): ChatPerson[] {
  const me = userId?.toLowerCase();
  return people.filter(
    (p) => p.role !== 'bank_guest' && p.userId.toLowerCase() !== me
  );
}

/**
 * The DM candidates the workspace's message rules allow (143's
 * chat_dm_peers). `peers` null (not loaded, or the RPC failed) leaves
 * the list as it is: the server still refuses a DM it does not allow.
 * `hidden` counts the candidates the rules left out.
 */
export function allowedDmCandidates(
  candidates: readonly ChatPerson[],
  peers: readonly string[] | null
): { people: ChatPerson[]; hidden: number } {
  if (!peers) return { people: [...candidates], hidden: 0 };
  const ok = new Set(peers.map((id) => id.toLowerCase()));
  const people = candidates.filter((p) => ok.has(p.userId.toLowerCase()));
  return { people, hidden: candidates.length - people.length };
}

/** Case- and accent-insensitive name filter for the pickers. */
export function filterPeople(
  people: readonly ChatPerson[],
  query: string
): ChatPerson[] {
  const fold = (s: string) =>
    s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  if (!q) return [...people];
  return people.filter((p) => fold(p.fullName ?? '').includes(q));
}

/** The query string with `key` set (or removed for null), '' when empty. */
export function withParam(
  search: string,
  key: string,
  value: string | null
): string {
  const params = new URLSearchParams(search);
  if (value) params.set(key, value);
  else params.delete(key);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** A link into a channel, optionally at a message and/or with a thread open. */
export function chatHref(
  channelId: string,
  at: { message?: string | null; thread?: string | null } = {}
): string {
  let q = withParam('', 'thread', at.thread ?? null);
  q = withParam(q, 'message', at.message ?? null);
  return `/chat/${channelId}${q}`;
}

/** Older pages a jump may read before it gives up. */
export const FOCUS_MAX_PAGES = 20;

export type FocusStep = 'scroll' | 'loadOlder' | 'wait' | 'giveUp';

/** The next move of a jump to a message in a timeline that pages backwards. */
export function focusStep(i: {
  found: boolean;
  loading: boolean;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  pagesRead: number;
}): FocusStep {
  if (i.found) return 'scroll';
  if (i.loading || i.loadingOlder) return 'wait';
  if (i.hasMoreOlder && i.pagesRead < FOCUS_MAX_PAGES) return 'loadOlder';
  return 'giveUp';
}
