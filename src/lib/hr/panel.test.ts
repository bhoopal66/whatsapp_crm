import { describe, expect, it } from 'vitest';

import {
  canEditRow,
  closeChoices,
  paneKind,
  paneMoveHintKey,
  paneSections,
  furthestStage,
  hasReason,
  hrOwnerChoices,
  laterStage,
  openKinds,
  outcomeToSend,
  panelActions,
  showHrPanel,
  showInterviewField,
  stepNeedsReason,
  stepperSteps,
} from './panel';
import type { HrConversation, HrRoles } from './types';

const ADMIN: HrRoles = { admin: true, recruiter: null, dept: null };
const REC_LEAD: HrRoles = { admin: false, recruiter: 'lead', dept: null };
const REC_MEMBER: HrRoles = { admin: false, recruiter: 'member', dept: null };
const DEPT_MEMBER: HrRoles = { admin: false, recruiter: null, dept: 'member' };
const DEPT_LEAD: HrRoles = { admin: false, recruiter: null, dept: 'lead' };
const NONE: HrRoles = { admin: false, recruiter: null, dept: null };

function row(over: Partial<HrConversation> = {}): HrConversation {
  return {
    conversation_id: 'c1',
    account_id: 'a1',
    inbox: 'recruiter',
    stage_key: 'ai_interview',
    topic: null,
    urgent: false,
    upset: false,
    last_inbound_at: null,
    last_outbound_at: null,
    reply_state: 'new',
    outcome: null,
    closed_at: null,
    interview_at: null,
    created_at: '2026-11-16T00:00:00Z',
    created_by: null,
    updated_at: '2026-11-16T00:00:00Z',
    ...over,
  };
}
const dept = (over: Partial<HrConversation> = {}) =>
  row({ inbox: 'dept', stage_key: null, topic: 'payroll', ...over });
const closed = (over: Partial<HrConversation> = {}) =>
  row({ closed_at: '2026-11-16T01:00:00Z', outcome: 'hired', ...over });

describe('showHrPanel', () => {
  it('needs an HR role', () => {
    expect(showHrPanel(null, 'hr', true)).toBe(false);
    expect(showHrPanel(NONE, 'hr', true)).toBe(false);
  });
  it('shows on an HR chat or a chat that has a row', () => {
    expect(showHrPanel(REC_MEMBER, 'hr', false)).toBe(true);
    expect(showHrPanel(DEPT_MEMBER, null, true)).toBe(true);
    expect(showHrPanel(ADMIN, 'sales', true)).toBe(true);
  });
  it('hides on a non-HR chat with no row', () => {
    expect(showHrPanel(ADMIN, null, false)).toBe(false);
    expect(showHrPanel(REC_LEAD, 'it', false)).toBe(false);
  });
});

describe('openKinds', () => {
  it('offers the kinds whose target inbox the viewer writes', () => {
    expect(openKinds(ADMIN)).toEqual(['candidate', 'employee']);
    expect(openKinds(REC_LEAD)).toEqual(['candidate']);
    expect(openKinds(REC_MEMBER)).toEqual(['candidate']);
    expect(openKinds(DEPT_MEMBER)).toEqual(['employee']);
    expect(openKinds(NONE)).toEqual([]);
    expect(
      openKinds({ admin: false, recruiter: 'member', dept: 'lead' })
    ).toEqual(['candidate', 'employee']);
  });
});

describe('furthestStage / laterStage', () => {
  it('takes the max by position, not by order of rows', () => {
    expect(
      furthestStage([
        { to_stage: 'hr_interview' },
        { to_stage: 'cv_review' },
        { to_stage: 'ai_interview' },
      ])
    ).toBe('hr_interview');
  });
  it('ignores nulls and unknown stages', () => {
    expect(furthestStage([{ to_stage: null }, { to_stage: 'bogus' }])).toBe(
      null
    );
    expect(furthestStage([])).toBe(null);
    expect(furthestStage(null)).toBe(null);
    expect(furthestStage([{ to_stage: null }, { to_stage: 'cv_review' }])).toBe(
      'cv_review'
    );
  });
  it('laterStage keeps the further of two', () => {
    expect(laterStage('cv_review', 'manager_interview')).toBe(
      'manager_interview'
    );
    expect(laterStage('hr_interview', null)).toBe('hr_interview');
    expect(laterStage(null, undefined)).toBe(null);
  });
});

