import { describe, expect, it } from 'vitest';

import {
  canEditRule,
  canManageTeam,
  canMoveBackward,
  canReopen,
  canWrite,
  hasHrAccess,
  hrRoleFor,
  isBackwardMove,
  moveTarget,
  stageIndex,
} from './access';
import { HR_STAGES, type HrInbox, type HrRoles } from './types';

const NONE: HrRoles = { admin: false, recruiter: null, dept: null };

/** The caller's roles when they hold `kind` in `inbox` only. */
function as(kind: 'admin' | 'lead' | 'member' | 'none', inbox: HrInbox) {
  if (kind === 'admin') return { ...NONE, admin: true };
  if (kind === 'none') return NONE;
  return { ...NONE, [inbox]: kind };
}

const other = (inbox: HrInbox): HrInbox =>
  inbox === 'recruiter' ? 'dept' : 'recruiter';

describe('the role matrix', () => {
  // kind, role in that inbox, write, reopen, edit rule, manage team
  const rows = [
    ['admin', 'admin', true, true, true, true],
    ['lead', 'lead', true, true, true, false],
    ['member', 'member', true, false, false, false],
    ['none', null, false, false, false, false],
  ] as const;

  describe.each(['recruiter', 'dept'] as const)('in %s', (inbox) => {
    it.each(rows)('%s', (kind, role, write, reopen, editRule, manageTeam) => {
      const roles = as(kind, inbox);
      expect(hrRoleFor(roles, inbox)).toBe(role);
      expect(canWrite(roles, inbox)).toBe(write);
      expect(canReopen(roles, inbox)).toBe(reopen);
      expect(canEditRule(roles, inbox)).toBe(editRule);
      expect(canManageTeam(roles)).toBe(manageTeam);
      expect(hasHrAccess(roles)).toBe(kind !== 'none');
    });

    it.each(['lead', 'member'] as const)(
      'a %s here has no role in the other inbox',
      (kind) => {
        const roles = as(kind, inbox);
        expect(hrRoleFor(roles, other(inbox))).toBeNull();
        expect(canWrite(roles, other(inbox))).toBe(false);
        expect(canReopen(roles, other(inbox))).toBe(false);
        expect(canEditRule(roles, other(inbox))).toBe(false);
      }
    );
  });

  it('admin wins over a team row', () => {
    const roles: HrRoles = { admin: true, recruiter: 'member', dept: null };
    expect(hrRoleFor(roles, 'recruiter')).toBe('admin');
    expect(hrRoleFor(roles, 'dept')).toBe('admin');
  });

  it.each([
    ['admin', 'recruiter', true],
    ['lead', 'recruiter', true],
    ['member', 'recruiter', false],
    ['none', 'recruiter', false],
    ['lead', 'dept', false],
    ['member', 'dept', false],
  ] as const)('a %s of %s may move a stage backward: %s', (kind, inbox, ok) => {
    expect(canMoveBackward(as(kind, inbox))).toBe(ok);
  });
});

describe('stageIndex', () => {
  it('follows the stage order', () => {
    HR_STAGES.forEach((s, i) => expect(stageIndex(s)).toBe(i));
  });

  it('is -1 for unknown or missing', () => {
    expect(stageIndex('offer')).toBe(-1);
    expect(stageIndex(null)).toBe(-1);
    expect(stageIndex(undefined)).toBe(-1);
  });
});

describe('isBackwardMove', () => {
  it('within recruiter compares with the current stage', () => {
    expect(isBackwardMove('recruiter', 'hr_interview', 'cv_review', null)).toBe(
      true
    );
    expect(isBackwardMove('recruiter', 'cv_review', 'hr_interview', null)).toBe(
      false
    );
    expect(
      isBackwardMove('recruiter', 'ai_interview', 'ai_interview', null)
    ).toBe(false);
  });

  it('returning from dept below the furthest stage reached is backward', () => {
    expect(
      isBackwardMove('dept', null, 'ai_interview', 'manager_interview')
    ).toBe(true);
  });

  it('returning from dept at or after the furthest is forward', () => {
    expect(isBackwardMove('dept', null, 'hr_interview', 'hr_interview')).toBe(
      false
    );
    expect(
      isBackwardMove('dept', null, 'manager_interview', 'ai_interview')
    ).toBe(false);
  });

  it('a first entry into recruitment is never backward', () => {
    expect(isBackwardMove('dept', null, 'cv_review', null)).toBe(false);
  });

  it('an unknown target is not called backward (the server says STAGE_UNKNOWN)', () => {
    expect(isBackwardMove('recruiter', 'hr_interview', 'offer', null)).toBe(
      false
    );
  });
});

describe('moveTarget', () => {
  it('a stage lands in recruitment, a topic in the department', () => {
    expect(moveTarget('stage')).toBe('recruiter');
    expect(moveTarget('topic')).toBe('dept');
  });
});
