// ============================================================
// "Check before sending": the composer's state machine, pure.
//
// The composer outlives a chat switch, so a check in flight (or its
// warning dialog) can belong to a chat that is no longer open. The rule:
// never send to the wrong chat and never lose text silently. A switch
// abandons the check, parks the typed text (and its reply quote) for the
// chat it was written in, empties the box and says so; coming back to
// that chat puts the text back into an empty box. A caption check parks
// the staged attachment (caption included) the same way and unstages
// it, so one click can never send it into the next chat; it comes back
// when that chat is shown again with nothing staged.
//
// Dependency-free like compose-check-view.ts (client code only). The
// reducer returns effects; the composer runs them. `P` is the opaque
// send the composer hands in (a closure); `R` is its reply quote; `A`
// its staged attachment.
// ============================================================

import {
  shouldCheckDraft,
  type ComposeCheckCode,
  type ComposeCheckDecision,
  type ComposeCheckMode,
} from './compose-check-view';

/** What a switch parks for the chat a draft was written in. */
export interface ParkedDraft<R = unknown, A = unknown> {
  /** Typed text for the box; '' when only an attachment is parked. */
  text: string;
  reply: R | null;
  /** The box's origin mark (the missed-call draft), opaque here. */
  origin: string | null;
  /** A staged attachment with its caption, opaque here; null for text. */
  attachment: A | null;
}

interface InFlight<P, R, A> {
  token: number;
  conversationId: string;
  text: string;
  focus: 'text' | 'caption';
  payload: P;
  /** What to park on a switch: the typed text, or the staged attachment. */
  park: ParkedDraft<R, A> | null;
  contactName: string | null;
}

export type ComposeFlowState<P, R = unknown, A = unknown> =
  | { phase: 'idle'; nextToken: number }
  | ({ phase: 'checking'; nextToken: number } & InFlight<P, R, A>)
  | ({
      phase: 'review';
      nextToken: number;
      warnings: ComposeCheckCode[];
      eventId: string | null;
    } & InFlight<P, R, A>);

export type ComposeFlowEvent<P, R = unknown, A = unknown> =
  | {
      type: 'submit';
      mode: ComposeCheckMode | null | undefined;
      conversationId: string;
      text: string;
      focus: 'text' | 'caption';
      payload: P;
      park: ParkedDraft<R, A> | null;
      contactName: string | null;
    }
  | { type: 'answer'; token: number; decision: ComposeCheckDecision }
  | { type: 'sendAnyway' }
  | { type: 'edit' }
  /** The staged attachment was discarded: its caption check is moot. */
  | { type: 'discardAttachment' }
  /**
   * The composer now shows `to` (null: it is going away). `boxText` and
   * `staged` are the box and the staged attachment as they are now.
   */
  | { type: 'switch'; to: string | null; boxText: string; staged: A | null };

export type ComposeFlowEffect<P, R = unknown, A = unknown> =
  | { type: 'send'; payload: P }
  | { type: 'check'; token: number; conversationId: string; text: string }
  | { type: 'abort' }
  | { type: 'report'; eventId: string; outcome: 'sent_anyway' | 'edited' }
  | { type: 'park'; conversationId: string; draft: ParkedDraft<R, A> }
  | { type: 'clearBox' }
  /** Unstage the attachment without deleting it: the stash owns it now. */
  | { type: 'clearAttachment' }
  | {
      type: 'notifyParked';
      contactName: string | null;
      what: 'text' | 'attachment';
    };

export interface ComposeFlowStep<P, R, A = unknown> {
  state: ComposeFlowState<P, R, A>;
  effects: ComposeFlowEffect<P, R, A>[];
}

export function initialComposeFlow<
  P,
  R = unknown,
  A = unknown,
>(): ComposeFlowState<P, R, A> {
  return { phase: 'idle', nextToken: 1 };
}

const idle = <P, R, A>(nextToken: number): ComposeFlowState<P, R, A> => ({
  phase: 'idle',
  nextToken,
});

