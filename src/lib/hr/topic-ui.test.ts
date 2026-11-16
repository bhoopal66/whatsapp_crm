import { describe, expect, it } from 'vitest';

import { hrInboxLinks, hrTopicChips, hrTopicOptGroups } from './topic-ui';
import { HR_TOPICS } from './types';

describe('hrTopicChips', () => {
  it('is All first, then the five filters in order, with their labels', () => {
    expect(hrTopicChips().map((c) => c.value)).toEqual([
      null,
      'letters',
      'training',
      'leave',
      'messages',
      'exits',
    ]);
    expect(hrTopicChips().map((c) => c.labelKey)).toEqual([
      'topicFilter.all',
      'topicFilter.letters',
      'topicFilter.training',
      'topicFilter.leave',
      'topicFilter.messages',
      'topicFilter.exits',
    ]);
  });
});

describe('hrTopicOptGroups', () => {
  it('lists every topic exactly once, under topicGroup labels', () => {
    const groups = hrTopicOptGroups();
    expect(groups.map((g) => g.labelKey)).toEqual([
      'topicGroup.staff_admin',
      'topicGroup.conduct',
      'topicGroup.other',
    ]);
    expect(groups.flatMap((g) => [...g.topics]).sort()).toEqual(
      [...HR_TOPICS].sort()
    );
  });
});

describe('hrInboxLinks', () => {
  const r = (admin: boolean, recruiter: 'lead' | 'member' | null) => ({
    admin,
    recruiter,
    dept: null,
  });
  it('admin sees both', () =>
    expect(hrInboxLinks(r(true, null))).toEqual({
      hireFast: true,
      automatedMessages: true,
    }));
  it('lead sees both', () =>
    expect(hrInboxLinks(r(false, 'lead'))).toEqual({
      hireFast: true,
      automatedMessages: true,
    }));
  it('member sees Hire fast only', () =>
    expect(hrInboxLinks(r(false, 'member'))).toEqual({
      hireFast: true,
      automatedMessages: false,
    }));
  it('no recruiter role sees neither', () => {
    expect(hrInboxLinks(r(false, null))).toEqual({
      hireFast: false,
      automatedMessages: false,
    });
    expect(hrInboxLinks(null)).toEqual({
      hireFast: false,
      automatedMessages: false,
    });
  });
});
