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

/**
 * The inbox page's handler for a save's result, built over its two
 * state setters: the list row is patched by id, the open chat only if
 * it is still that chat. Holds no state of its own, so the page can
 * build it once — a handler that read the open chat from its closure
 * is exactly what patched the wrong chat.
 */
export function conversationPatcher<T extends { id: string }>(
  setList: (update: (prev: T[]) => T[]) => void,
  setActive: (update: (prev: T | null) => T | null) => void
): (conversationId: string, patch: Partial<T>) => void {
  return (conversationId, patch) => {
    setList((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, ...patch } : c))
    );
    setActive((prev) => patchIfSameConversation(prev, conversationId, patch));
  };
}
