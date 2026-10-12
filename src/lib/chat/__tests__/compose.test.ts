import { describe, expect, it } from 'vitest';

import {
  channelNameProblem,
  chatHref,
  dmCandidates,
  DM_MAX_OTHERS,
  filterPeople,
  finalChannelName,
  focusStep,
  FOCUS_MAX_PAGES,
  normalizeChannelName,
  togglePick,
  withParam,
} from '../compose';
import type { ChatPerson } from '../types';

const person = (
  userId: string,
  role: string,
  fullName: string
): ChatPerson => ({
  userId,
  fullName,
  avatarUrl: null,
  role,
  bankCode: null,
  presenceStatus: null,
  lastSeenAt: null,
});

describe('channel names', () => {
  it('lowercases and turns whitespace runs into one hyphen as typed', () => {
    expect(normalizeChannelName('Credit  Review ')).toBe('credit-review-');
    expect(finalChannelName('  Credit Review ')).toBe('credit-review');
    expect(normalizeChannelName('x'.repeat(90))).toHaveLength(80);
  });

  it('reports an empty name and a visible live channel of the same name', () => {
    const channels = [
      { kind: 'team' as const, name: 'Credit-Review', archivedAt: null },
      {
        kind: 'private' as const,
        name: 'old',
        archivedAt: '2026-01-01T00:00:00Z',
      },
      { kind: 'dm' as const, name: null, archivedAt: null },
    ];
    expect(channelNameProblem(' - ', channels)).toBe('empty');
    expect(channelNameProblem('credit review', channels)).toBe('taken');
    expect(channelNameProblem('old', channels)).toBeNull();
  });
});

describe('pickers', () => {
  it('togglePick adds up to the cap and removes', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(togglePick(six, 'g', DM_MAX_OTHERS)).toHaveLength(7);
    expect(togglePick([...six, 'g'], 'h', DM_MAX_OTHERS)).toHaveLength(7);
    expect(togglePick(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('dmCandidates leaves out the viewer and bank guests', () => {
    const people = [
      person('me', 'agent', 'Me'),
      person('ann', 'admin', 'Ann'),
      person('gus', 'bank_guest', 'Gus'),
    ];
    expect(dmCandidates(people, 'ME').map((p) => p.userId)).toEqual(['ann']);
  });

  it('filterPeople ignores case and accents', () => {
    const people = [
      person('a', 'agent', 'Zoë Ålund'),
      person('b', 'agent', 'Bob'),
    ];
    expect(filterPeople(people, 'zoe al').map((p) => p.userId)).toEqual(['a']);
    expect(filterPeople(people, '  ')).toHaveLength(2);
  });
});

describe('URL state', () => {
  it('withParam sets and removes one key and keeps the rest', () => {
    expect(withParam('?a=1', 'thread', 'r1')).toBe('?a=1&thread=r1');
    expect(withParam('?thread=r1', 'thread', null)).toBe('');
  });

  it('chatHref carries the thread and the message', () => {
    expect(chatHref('c1')).toBe('/chat/c1');
    expect(chatHref('c1', { message: 'm1' })).toBe('/chat/c1?message=m1');
    expect(chatHref('c1', { thread: 'r1', message: 'm2' })).toBe(
      '/chat/c1?thread=r1&message=m2'
    );
  });
});

describe('focusStep', () => {
  const base = {
    found: false,
    loading: false,
    loadingOlder: false,
    hasMoreOlder: true,
    pagesRead: 0,
  };
  it('scrolls when found, waits on a load, pages back, then gives up', () => {
    expect(focusStep({ ...base, found: true })).toBe('scroll');
    expect(focusStep({ ...base, loadingOlder: true })).toBe('wait');
    expect(focusStep(base)).toBe('loadOlder');
    expect(focusStep({ ...base, pagesRead: FOCUS_MAX_PAGES })).toBe('giveUp');
    expect(focusStep({ ...base, hasMoreOlder: false })).toBe('giveUp');
  });
});
