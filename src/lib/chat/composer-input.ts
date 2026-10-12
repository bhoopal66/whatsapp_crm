/**
 * The composer's input handling, kept out of the components (no DOM,
 * no I/O): what a key does, picking a popover candidate, the helper
 * line, attachment chips, an edit's submission, and the pin events the
 * message-marks provider applies.
 */
import {
  composeBody,
  insertAtMention,
  mentionLabel,
  withPick,
  type ComposerDraft,
  type MentionCandidate,
} from './composer';
import type { ChatErrorKey } from './errors';
import type { AttachmentInput, ChannelKind } from './types';

export const EMPTY_DRAFT: ComposerDraft = { text: '', picked: [] };

// ---------- keys ----------

export type ComposerKeyAction =
  'send' | 'next' | 'prev' | 'pick' | 'close' | 'cancel' | null;

/**
 * What a keydown does. Nothing while an IME composition is active
 * (Korean, Arabic, Japanese …): that Enter commits the composition and
 * must never send. `popover` = the mention list is open with at least
 * one candidate.
 */
export function composerKeyAction(
  e: { key: string; shiftKey: boolean; composing: boolean },
  popover: boolean
): ComposerKeyAction {
  if (e.composing) return null;
  if (popover) {
    if (e.key === 'ArrowDown') return 'next';
    if (e.key === 'ArrowUp') return 'prev';
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') return 'pick';
    if (e.key === 'Escape') return 'close';
  }
  if (e.key === 'Enter' && !e.shiftKey) return 'send';
  if (e.key === 'Escape') return 'cancel';
  return null;
}

/** `i` wrapped into 0 … n-1 (0 for an empty list). */
export const wrapIndex = (i: number, n: number): number =>
  n <= 0 ? 0 : ((i % n) + n) % n;

/** The draft after picking `c` for the '@query' before the caret. */
export function pickCandidate(
  draft: ComposerDraft,
  caret: number,
  c: MentionCandidate
): { draft: ComposerDraft; caret: number } {
  if (c.type === 'broadcast') {
    const r = insertAtMention(draft.text, caret, `@${c.kind}`);
    return { draft: { text: r.text, picked: draft.picked }, caret: r.caret };
  }
  const label = mentionLabel(c.name, c.person.userId, draft.picked);
  const r = insertAtMention(draft.text, caret, `@${label}`);
  return {
    draft: {
      text: r.text,
      picked: withPick(draft.picked, { userId: c.person.userId, label }),
    },
    caret: r.caret,
  };
}

// ---------- helper line ----------

/** @channel / @here exist in team and private channels only. */
export const offersBroadcasts = (kind: ChannelKind): boolean =>
  kind === 'team' || kind === 'private';

export type HelperLine =
  | { key: 'helperThread' }
  | { key: 'helperNotes' }
  | { key: 'helperDm'; names: string }
  | { key: 'helperChannel'; name: string };

/** Chat.composer.<key> for the line over the input; `name` is the channel's display name. */
export function helperLine(
  kind: ChannelKind,
  name: string,
  thread: boolean
): HelperLine {
  if (thread) return { key: 'helperThread' };
  if (kind === 'deal_room') return { key: 'helperNotes' };
  if (kind === 'dm') return { key: 'helperDm', names: name };
  return { key: 'helperChannel', name };
}

// ---------- attachment chips ----------

export interface FileChip {
  id: string;
  name: string;
  status: 'uploading' | 'done' | 'failed';
  input: AttachmentInput | null;
  error: ChatErrorKey | null;
}

export const uploadingChip = (id: string, name: string): FileChip => ({
  id,
  name,
  status: 'uploading',
  input: null,
  error: null,
});

/** The chip `id` once its upload finished (a removed chip stays removed). */
export function settleChip(
  chips: readonly FileChip[],
  id: string,
  r: { input: AttachmentInput } | { error: ChatErrorKey }
): FileChip[] {
  return chips.map((c) =>
    c.id !== id
      ? c
      : 'input' in r
        ? { ...c, status: 'done', input: r.input, error: null }
        : { ...c, status: 'failed', input: null, error: r.error }
  );
}

/** Send waits for every upload; a failed chip has to be removed first. */
export const chipsReady = (chips: readonly FileChip[]): boolean =>
  chips.every((c) => c.status === 'done');

export const chipInputs = (chips: readonly FileChip[]): AttachmentInput[] =>
  chips.flatMap((c) => (c.status === 'done' && c.input ? [c.input] : []));

// ---------- editing ----------

export type EditSubmission =
  | { kind: 'unchanged' }
  | { kind: 'save'; body: string }
  | { kind: 'invalid'; reason: 'empty' | 'bodyLength' };

/** What Save does with the edited draft of a message whose body is `original`. */
export function editSubmission(
  original: string,
  draft: ComposerDraft,
  attachmentNames: readonly string[]
): EditSubmission {
  const r = composeBody(draft.text, draft.picked, attachmentNames);
  if (!r.ok) return { kind: 'invalid', reason: r.reason };
  return r.body === original
    ? { kind: 'unchanged' }
    : { kind: 'save', body: r.body };
}

// ---------- pinned / saved marks ----------

export interface PinEvent {
  type: 'pin' | 'unpin';
  channelId: string;
  messageId: string;
}

/** `ids` with or without one message id (a new set). */
export function withMark(
  ids: ReadonlySet<string>,
  messageId: string,
  on: boolean
): Set<string> {
  const next = new Set(ids);
  if (on) next.add(messageId);
  else next.delete(messageId);
  return next;
}

/**
 * `ids` with the pin events of `channelId` applied in arrival order.
 * Replaying events that arrived while the pins were being read over
 * that read is safe: the last event per message is its current state.
 */
export function applyPinEvents(
  ids: ReadonlySet<string>,
  channelId: string,
  events: readonly PinEvent[]
): Set<string> {
  let next = new Set(ids);
  const ch = channelId.toLowerCase();
  for (const e of events)
    if (e.channelId.toLowerCase() === ch)
      next = withMark(next, e.messageId, e.type === 'pin');
  return next;
}
