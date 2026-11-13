import { describe, expect, it } from 'vitest';

import { isFullBleedPath } from './full-bleed';

describe('isFullBleedPath', () => {
  it.each([
    '/inbox',
    '/team-inbox',
    '/hr-inbox',
    '/broadcasts/inbox',
    '/groups',
    '/groups/abc',
    '/groups/submission/abc',
    '/submission-groups',
    '/submission-groups/abc',
    '/chat',
    '/chat/rooms/r1',
  ])('%s fills the shell', (path) => {
    expect(isFullBleedPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/inboxes',
    '/broadcasts',
    '/broadcasts/new',
    '/contacts',
    '/settings',
    '/groupsx',
    null,
    undefined,
  ])('%s keeps the padded, scrolling page', (path) => {
    expect(isFullBleedPath(path)).toBe(false);
  });
});