describe('stepperSteps on a recruiter row', () => {
  const r = row({ stage_key: 'hr_interview' });
  it('marks progress done / current / todo', () => {
    expect(
      stepperSteps(r, REC_MEMBER, 'hr_interview').map((s) => s.progress)
    ).toEqual(['done', 'done', 'current', 'todo']);
  });
  it('a member moves forward but earlier steps are locked', () => {
    const steps = stepperSteps(r, REC_MEMBER, 'hr_interview');
    expect(steps.map((s) => s.move)).toEqual([
      'locked',
      'locked',
      'none',
      'forward',
    ]);
    expect(steps.map(stepNeedsReason)).toEqual([false, false, false, false]);
  });
  it('a lead and an admin may step back, with a reason', () => {
    for (const roles of [REC_LEAD, ADMIN]) {
      const steps = stepperSteps(r, roles, 'hr_interview');
      expect(steps.map((s) => s.move)).toEqual([
        'backward',
        'backward',
        'none',
        'forward',
      ]);
      expect(steps.map(stepNeedsReason)).toEqual([true, true, false, false]);
    }
  });
  it('is display only for a viewer outside the recruiter inbox', () => {
    for (const roles of [DEPT_MEMBER, DEPT_LEAD, NONE]) {
      expect(stepperSteps(r, roles, null).every((s) => s.move === 'none')).toBe(
        true
      );
    }
  });
  it('is display only on a closed row', () => {
    const steps = stepperSteps(
      closed({ stage_key: 'hr_interview' }),
      ADMIN,
      null
    );
    expect(steps.every((s) => s.move === 'none')).toBe(true);
    expect(steps[2].progress).toBe('current');
  });
});

describe('stepperSteps on a dept row (Move to recruitment)', () => {
  it('a first entry is forward to every stage, for a dept member', () => {
    const steps = stepperSteps(dept(), DEPT_MEMBER, null);
    expect(steps.map((s) => s.move)).toEqual([
      'forward',
      'forward',
      'forward',
      'forward',
    ]);
    expect(steps.every((s) => s.progress === 'todo')).toBe(true);
  });
  it('below the furthest stage is backward (the loophole fix)', () => {
    expect(
      stepperSteps(dept(), DEPT_MEMBER, 'hr_interview').map((s) => s.move)
    ).toEqual(['locked', 'locked', 'forward', 'forward']);
    expect(
      stepperSteps(dept(), ADMIN, 'hr_interview').map((s) => s.move)
    ).toEqual(['backward', 'backward', 'forward', 'forward']);
  });
  it('a dept lead is no recruiter lead: backward stays locked', () => {
    expect(
      stepperSteps(dept(), DEPT_LEAD, 'ai_interview').map((s) => s.move)
    ).toEqual(['locked', 'forward', 'forward', 'forward']);
  });
  it('a recruiter-only member cannot write a dept row', () => {
    expect(
      stepperSteps(dept(), REC_LEAD, null).every((s) => s.move === 'none')
    ).toBe(true);
  });
});

describe('panelActions', () => {
  it('recruiter row, recruiter member', () => {
    expect(panelActions(row(), REC_MEMBER)).toEqual({
      edit: true,
      stepper: true,
      topic: false,
      close: { needsOutcome: true },
      reopen: false,
      moveToDept: true,
      moveToRecruitment: false,
    });
  });
  it('dept row, dept member', () => {
    expect(panelActions(dept(), DEPT_MEMBER)).toEqual({
      edit: true,
      stepper: false,
      topic: true,
      close: { needsOutcome: false },
      reopen: false,
      moveToDept: false,
      moveToRecruitment: true,
    });
  });
  it('read only for a viewer outside the row inbox', () => {
    for (const [r, roles] of [
      [row(), DEPT_LEAD],
      [dept(), REC_LEAD],
      [row(), NONE],
    ] as const) {
      const a = panelActions(r, roles);
      expect(a.edit).toBe(false);
      expect(a.close).toBe(false);
      expect(a.reopen).toBe(false);
      expect(a.moveToDept || a.moveToRecruitment).toBe(false);
    }
  });
  it('closed row: only reopen, for a lead of that inbox or an admin', () => {
    expect(panelActions(closed(), REC_LEAD).reopen).toBe(true);
    expect(panelActions(closed(), ADMIN).reopen).toBe(true);
    expect(panelActions(closed(), REC_MEMBER).reopen).toBe(false);
    expect(panelActions(closed(), DEPT_LEAD).reopen).toBe(false);
    const d = dept({ closed_at: '2026-11-16T01:00:00Z' });
    expect(panelActions(d, DEPT_LEAD).reopen).toBe(true);
    expect(panelActions(d, DEPT_MEMBER).reopen).toBe(false);
    const a = panelActions(closed(), ADMIN);
    expect(a.edit).toBe(false);
    expect(a.close).toBe(false);
    expect(a.moveToDept).toBe(false);
  });
  it('canEditRow mirrors open + write', () => {
    expect(canEditRow(row(), ADMIN)).toBe(true);
    expect(canEditRow(closed(), ADMIN)).toBe(false);
    expect(canEditRow(dept(), REC_MEMBER)).toBe(false);
  });
});

