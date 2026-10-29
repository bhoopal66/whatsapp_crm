import { describe, expect, it } from 'vitest';
import {
  draftToDiscard,
  nextGapAnswerRequest,
  withRequestedEntry,
} from './gap-answer-request';

describe('nextGapAnswerRequest', () => {
  it('starts at 1 and bumps the nonce per request, even for the same row', () => {
    const first = nextGapAnswerRequest(null, { id: 'a' });
    expect(first).toEqual({ entry: { id: 'a' }, nonce: 1 });
    const again = nextGapAnswerRequest(first, { id: 'a' });
    expect(again.nonce).toBe(2);
  });
});

describe('withRequestedEntry', () => {
  it('puts a row the list does not have yet at the top', () => {
    const list = [{ id: 'x', q: 'old' }];
    expect(withRequestedEntry(list, { id: 'n', q: 'new' })).toEqual([
      { id: 'n', q: 'new' },
      { id: 'x', q: 'old' },
    ]);
  });

  it('keeps the loaded copy when the row is already listed', () => {
    const list = [{ id: 'n', q: 'loaded' }];
    const out = withRequestedEntry(list, { id: 'n', q: 'request' });
    expect(out).toEqual([{ id: 'n', q: 'loaded' }]);
    expect(out).not.toBe(list);
  });
});

describe('draftToDiscard', () => {
  it('discards the hand-off draft when that row closes unsaved', () => {
    expect(draftToDiscard('d1', 'd1')).toBe('d1');
  });

  it('never discards another row, or when nothing is pending', () => {
    expect(draftToDiscard('d1', 'other')).toBeNull();
    expect(draftToDiscard(null, 'd1')).toBeNull();
    expect(draftToDiscard('d1', null)).toBeNull();
  });
});
