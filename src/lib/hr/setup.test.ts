import { describe, expect, it } from 'vitest';

import {
  addableStaff,
  draftOf,
  invalidFields,
  isEmptyPatch,
  ruleTrigger,
  rulePatch,
  rulesByInbox,
  teamByInbox,
} from './setup';
import type { HrRule } from './types';

function rule(over: Partial<HrRule>): HrRule {
  return {
    account_id: 'a',
    key: 'stage_cv_review',
    inbox: 'recruiter',
    trigger_kind: 'stage',
    trigger_value: 'cv_review',
    action: 'task',
    flag: null,
    after_hours: null,
    due_hours: 24,
    title: 'Review CV',
    title_ar: 'مراجعة السيرة الذاتية',
    enabled: true,
    updated_at: '2026-11-16T00:00:00Z',
    updated_by: null,
    ...over,
  };
}

const overdue = rule({
  key: 'reply_overdue_dept',
  inbox: 'dept',
  trigger_kind: 'reply_overdue',
  trigger_value: null,
  after_hours: 4,
  due_hours: 0,
  title: 'Reply to customer',
});
const flag = rule({
  key: 'topic_complaint_flag',
  inbox: 'dept',
  trigger_kind: 'topic',
  trigger_value: 'complaint',
  action: 'set_flag',
  flag: 'urgent',
  due_hours: null,
  title: null,
});

describe('ruleTrigger', () => {
  it('names the stage or topic through its i18n key', () => {
    expect(ruleTrigger(rule({}))).toEqual({
      key: 'stage',
      labelKey: 'Hr.stage.cv_review',
    });
    expect(ruleTrigger(flag)).toEqual({
      key: 'topic',
      labelKey: 'Hr.topic.complaint',
    });
  });
  it('carries the wait for the time-based rules', () => {
    expect(ruleTrigger(overdue)).toEqual({ key: 'replyOverdue', hours: 4 });
    expect(
      ruleTrigger(
        rule({
          trigger_kind: 'no_activity',
          trigger_value: null,
          after_hours: 72,
        })
      )
    ).toEqual({ key: 'noActivity', hours: 72 });
  });
});

describe('invalidFields', () => {
  it('accepts the seeded values', () => {
    expect(invalidFields(rule({}), draftOf(rule({})))).toEqual([]);
    expect(invalidFields(overdue, draftOf(overdue))).toEqual([]);
    expect(invalidFields(flag, draftOf(flag))).toEqual([]);
  });
  it('holds after to 1–720, due to 0–720, whole numbers', () => {
    const d = draftOf(overdue);
    expect(invalidFields(overdue, { ...d, afterHours: '0' })).toEqual([
      'afterHours',
    ]);
    expect(invalidFields(overdue, { ...d, afterHours: '721' })).toEqual([
      'afterHours',
    ]);
    expect(invalidFields(overdue, { ...d, afterHours: '1.5' })).toEqual([
      'afterHours',
    ]);
    expect(invalidFields(overdue, { ...d, afterHours: '720' })).toEqual([]);
    expect(invalidFields(overdue, { ...d, dueHours: '-1' })).toEqual([
      'dueHours',
    ]);
    expect(invalidFields(overdue, { ...d, dueHours: '' })).toEqual([
      'dueHours',
    ]);
    expect(invalidFields(overdue, { ...d, dueHours: '0' })).toEqual([]);
  });
  it('refuses a blank or over-long title, tabs and newlines included', () => {
    const d = draftOf(rule({}));
    expect(invalidFields(rule({}), { ...d, title: ' \t\n' })).toEqual([
      'title',
    ]);
    expect(invalidFields(rule({}), { ...d, title: 'x'.repeat(301) })).toEqual([
      'title',
    ]);
    expect(invalidFields(rule({}), { ...d, title: 'x'.repeat(300) })).toEqual(
      []
    );
  });
  it('ignores fields the rule does not have', () => {
    expect(
      invalidFields(flag, { ...draftOf(flag), afterHours: 'x', dueHours: 'x' })
    ).toEqual([]);
    expect(
      invalidFields(rule({}), { ...draftOf(rule({})), afterHours: '0' })
    ).toEqual([]);
  });
});