describe('showInterviewField', () => {
  const shown = (r: HrConversation, roles: HrRoles) =>
    showInterviewField(r, panelActions(r, roles));

  it('shows on an open recruitment chat for whoever may edit it', () => {
    for (const roles of [ADMIN, REC_LEAD, REC_MEMBER])
      expect(shown(row(), roles)).toBe(true);
  });
  it('never on a department chat, even for its editors', () => {
    for (const roles of [ADMIN, DEPT_LEAD, DEPT_MEMBER])
      expect(shown(dept(), roles)).toBe(false);
  });
  it('not on a closed recruitment chat', () => {
    for (const roles of [ADMIN, REC_LEAD, REC_MEMBER])
      expect(shown(closed(), roles)).toBe(false);
  });
  it('not for a viewer who may not edit the recruiter inbox', () => {
    for (const roles of [DEPT_LEAD, DEPT_MEMBER, NONE])
      expect(shown(row(), roles)).toBe(false);
  });
});

describe('outcomeToSend', () => {
  it('sends the pick only on a recruiter row', () => {
    expect(outcomeToSend({ inbox: 'recruiter' }, 'hired')).toBe('hired');
    expect(outcomeToSend({ inbox: 'recruiter' }, '')).toBeNull();
  });
  it('is null on a dept row even when an outcome is selected', () => {
    expect(outcomeToSend({ inbox: 'dept' }, 'hired')).toBeNull();
  });
});

describe('hasReason', () => {
  it('refuses blank, tab and newline reasons', () => {
    expect(hasReason('moved by mistake')).toBe(true);
    expect(hasReason('')).toBe(false);
    expect(hasReason(' \t\n')).toBe(false);
    expect(hasReason(null)).toBe(false);
  });
});

describe('paneKind', () => {
  it('is unsorted with no row, else the inbox', () => {
    expect(paneKind(null)).toBe('unsorted');
    expect(paneKind(row())).toBe('recruiter');
    expect(paneKind(dept())).toBe('dept');
  });
});

describe('paneSections', () => {
  const sections = (r: HrConversation, roles: HrRoles) =>
    paneSections(r, panelActions(r, roles));

  it('a recruitment chat leads with the stage, then the topic move', () => {
    expect(sections(row(), REC_MEMBER)).toEqual([
      'stage',
      'topic',
      'flags',
      'reply',
      'close',
    ]);
  });
  it('a department chat leads with the topic, then the stage move', () => {
    expect(sections(dept(), DEPT_MEMBER)).toEqual([
      'topic',
      'stage',
      'flags',
      'reply',
      'close',
    ]);
  });
  it('leaves out moves and Close for a viewer who cannot write', () => {
    expect(sections(row(), DEPT_MEMBER)).toEqual(['stage', 'flags', 'reply']);
    expect(sections(dept(), REC_LEAD)).toEqual(['topic', 'flags', 'reply']);
  });
  it('a closed chat keeps Close (for Closed and Reopen) but moves nowhere', () => {
    expect(sections(closed(), REC_LEAD)).toEqual([
      'stage',
      'flags',
      'reply',
      'close',
    ]);
    expect(sections(closed(), DEPT_MEMBER)).toEqual([
      'stage',
      'flags',
      'reply',
      'close',
    ]);
  });
});

