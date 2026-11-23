/**
 * Reply or Note, for the chat that is open. Every opening starts on
 * Reply, coming back to a chat left on Note included: a note box that
 * reopened by itself took the customer's answer as an internal note.
 * The choice lasts only while its chat stays open. Pure.
 */
export interface ComposerModeState {
  conversationId: string | null;
  mode: 'reply' | 'note';
}

/**
 * The mode for the chat open now: the same state while it stays open, a
 * fresh Reply one when another chat (or none) is. The thread stores the
 * answer on every change, so a choice made before a switch is gone.
 */
export function composerModeFor(
  state: ComposerModeState,
  conversationId: string | null
): ComposerModeState {
  return state.conversationId === conversationId
    ? state
    : { conversationId, mode: 'reply' };
}