describe('rulePatch', () => {
  it('is empty when nothing changed', () => {
    expect(isEmptyPatch(rulePatch(overdue, draftOf(overdue)))).toBe(true);
  });
  it('sends only the changed fields, title trimmed', () => {
    expect(
      rulePatch(overdue, { ...draftOf(overdue), afterHours: ' 8 ' })
    ).toEqual({ afterHours: 8 });
    expect(
      rulePatch(rule({}), { ...draftOf(rule({})), title: ' Read the CV ' })
    ).toEqual({ title: 'Read the CV' });
    expect(
      rulePatch(rule({}), { ...draftOf(rule({})), title: ' Review CV ' })
    ).toEqual({});
    expect(
      rulePatch(flag, { ...draftOf(flag), enabled: false, dueHours: '3' })
    ).toEqual({ enabled: false });
  });
  it('sends a changed Arabic title trimmed, and an emptied one as a clear', () => {
    const r = rule({});
    expect(rulePatch(r, { ...draftOf(r), titleAr: ' راجع السيرة ' })).toEqual({
      titleAr: 'راجع السيرة',
    });
    expect(rulePatch(r, { ...draftOf(r), titleAr: '  ' })).toEqual({
      titleAr: '',
    });
    expect(
      rulePatch(r, { ...draftOf(r), titleAr: ' مراجعة السيرة الذاتية ' })
    ).toEqual({});
    const none = rule({ title_ar: null });
    expect(rulePatch(none, draftOf(none))).toEqual({});
  });
});

describe('invalidFields, Arabic title', () => {
  it('allows it empty and up to 300 characters, not more', () => {
    const r = rule({});
    const d = draftOf(r);
    expect(invalidFields(r, { ...d, titleAr: '' })).toEqual([]);
    expect(invalidFields(r, { ...d, titleAr: 'ع'.repeat(300) })).toEqual([]);
    expect(invalidFields(r, { ...d, titleAr: 'ع'.repeat(301) })).toEqual([
      'titleAr',
    ]);
  });
});

describe('rulesByInbox', () => {
  it('splits by inbox, keeping order', () => {
    const r2 = rule({ key: 'stage_ai_interview' });
    expect(rulesByInbox([rule({}), overdue, r2, flag])).toEqual({
      recruiter: [rule({}), r2],
      dept: [overdue, flag],
    });
  });
});

describe('teamByInbox', () => {
  const names: Record<string, string> = { u1: 'Zed', u2: 'Amy', u3: 'Bob' };
  it('lists leads first, then by name, unknown people by id', () => {
    const team = teamByInbox(
      [
        { user_id: 'u2', inbox: 'recruiter', role: 'member' },
        { user_id: 'u1', inbox: 'recruiter', role: 'lead' },
        { user_id: 'u3', inbox: 'recruiter', role: 'member' },
        { user_id: 'u9', inbox: 'dept', role: 'member' },
      ],
      (id) => names[id] ?? null
    );
    expect(team.recruiter.map((e) => e.name)).toEqual(['Zed', 'Amy', 'Bob']);
    expect(team.dept).toEqual([
      { user_id: 'u9', inbox: 'dept', role: 'member', name: 'u9' },
    ]);
  });
});

describe('addableStaff', () => {
  it('offers live staff not already on the inbox', () => {
    const people = [
      { user_id: 'a', account_role: 'agent' },
      { user_id: 'b', account_role: 'viewer' },
      { user_id: 'c', account_role: 'admin', deactivated_at: '2026-01-01' },
      { user_id: 'd', account_role: 'team_leader' },
      { user_id: 'e', account_role: 'bank_guest' },
    ];
    expect(
      addableStaff(people, [{ user_id: 'd', inbox: 'dept', role: 'lead' }]).map(
        (p) => p.user_id
      )
    ).toEqual(['a']);
  });
});