describe('paneMoveHintKey', () => {
  it('hints only on the section that moves the chat', () => {
    expect(paneMoveHintKey('recruiter', 'topic')).toBe('pane.movesToDept');
    expect(paneMoveHintKey('dept', 'stage')).toBe('pane.movesToRecruiter');
    expect(paneMoveHintKey('recruiter', 'stage')).toBeNull();
    expect(paneMoveHintKey('dept', 'topic')).toBeNull();
    expect(paneMoveHintKey('dept', 'close')).toBeNull();
  });
});

describe('closeChoices', () => {
  it('one confirmed button per outcome on a recruitment chat', () => {
    expect(closeChoices(row())).toEqual([
      {
        outcome: 'hired',
        labelKey: 'outcome.hired',
        confirmKey: 'pane.closeAs',
      },
      {
        outcome: 'not_selected',
        labelKey: 'outcome.not_selected',
        confirmKey: 'pane.closeAs',
      },
      {
        outcome: 'withdrawn',
        labelKey: 'outcome.withdrawn',
        confirmKey: 'pane.closeAs',
      },
    ]);
  });
  it('a single outcome-less close on a department chat', () => {
    expect(closeChoices(dept())).toEqual([
      {
        outcome: null,
        labelKey: 'pane.closeConversation',
        confirmKey: 'pane.closeConfirm',
      },
    ]);
  });
});

describe('hrOwnerChoices', () => {
  const assignable = ['me', 'omar', 'layla', 'sales'];
  const base = {
    inbox: 'recruiter' as const,
    myUserId: 'me',
    ownerId: null as string | null,
    assignable,
    teamUserIds: new Set(['me', 'omar', 'layla']),
  };

  it('an admin picks anyone assignable on the HR team, or Unassigned', () => {
    expect(hrOwnerChoices({ ...base, roles: ADMIN })).toEqual({
      userIds: ['me', 'omar', 'layla'],
      unassigned: true,
    });
  });

  it('a lead gets the team plus the current owner', () => {
    expect(
      hrOwnerChoices({ ...base, roles: REC_LEAD, ownerId: 'sales' })
    ).toEqual({ userIds: ['sales', 'me', 'omar', 'layla'], unassigned: true });
  });

  it('a lead of the other inbox gets nothing here', () => {
    expect(hrOwnerChoices({ ...base, roles: DEPT_LEAD })).toBeNull();
  });

  it('until the team is known an admin gets only the owner and Unassigned, never everyone', () => {
    expect(
      hrOwnerChoices({ ...base, roles: ADMIN, teamUserIds: null })
    ).toEqual({ userIds: [], unassigned: true });
    expect(
      hrOwnerChoices({
        ...base,
        roles: ADMIN,
        teamUserIds: null,
        ownerId: 'omar',
      })
    ).toEqual({ userIds: ['omar'], unassigned: true });
  });

  it('a known empty team (none set up) falls back to the assignable list', () => {
    expect(
      hrOwnerChoices({ ...base, roles: ADMIN, teamUserIds: new Set() })
    ).toEqual({ userIds: assignable, unassigned: true });
  });

  it('a member may claim an unowned chat', () => {
    expect(hrOwnerChoices({ ...base, roles: REC_MEMBER })).toEqual({
      userIds: ['me'],
      unassigned: true,
    });
  });

  it('a member may release their own chat', () => {
    expect(
      hrOwnerChoices({ ...base, roles: REC_MEMBER, ownerId: 'me' })
    ).toEqual({ userIds: ['me'], unassigned: true });
  });

  it("a member sees only the name on someone else's chat", () => {
    expect(
      hrOwnerChoices({ ...base, roles: REC_MEMBER, ownerId: 'omar' })
    ).toBeNull();
  });

  it('with no HR team configured a lead keeps the assignable list', () => {
    expect(
      hrOwnerChoices({ ...base, roles: REC_LEAD, teamUserIds: new Set() })
    ).toEqual({ userIds: assignable, unassigned: true });
  });

  it('no HR role: the name only', () => {
    expect(hrOwnerChoices({ ...base, roles: NONE })).toBeNull();
  });
});
