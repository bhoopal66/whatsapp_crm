// ============================================================
// "Check before sending": the composer's state machine, pure.
//
// The composer outlives a chat switch, so a check in flight (or its
// warning dialog) can belong to a chat that is no longer open. The rule:
// never send to the wrong chat and never lose text silently. A switch
// abandons the check, parks the typed text (and its reply quote) for the
// chat it was written in, empties the box and says so; coming back to
// that chat puts the text back into an empty box.
//
// Dependency-free like compose-check-view.ts (client code only). The
// reducer returns effects; the composer runs them. `P` is the opaque
// send the composer hands in (a closure); `R` is its reply quote.
// ============================================================

import {
  shouldCheckDraft,
  type ComposeCheckCode,
  type ComposeCheckDecision,
  type ComposeCheckMode,
} from './compose-check-view';

/** What a switch parks for the chat a draft was written in. */
export interface ParkedDraft<R = unknown> {
  text: string;
  reply: R | null;
  /** The box's origin mark (the missed-call draft), opaque here. */
  origin: string | null;
}

interface InFlight<P, R> {
  token: number;
  conversationId: string;
  text: string;
  focus: 'text' | 'caption';
  payload: P;
  /** What to park on a switch; null for a caption (it is not in the box). */
  park: ParkedDraft<R> | null;
  contactName: string | null;
}

export type ComposeFlowState<P, R = unknown> =
  | { phase: 'idle'; nextToken: number }
  | ({ phase: 'checking'; nextToken: number } & InFlight<P, R>)
  | ({
      phase: 'review';
      nextToken: number;
      warnings: ComposeCheckCode[];
      eventId: string | null;
    } & InFlight<P, R>);

export type ComposeFlowEvent<P, R = unknown> =
  | {
      type: 'submit';
      mode: ComposeCheckMode | null | undefined;
      conversationId: string;
      text: string;
      focus: 'text' | 'caption';
      payload: P;
      park: ParkedDraft<R> | null;
      contactName: string | null;
    }
  | { type: 'answer'; token: number; decision: ComposeCheckDecision }
  | { type: 'sendAnyway' }
  | { type: 'edit' }
  /** The staged attachment was discarded: its caption check is moot. */
  | { type: 'discardAttachment' }
  /** The composer now shows `to` (null: it is going away). */
  | { type: 'switch'; to: string | null; boxText: string };

export type ComposeFlowEffect<P, R = unknown> =
  | { type: 'send'; payload: P }
  | { type: 'check'; token: number; conversationId: string; text: string }
  | { type: 'abort' }
  | { type: 'report'; eventId: string; outcome: 'sent_anyway' | 'edited' }
  | { type: 'park'; conversationId: string; draft: ParkedDraft<R> }
  | { type: 'clearBox' }
  | { type: 'notifyParked'; contactName: string | null };

export interface ComposeFlowStep<P, R> {
  state: ComposeFlowState<P, R>;
  effects: ComposeFlowEffect<P, R>[];
}

export function initialComposeFlow<P, R = unknown>(): ComposeFlowState<P, R> {
  return { phase: 'idle', nextToken: 1 };
}

const idle = <P, R>(nextToken: number): ComposeFlowState<P, R> => ({
  phase: 'idle',
  nextToken,
});

/** Leave a check or review without sending: abort or record "edited". */
function abandon<P, R>(
  state: Exclude<ComposeFlowState<P, R>, { phase: 'idle' }>
): ComposeFlowEffect<P, R>[] {
  if (state.phase === 'checking') return [{ type: 'abort' }];
  return state.eventId
    ? [{ type: 'report', eventId: state.eventId, outcome: 'edited' }]
    : [];
}

export function composeFlow<P, R = unknown>(
  state: ComposeFlowState<P, R>,
  event: ComposeFlowEvent<P, R>
): ComposeFlowStep<P, R> {
  const same = { state, effects: [] as ComposeFlowEffect<P, R>[] };
  switch (event.type) {
    case 'submit': {
      // Mode off, or too short: straight out, exactly as before.
      if (!shouldCheckDraft(event.mode, event.text))
        return { state, effects: [{ type: 'send', payload: event.payload }] };
      // A check or a dialog is already open: a second Enter does nothing.
      if (state.phase !== 'idle') return same;
      const token = state.nextToken;
      return {
        state: {
          phase: 'checking',
          nextToken: token + 1,
          token,
          conversationId: event.conversationId,
          text: event.text,
          focus: event.focus,
          payload: event.payload,
          park: event.park,
          contactName: event.contactName,
        },
        effects: [
          {
            type: 'check',
            token,
            conversationId: event.conversationId,
            text: event.text.trim(),
          },
        ],
      };
    }
    case 'answer': {
      // A stale answer (switched, discarded, or an older check): ignored.
      if (state.phase !== 'checking' || state.token !== event.token)
        return same;
      const { decision } = event;
      if (decision.kind === 'cancelled')
        return { state: idle(state.nextToken), effects: [] };
      if (decision.kind === 'send')
        return {
          state: idle(state.nextToken),
          effects: [{ type: 'send', payload: state.payload }],
        };
      return {
        state: {
          ...state,
          phase: 'review',
          warnings: decision.warnings,
          eventId: decision.eventId,
        },
        effects: [],
      };
    }
    case 'sendAnyway': {
      if (state.phase !== 'review') return same;
      const effects: ComposeFlowEffect<P, R>[] = [
        { type: 'send', payload: state.payload },
      ];
      if (state.eventId)
        effects.push({
          type: 'report',
          eventId: state.eventId,
          outcome: 'sent_anyway',
        });
      return { state: idle(state.nextToken), effects };
    }
    case 'edit': {
      if (state.phase !== 'review') return same;
      return { state: idle(state.nextToken), effects: abandon(state) };
    }
    case 'discardAttachment': {
      if (state.phase === 'idle' || state.focus !== 'caption') return same;
      return { state: idle(state.nextToken), effects: abandon(state) };
    }
    case 'switch': {
      if (state.phase === 'idle' || state.conversationId === event.to)
        return same;
      const effects = abandon(state);
      if (state.park) {
        // The box as it is now (a failed send's words may have come back
        // meanwhile), else what was submitted.
        const text = event.boxText.trim() ? event.boxText : state.park.text;
        effects.push({
          type: 'park',
          conversationId: state.conversationId,
          draft: { ...state.park, text },
        });
        if (event.to !== null) effects.push({ type: 'clearBox' });
        effects.push({ type: 'notifyParked', contactName: state.contactName });
      }
      return { state: idle(state.nextToken), effects };
    }
  }
}

/** Parked drafts by conversation id; the composer keeps one per tab. */
export type ParkedDrafts<R = unknown> = Map<string, ParkedDraft<R>>;

/**
 * The draft parked for `conversationId`, taken out of the stash, when
 * the box is empty. With text in the box it stays parked: nothing is
 * overwritten and nothing is dropped.
 */
export function takeParkedDraft<R>(
  stash: ParkedDrafts<R>,
  conversationId: string,
  boxText: string
): ParkedDraft<R> | null {
  const parked = stash.get(conversationId);
  if (!parked || boxText.trim()) return null;
  stash.delete(conversationId);
  return parked;
}
