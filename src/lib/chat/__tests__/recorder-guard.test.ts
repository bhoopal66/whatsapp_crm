import { describe, expect, it } from 'vitest';

import { chatRecorderGuard, createRecorderGuard } from '../recorder-guard';

describe('createRecorderGuard', () => {
  it('lets one owner record and refuses a second until it releases', () => {
    const g = createRecorderGuard();
    const main = {};
    const thread = {};
    expect(g.held()).toBe(false);
    expect(g.claim(main)).toBe(true);
    expect(g.held()).toBe(true);
    expect(g.claim(thread)).toBe(false);
    g.release(main);
    expect(g.held()).toBe(false);
    expect(g.claim(thread)).toBe(true);
  });

  it('a claim again by the holder succeeds', () => {
    const g = createRecorderGuard();
    const main = {};
    expect(g.claim(main)).toBe(true);
    expect(g.claim(main)).toBe(true);
  });

  it("a release by someone else leaves the holder's claim", () => {
    const g = createRecorderGuard();
    const main = {};
    const thread = {};
    g.claim(main);
    g.release(thread);
    expect(g.claim(thread)).toBe(false);
    g.release(main);
    g.release(main);
    expect(g.held()).toBe(false);
  });

  it('the page guard is one shared instance', async () => {
    const again = await import('../recorder-guard');
    expect(again.chatRecorderGuard).toBe(chatRecorderGuard);
  });
});