/** Leave a check or review without sending: abort or record "edited". */
function abandon<P, R, A>(
  state: Exclude<ComposeFlowState<P, R, A>, { phase: 'idle' }>
): ComposeFlowEffect<P, R, A>[] {
  if (state.phase === 'checking') return [{ type: 'abort' }];
  return state.eventId
    ? [{ type: 'report', eventId: state.eventId, outcome: 'edited' }]
    : [];
}

export function composeFlow<P, R = unknown, A = unknown>(
  state: ComposeFlowState<P, R, A>,
  event: ComposeFlowEvent<P, R, A>
): ComposeFlowStep<P, R, A> {
  const same = { state, effects: [] as ComposeFlowEffect<P, R, A>[] };
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
      const effects: ComposeFlowEffect<P, R, A>[] = [
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
      if (state.park && state.focus === 'caption') {
        // The attachment as it is now (its caption may have been edited
        // under the dialog), else what was submitted. It leaves the
        // composer even when the composer is going away: unstaged, it is
        // not deleted as an unsent leftover.
        const attachment = event.staged ?? state.park.attachment;
        effects.push({
          type: 'park',
          conversationId: state.conversationId,
          draft: { ...state.park, text: '', origin: null, attachment },
        });
        effects.push({ type: 'clearAttachment' });
        effects.push({
          type: 'notifyParked',
          contactName: state.contactName,
          what: 'attachment',
        });
      } else if (state.park) {
        // The box as it is now (a failed send's words may have come back
        // meanwhile), else what was submitted.
        const text = event.boxText.trim() ? event.boxText : state.park.text;
        effects.push({
          type: 'park',
          conversationId: state.conversationId,
          draft: { ...state.park, text, attachment: null },
        });
        if (event.to !== null) effects.push({ type: 'clearBox' });
        effects.push({
          type: 'notifyParked',
          contactName: state.contactName,
          what: 'text',
        });
      }
      return { state: idle(state.nextToken), effects };
    }
  }
}

/** Parked drafts by conversation id; the composer keeps one per tab. */
export type ParkedDrafts<R = unknown, A = unknown> = Map<
  string,
  ParkedDraft<R, A>
>;

const hasText = (d: ParkedDraft<unknown, unknown>) => d.text.trim() !== '';

/**
 * Park `draft` for `conversationId`, keeping what is already parked
 * there that it does not replace: parking an attachment keeps a parked
 * text, and the other way round.
 */
export function parkDraft<R, A>(
  stash: ParkedDrafts<R, A>,
  conversationId: string,
  draft: ParkedDraft<R, A>
): void {
  const prev = stash.get(conversationId);
  if (!prev) {
    stash.set(conversationId, draft);
    return;
  }
  const textFrom = hasText(draft) ? draft : prev;
  stash.set(conversationId, {
    text: textFrom.text,
    origin: textFrom.origin,
    reply: draft.reply ?? prev.reply,
    attachment: draft.attachment ?? prev.attachment,
  });
}

/**
 * What is parked for `conversationId` and can go back now, taken out of
 * the stash: the text when the box is empty, the attachment when
 * nothing is staged. What cannot go back stays parked: nothing is
 * overwritten and nothing is dropped. Null when nothing goes back.
 */
export function takeParkedDraft<R, A>(
  stash: ParkedDrafts<R, A>,
  conversationId: string,
  boxText: string,
  hasStaged = false
): ParkedDraft<R, A> | null {
  const parked = stash.get(conversationId);
  if (!parked) return null;
  const takeText = hasText(parked) && !boxText.trim();
  const takeAttachment = parked.attachment !== null && !hasStaged;
  if (!takeText && !takeAttachment) return null;
  const rest: ParkedDraft<R, A> = {
    text: takeText ? '' : parked.text,
    origin: takeText ? null : parked.origin,
    reply: null,
    attachment: takeAttachment ? null : parked.attachment,
  };
  if (hasText(rest) || rest.attachment !== null)
    stash.set(conversationId, rest);
  else stash.delete(conversationId);
  return {
    text: takeText ? parked.text : '',
    origin: takeText ? parked.origin : null,
    reply: parked.reply,
    attachment: takeAttachment ? parked.attachment : null,
  };
}
