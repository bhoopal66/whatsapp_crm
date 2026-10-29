import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TAG_SUGGEST_MIN_P } from './bands';
import {
  canAskForSuggestion,
  shownSuggestion,
  suggestOutcome,
  suggestionKey,
  suggestionPercent,
  suggestionTagText,
  type TagSuggestionRow,
} from './suggestion-view';

const row = (over: Partial<TagSuggestionRow> = {}): TagSuggestionRow => ({
  chat_tag_id: null,
  chat_sub_tag_id: null,
  suggested_chat_tag_id: 'main-a',
  suggested_chat_sub_tag_id: 'sub-a',
  suggested_tag_p: 0.87,
  suggested_tag_at: '2026-10-29T10:00:00Z',
  ...over,
});

const on = { mode: 'suggest' as const, canEdit: true };

describe('shownSuggestion', () => {
  it('shows a confident suggestion that would change the chat', () => {
    expect(shownSuggestion(row(), on)).toEqual({
      mainId: 'main-a',
      subId: 'sub-a',
      p: 0.87,
      key: suggestionKey(row()),
    });
  });

  it('shows in Auto mode too', () => {
    expect(shownSuggestion(row(), { ...on, mode: 'auto' })).not.toBeNull();
  });

  it('hides when suggestions are off', () => {
    expect(shownSuggestion(row(), { ...on, mode: 'off' })).toBeNull();
  });

  it('hides from someone who cannot tag (a viewer)', () => {
    expect(shownSuggestion(row(), { ...on, canEdit: false })).toBeNull();
  });

  it('hides with no suggestion or no probability', () => {
    expect(
      shownSuggestion(row({ suggested_chat_tag_id: null }), on)
    ).toBeNull();
    expect(shownSuggestion(row({ suggested_tag_p: null }), on)).toBeNull();
    expect(shownSuggestion(row({ suggested_tag_p: NaN }), on)).toBeNull();
  });

  it('holds the confidence floor', () => {
    expect(
      shownSuggestion(row({ suggested_tag_p: TAG_SUGGEST_MIN_P - 0.01 }), on)
    ).toBeNull();
    expect(
      shownSuggestion(row({ suggested_tag_p: TAG_SUGGEST_MIN_P }), on)
    ).not.toBeNull();
  });

  it('hides when the chat already carries the suggestion', () => {
    expect(
      shownSuggestion(
        row({ chat_tag_id: 'main-a', chat_sub_tag_id: 'sub-a' }),
        on
      )
    ).toBeNull();
    // Same main tag, no sub-tag suggested: nothing to apply.
    expect(
      shownSuggestion(
        row({
          chat_tag_id: 'main-a',
          chat_sub_tag_id: 'sub-b',
          suggested_chat_sub_tag_id: null,
        }),
        on
      )
    ).toBeNull();
  });

  it('shows a different sub-tag under the same main tag', () => {
    expect(
      shownSuggestion(
        row({ chat_tag_id: 'main-a', chat_sub_tag_id: 'sub-b' }),
        on
      )
    ).not.toBeNull();
    expect(
      shownSuggestion(row({ chat_tag_id: 'main-a', chat_sub_tag_id: null }), on)
    ).not.toBeNull();
  });

  it('hides only the suggestion being acted on', () => {
    const hiddenKey = suggestionKey(row());
    expect(shownSuggestion(row(), { ...on, hiddenKey })).toBeNull();
    const newer = row({ suggested_tag_at: '2026-10-29T11:00:00Z' });
    expect(shownSuggestion(newer, { ...on, hiddenKey })).not.toBeNull();
  });
});

describe('canAskForSuggestion', () => {
  it('offers the ask only when on, allowed and no chip shows', () => {
    expect(canAskForSuggestion({ ...on, chipShown: false })).toBe(true);
    expect(canAskForSuggestion({ ...on, chipShown: true })).toBe(false);
    expect(canAskForSuggestion({ ...on, mode: 'off', chipShown: false })).toBe(
      false
    );
    expect(
      canAskForSuggestion({ ...on, canEdit: false, chipShown: false })
    ).toBe(false);
  });
});

describe('suggestionPercent / suggestionTagText', () => {
  it('rounds to a whole percentage within 0..100', () => {
    expect(suggestionPercent(0.874)).toBe(87);
    expect(suggestionPercent(0.875)).toBe(88);
    expect(suggestionPercent(1.2)).toBe(100);
    expect(suggestionPercent(-0.1)).toBe(0);
    expect(suggestionPercent(NaN)).toBe(0);
  });

  it('joins the sub-tag on when there is one', () => {
    expect(suggestionTagText('Interested', 'ADCB')).toBe('Interested · ADCB');
    expect(suggestionTagText('Interested', null)).toBe('Interested');
  });
});

describe('suggestOutcome', () => {
  it('reads a suggestion', () => {
    expect(
      suggestOutcome(200, {
        suggestion: { mainId: 'm', subId: null, p: 0.7 },
      })
    ).toEqual({
      kind: 'suggestion',
      suggestion: { mainId: 'm', subId: null, p: 0.7 },
    });
  });

  it.each([
    ['not_confident', 'notConfident'],
    ['no_tags', 'noTags'],
    ['no_message', 'noMessage'],
    ['same_as_current', 'sameAsCurrent'],
    ['dismissed', 'dismissed'],
    ['superseded', 'superseded'],
  ])('answers %s with a plain toast', (reason, key) => {
    expect(suggestOutcome(200, { suggestion: null, reason })).toEqual({
      kind: 'toast',
      key,
      error: false,
    });
  });

  it.each([
    [503, { error: 'x', reason: 'unavailable' }, 'unavailable'],
    [409, { error: 'x', reason: 'off' }, 'unavailable'],
    [429, { error: 'Rate limit exceeded' }, 'rateLimited'],
    [502, { error: 'x', reason: 'error' }, 'failed'],
    [404, { error: 'x' }, 'failed'],
    [500, null, 'failed'],
  ])('answers HTTP %s with an error toast', (status, body, key) => {
    expect(suggestOutcome(status, body)).toEqual({
      kind: 'toast',
      key,
      error: true,
    });
  });
});

describe('module boundary', () => {
  it('imports nothing but the client-safe bands module', () => {
    const src = readFileSync(join(__dirname, 'suggestion-view.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./bands']);
  });
});
