import { describe, expect, it } from 'vitest';

import { beginWork, endWork, hasWork, NO_CHAT_WORK } from './chat-work';

describe('work per chat', () => {
  it('in A leaves B free', () => {
    const w = beginWork(NO_CHAT_WORK, 'A');
    expect(hasWork(w, 'A')).toBe(true);
    expect(hasWork(w, 'B')).toBe(false);
  });

  it('ending in A does not end what B started meanwhile', () => {
    const w = endWork(beginWork(beginWork(NO_CHAT_WORK, 'A'), 'B'), 'A');
    expect(hasWork(w, 'A')).toBe(false);
    expect(hasWork(w, 'B')).toBe(true);
  });

  it('lasts until the last job of a chat ends', () => {
    let w = beginWork(beginWork(NO_CHAT_WORK, 'A'), 'A');
    w = endWork(w, 'A');
    expect(hasWork(w, 'A')).toBe(true);
    expect(endWork(w, 'A')).toEqual(NO_CHAT_WORK);
  });

  it('belongs to no chat when none was open', () => {
    expect(beginWork(NO_CHAT_WORK, null)).toBe(NO_CHAT_WORK);
    expect(endWork(NO_CHAT_WORK, null)).toBe(NO_CHAT_WORK);
  });
});
