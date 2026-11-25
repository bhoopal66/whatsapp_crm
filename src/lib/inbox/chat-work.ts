/** How many jobs of one kind run in each chat; chats with none are absent. */
export type ChatWork = Readonly<Record<string, number>>;

export const NO_CHAT_WORK: ChatWork = {};

export function beginWork(work: ChatWork, chatId: string | null): ChatWork {
  return chatId === null
    ? work
    : { ...work, [chatId]: (work[chatId] ?? 0) + 1 };
}

export function endWork(work: ChatWork, chatId: string | null): ChatWork {
  if (chatId === null || !work[chatId]) return work;
  const next = { ...work };
  if (next[chatId] > 1) next[chatId] -= 1;
  else delete next[chatId];
  return next;
}

export function hasWork(work: ChatWork, chatId: string): boolean {
  return (work[chatId] ?? 0) > 0;
}

/**
 * A picker opened for `openedFor` is open only in that chat: after a
 * switch it counts as closed, and a pick it still delivers is dropped.
 */
export function isOpenFor(
  openedFor: string | null,
  chatId: string | null
): boolean {
  return openedFor !== null && openedFor === chatId;
}
