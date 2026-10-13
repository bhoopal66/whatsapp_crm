/**
 * The viewer's saved messages (087 `saved_messages`, own rows only by
 * RLS) for the Saved screen and the sidebar's count. The message is an
 * inner embed under its own RLS, so a save whose message the viewer can
 * no longer read does not come back, and the account filter keeps other
 * workspaces' saves out.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { MESSAGE_COLUMNS } from './api';
import { chatHref } from './compose';
import { toChatError } from './errors';
import {
  toChannel,
  toChatMessage,
  type Channel,
  type ChatMessage,
} from './types';

type Row = Record<string, unknown>;

export const SAVED_PATH = '/chat/saved';
/** The Saved screen lists at most this many, newest saved first. */
export const SAVED_LIMIT = 200;

export interface SavedItem {
  messageId: string;
  savedAt: string;
  message: ChatMessage;
  /** The message's channel; null if it did not come back. */
  channel: Channel | null;
}

// The channel embed names its foreign key: message_pins is a second
// path between messages and channels, and an unnamed embed is ambiguous
// to PostgREST (PGRST201), so Saved items never loaded.
export const SAVED_SELECT = `message_id,saved_at,message:internal_messages!inner(${MESSAGE_COLUMNS},channel:chat_channels!internal_messages_channel_id_fkey(*))`;

const obj = (v: unknown): Row | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null;

export function toSavedItem(r: Row): SavedItem | null {
  const m = obj(r.message);
  if (!m) return null;
  const ch = obj(m.channel);
  return {
    messageId: String(r.message_id),
    savedAt: String(r.saved_at),
    message: toChatMessage(m),
    channel: ch ? toChannel(ch) : null,
  };
}

export async function listSaved(
  sb: SupabaseClient,
  accountId: string
): Promise<SavedItem[]> {
  const { data, error } = await sb
    .from('saved_messages')
    .select(SAVED_SELECT)
    .eq('message.account_id', accountId)
    .order('saved_at', { ascending: false })
    .order('message_id', { ascending: false })
    .limit(SAVED_LIMIT);
  if (error) throw toChatError(error);
  return ((data as Row[] | null) ?? [])
    .map(toSavedItem)
    .filter((x): x is SavedItem => x !== null);
}

export async function countSaved(
  sb: SupabaseClient,
  accountId: string
): Promise<number> {
  const { count, error } = await sb
    .from('saved_messages')
    .select('message_id,message:internal_messages!inner(account_id)', {
      count: 'exact',
      head: true,
    })
    .eq('message.account_id', accountId);
  if (error) throw toChatError(error);
  return count ?? 0;
}

/** A reply opens its thread; anything else opens at the message. */
export function savedHref(
  m: Pick<ChatMessage, 'id' | 'channelId' | 'threadRootId'>
): string {
  return m.threadRootId
    ? chatHref(m.channelId, { thread: m.threadRootId })
    : chatHref(m.channelId, { message: m.id });
}

export type SavedTombstone = 'deleted' | 'erased' | null;

export const savedTombstone = (
  m: Pick<ChatMessage, 'deletedAt' | 'erasedAt'>
): SavedTombstone => (m.deletedAt ? 'deleted' : m.erasedAt ? 'erased' : null);

export const isSavedPath = (pathname: string | null | undefined): boolean =>
  pathname === SAVED_PATH;

/**
 * Saves have no realtime feed (saved_messages is not published), so a
 * screen that changes them says so here and the sidebar's count re-reads.
 */
const listeners = new Set<() => void>();

export function emitSavedChange(): void {
  listeners.forEach((fn) => fn());
}

export function onSavedChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
