import type { Message } from '@/types';

/** One opening of the Forward dialog. */
export interface ForwardEntry {
  /** Unique per opening. */
  id: number;
  conversationId: string;
  message: Message;
  /** False once closed; the entry stays so the dialog can animate out. */
  open: boolean;
}

/**
 * The dialog's React key: its picks and its sending state belong to one
 * message of one chat, so either changing starts it afresh.
 */
export function forwardDialogKey(
  entry: ForwardEntry | null,
  conversationId: string
): string {
  return entry?.conversationId === conversationId
    ? `${conversationId}:${entry.message.id}`
    : conversationId;
}

/** The message the dialog shows in this chat; null keeps it closed. */
export function forwardMessage(
  entry: ForwardEntry | null,
  conversationId: string
): Message | null {
  return entry?.open && entry.conversationId === conversationId
    ? entry.message
    : null;
}

/**
 * Close opening `id` only: a send left running in another chat finishes
 * later, and must not close the dialog opened since.
 */
export function closeForward(
  entry: ForwardEntry | null,
  id: number
): ForwardEntry | null {
  return entry?.id === id ? { ...entry, open: false } : entry;
}
