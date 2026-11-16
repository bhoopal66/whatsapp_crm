import { describe, expect, it } from 'vitest';

import {
  defaultHrInbox,
  legacyHrInboxTarget,
  legacyHrSubPagePath,
} from './routes';
import type { HrRoles } from './types';

const ADMIN: HrRoles = { admin: true, recruiter: null, dept: null };
const RECRUITER: HrRoles = { admin: false, recruiter: 'lead', dept: null };
const DEPT: HrRoles = { admin: false, recruiter: null, dept: 'member' };
const NONE: HrRoles = { admin: false, recruiter: null, dept: null };

describe('legacyHrSubPagePath', () => {
  it.each([
    [['tasks'], '/hr/tasks'],
    [['setup'], '/hr/rules'],
    [['hire-fast'], '/hr/hire-fast'],
    [['automated-messages'], '/hr/automated-messages'],
  ])('/hr-inbox/%s → %s', (segments, path) => {
    expect(legacyHrSubPagePath(segments)).toBe(path);
  });

  it('claims nothing else', () => {
    expect(legacyHrSubPagePath(['rules'])).toBeNull();
    expect(legacyHrSubPagePath(['tasks', 'x'])).toBeNull();
    expect(legacyHrSubPagePath(['toString'])).toBeNull();
    expect(legacyHrSubPagePath([])).toBeNull();
  });
});

describe('defaultHrInbox', () => {
  it('sends admins and recruiters to Recruiter HR, dept-only to HR department', () => {
    expect(defaultHrInbox(ADMIN)).toBe('recruiter');
    expect(defaultHrInbox(RECRUITER)).toBe('recruiter');
    expect(defaultHrInbox({ ...DEPT, recruiter: 'member' })).toBe('recruiter');
    expect(defaultHrInbox(DEPT)).toBe('dept');
    expect(defaultHrInbox(NONE)).toBe('unsorted');
    expect(defaultHrInbox(null)).toBe('unsorted');
  });
});

describe('legacyHrInboxTarget', () => {
  it("follows the chat's own inbox and keeps the other keys", () => {
    expect(
      legacyHrInboxTarget('?c=abc&hrMine=1&hrTab=dept', 'recruiter', DEPT)
    ).toBe('/hr/recruiter?c=abc&hrMine=1');
    expect(legacyHrInboxTarget('?c=abc', 'dept', ADMIN)).toBe(
      '/hr/department?c=abc'
    );
  });

  it('sends a chat with no HR row to Not sorted', () => {
    expect(legacyHrInboxTarget('?c=abc', null, ADMIN)).toBe(
      '/hr/unsorted?c=abc'
    );
  });

  it('without a chat, uses the old tab, else the roles', () => {
    expect(
      legacyHrInboxTarget('?hrTab=dept&hrTopic=payroll', null, ADMIN)
    ).toBe('/hr/department?hrTopic=payroll');
    expect(legacyHrInboxTarget('', null, ADMIN)).toBe('/hr/recruiter');
    expect(legacyHrInboxTarget('?hrTab=all', null, DEPT)).toBe(
      '/hr/department'
    );
    expect(legacyHrInboxTarget('', null, null)).toBe('/hr/unsorted');
  });
});
