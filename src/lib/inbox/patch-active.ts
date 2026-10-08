// ============================================================
// Patching the open chat with the result of a save.
//
// A save (a chat tag pick, an assignment) can land after the agent
// has opened another chat: through the production tunnel a write
// takes ~700 ms. The handler that receives it may have been created
// while the old chat was open, so checking its captured
// `activeConversation` is not enough. The check has to run inside the
// state updater, against the chat that is open *now*, or the old
// chat's result is spread onto the new one's header.
// ============================================================

/**
 * `prev` with `patch` applied when it is the chat `conversationId`;
 * otherwise `prev` itself, the same reference, so React keeps the
 * state as it is.
 */
export function patchIfSameConversation<T extends { id: string }>(
  prev: T | null,
  conversationId: string,
  patch: Partial<T>
): T | null {
  if (!prev || prev.id !== conversationId) return prev;
  return { ...prev, ...patch };
}
