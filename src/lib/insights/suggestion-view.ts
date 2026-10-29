/**
 * The chat header's tag suggestion chip (docs/jev-insights.md, "Chat
 * tag suggestions"): when it shows, what it says, and what the
 * "Suggest a tag" answer means for the person who asked.
 *
 * Dependency-free on purpose: `thread-tag-bar.tsx` is a client
 * component, and a client graph that reaches a server module (one with
 * a `node:` import) breaks the production build while typecheck stays
 * quiet. Only `bands.ts`, itself client-safe, is imported.
 */

import { TAG_SUGGEST_MIN_P } from './bands';

export type TagSuggestMode = 'off' | 'suggest' | 'auto';

/** The conversation columns the chip reads (migration 147 and 075). */
export interface TagSuggestionRow {
  chat_tag_id?: string | null;
  chat_sub_tag_id?: string | null;
  suggested_chat_tag_id?: string | null;
  suggested_chat_sub_tag_id?: string | null;
  suggested_tag_p?: number | null;
  suggested_tag_at?: string | null;
}

export interface ShownSuggestion {
  mainId: string;
  subId: string | null;
  p: number;
  /**
   * Names this particular suggestion: a chip hidden while its Apply or
   * Dismiss is in flight stays hidden only for it, so a newer one that
   * arrives meanwhile (an inbound message) still shows.
   */
  key: string;
}

export function suggestionKey(row: TagSuggestionRow): string {
  return [
    row.suggested_chat_tag_id ?? '',
    row.suggested_chat_sub_tag_id ?? '',
    row.suggested_tag_at ?? '',
  ].join('|');
}

/**
 * The suggestion the chip shows, or null. It shows when suggestions are
 * on, the person can tag the chat, the suggestion clears the confidence
 * floor, and applying it would change something: another main tag, or
 * the same main tag with another sub-tag. The same main tag with no
 * sub-tag suggested changes nothing worth a click (applying would only
 * drop the chat's sub-tag).
 */
export function shownSuggestion(
  row: TagSuggestionRow,
  opts: {
    mode: TagSuggestMode;
    canEdit: boolean;
    /** The key of a suggestion being applied or dismissed. */
    hiddenKey?: string | null;
  }
): ShownSuggestion | null {
  if (opts.mode === 'off' || !opts.canEdit) return null;
  const mainId = row.suggested_chat_tag_id ?? null;
  const p = row.suggested_tag_p;
  if (!mainId || typeof p !== 'number' || !Number.isFinite(p)) return null;
  if (p < TAG_SUGGEST_MIN_P) return null;
  const subId = row.suggested_chat_sub_tag_id ?? null;
  const currentMain = row.chat_tag_id ?? null;
  const currentSub = row.chat_sub_tag_id ?? null;
  if (mainId === currentMain && (subId === null || subId === currentSub)) {
    return null;
  }
  const key = suggestionKey(row);
  if (opts.hiddenKey && opts.hiddenKey === key) return null;
  return { mainId, subId, p, key };
}

/** "Suggest a tag" is offered when suggestions are on and no chip shows. */
export function canAskForSuggestion(opts: {
  mode: TagSuggestMode;
  canEdit: boolean;
  chipShown: boolean;
}): boolean {
  return opts.mode !== 'off' && opts.canEdit && !opts.chipShown;
}

/** A probability as a whole percentage, 0..100. */
export function suggestionPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, Math.round(p * 100)));
}

/** The chip's tag text: "Interested · ADCB", or the main tag alone. */
export function suggestionTagText(
  mainName: string,
  subName: string | null | undefined
): string {
  return subName ? `${mainName} · ${subName}` : mainName;
}

/** The message keys (namespace `TagSuggest`) a failed or empty ask shows. */
export type SuggestToastKey =
  | 'notConfident'
  | 'noTags'
  | 'noMessage'
  | 'sameAsCurrent'
  | 'dismissed'
  | 'superseded'
  | 'unavailable'
  | 'rateLimited'
  | 'failed';

export type SuggestOutcome =
  | {
      kind: 'suggestion';
      suggestion: { mainId: string; subId: string | null; p: number };
    }
  | { kind: 'toast'; key: SuggestToastKey; error: boolean };

const EMPTY_REASONS: Record<string, SuggestToastKey> = {
  not_confident: 'notConfident',
  no_tags: 'noTags',
  no_message: 'noMessage',
  same_as_current: 'sameAsCurrent',
  dismissed: 'dismissed',
  superseded: 'superseded',
};

/**
 * What POST /api/insights/tag-suggest answered, for the person who
 * pressed "Suggest a tag". An answer with no suggestion is information
 * (a plain toast); a refusal or failure is an error toast.
 */
export function suggestOutcome(status: number, body: unknown): SuggestOutcome {
  const data = (body && typeof body === 'object' ? body : {}) as {
    suggestion?: unknown;
    reason?: unknown;
  };
  const reason = typeof data.reason === 'string' ? data.reason : null;
  if (status >= 200 && status < 300) {
    const s = data.suggestion as {
      mainId?: unknown;
      subId?: unknown;
      p?: unknown;
    } | null;
    if (
      s &&
      typeof s.mainId === 'string' &&
      typeof s.p === 'number' &&
      Number.isFinite(s.p)
    ) {
      return {
        kind: 'suggestion',
        suggestion: {
          mainId: s.mainId,
          subId: typeof s.subId === 'string' ? s.subId : null,
          p: s.p,
        },
      };
    }
    return {
      kind: 'toast',
      key: (reason && EMPTY_REASONS[reason]) || 'notConfident',
      error: false,
    };
  }
  if (status === 429) return { kind: 'toast', key: 'rateLimited', error: true };
  if (reason === 'unavailable' || reason === 'off') {
    return { kind: 'toast', key: 'unavailable', error: true };
  }
  return { kind: 'toast', key: 'failed', error: true };
}
