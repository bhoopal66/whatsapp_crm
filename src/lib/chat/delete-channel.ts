/**
 * Deleting a channel for good (migration 172). Who may is the database's
 * answer (`canDeleteChannel`), never decided here.
 */
import type { ChannelKind } from './types';

/** A DM or deal room is never deleted, so the database is not even asked. */
export const offersChannelDelete = (kind: ChannelKind): boolean =>
  kind === 'team' || kind === 'private';

/**
 * Does the typed text confirm the delete? Exact, as chat_delete_channel
 * compares it: no trimming and no case folding, or the button would
 * light up for an answer the database then refuses.
 */
export const confirmDeletable = (typed: string, name: string | null): boolean =>
  !!name && typed === name;

/**
 * Has this channel left a loaded list? Its side panels close then: with
 * the channel unknown they would read as open to writing.
 */
export const channelGone = (
  channels: readonly { id: string }[] | null,
  channelId: string
): boolean => channels !== null && !channels.some((c) => c.id === channelId);
