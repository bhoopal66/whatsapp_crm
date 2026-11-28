import { describe, expect, it } from 'vitest';

import {
  HR_TOPIC_DOT,
  hrEmptyKey,
  hrInboxLinks,
  hrTopicChips,
  hrTopicOptGroups,
} from './topic-ui';
import { HR_TOPICS } from './types';

describe('HR_TOPIC_DOT', () => {
  it('maps every topic to its own colour', () => {
    expect(Object.keys(HR_TOPIC_DOT).sort()).toEqual([...HR_TOPICS].sort());
    expect(new Set(Object.values(HR_TOPIC_DOT)).size).toBe(HR_TOPICS.length);
  });

  it('keeps red for Urgent and gives each hue a dark pair', () => {
    for (const cls of Object.values(HR_TOPIC_DOT)) {
      expect(cls).not.toMatch(/red|rose/);
      expect(cls).toMatch(/dark:/);
    }
  });
});

describe('hrEmptyKey', () => {
  it('names the staff empty text on the department tab only', () => {
    expect(hrEmptyKey('dept')).toBe('list.deptEmpty');
    for (const tab of ['all', 'recruiter', 'unsorted'] as const) {
      expect(hrEmptyKey(tab)).toBeNull();
    }
  });
});

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
