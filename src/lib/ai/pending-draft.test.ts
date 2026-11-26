import { describe, expect, it } from 'vitest';

import {
  NO_DRAFT_MEMORY,
  draftFailure,
  draftMemoryReducer,
  sameDraftTime,
} from './pending-draft';

describe('sameDraftTime', () => {
  it.each([
    ['2026-10-09T06:00:00.120Z', '2026-10-09T06:00:00.12+00:00', true],
    ['2026-10-09 06:00:00.12+00', '2026-10-09T06:00:00.12+00:00', true],
    ['2026-10-09T06:00:00Z', '2026-10-09T06:00:01Z', false],
    [null, null, true],
    [null, '2026-10-09T06:00:00Z', false],
    ['2026-10-09T06:00:00Z', null, false],
    ['nonsense', '2026-10-09T06:00:00Z', false],
    ['nonsense', 'other', false],
  ])('%s / %s is %s', (shown, stored, same) => {
    expect(sameDraftTime(shown, stored)).toBe(same);
  });
});

describe('draftFailure', () => {
  it('never offers a draft again that may have been sent', () => {
    expect(draftFailure(502, { code: 'send_unconfirmed', error: 'x' })).toEqual(
      { kind: 'maybeSent' }
    );
    expect(draftFailure(500, { code: 'db_error', error: 'x' })).toEqual({
      kind: 'sentUnsaved',
    });
  });

  it('shows the draft that is held now', () => {
    expect(
      draftFailure(409, {
        code: 'draft_changed',
        ai_pending_draft: 'Newer',
        ai_pending_draft_at: '2026-10-09T07:00:00Z',
      })
    ).toEqual({
      kind: 'changed',
      draft: {
        ai_pending_draft: 'Newer',
        ai_pending_draft_at: '2026-10-09T07:00:00Z',
      },
    });
  });

  it('takes a draft off the banner that is gone', () => {
    expect(
      draftFailure(409, { code: 'draft_gone', error: 'Already sent' })
    ).toEqual({ kind: 'gone', error: 'Already sent' });
  });

  it('keeps the draft on a definite refusal, a 409 from the send included', () => {
    expect(draftFailure(502, { code: 'whatsapp_error', error: 'No' })).toEqual({
      kind: 'failed',
      error: 'No',
    });
    expect(draftFailure(409, { code: 'personal_chat', error: 'No' })).toEqual({
      kind: 'failed',
      error: 'No',
    });
    expect(draftFailure(500, null)).toEqual({ kind: 'failed', error: null });
  });
});

describe('what the thread remembers about a draft', () => {
  const run = (...actions: Parameters<typeof draftMemoryReducer>[1][]) =>
    actions.reduce(draftMemoryReducer, NO_DRAFT_MEMORY);

  it('keeps an edit until it is done with', () => {
    const typed = run({ type: 'edit', key: 'c1:t', text: 'Hello' });
    expect(typed.editing).toEqual({ 'c1:t': 'Hello' });
    expect(
      draftMemoryReducer(typed, { type: 'editDone', key: 'c1:t' }).editing
    ).toEqual({});
  });

  it('keeps an edit through an edit, or an answer, in another chat', () => {
    const both = run(
      { type: 'edit', key: 'c1:t', text: 'Hello' },
      { type: 'edit', key: 'c2:t', text: 'Other' }
    );
    expect(both.editing).toEqual({ 'c1:t': 'Hello', 'c2:t': 'Other' });
    expect(
      draftMemoryReducer(both, { type: 'editDone', key: 'c2:t' }).editing
    ).toEqual({ 'c1:t': 'Hello' });
    expect(draftMemoryReducer(both, { type: 'editDone', key: 'c3:t' })).toBe(
      both
    );
  });

  it('keeps the text of a send nobody can vouch for, by chat', () => {
    const m = run(
      { type: 'unconfirmed', conv: 'c1', text: 'One' },
      { type: 'unconfirmed', conv: 'c2', text: 'Two' },
      { type: 'confirmed', conv: 'c1' }
    );
    expect(m.unconfirmed).toEqual({ c2: 'Two' });
  });

  it('has nothing to keep of a discard', () => {
    expect(run({ type: 'unconfirmed', conv: 'c1', text: '' })).toBe(
      NO_DRAFT_MEMORY
    );
    expect(run({ type: 'confirmed', conv: 'c1' })).toBe(NO_DRAFT_MEMORY);
  });
});
