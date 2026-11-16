import { describe, expect, it } from 'vitest';

import {
  canEditRow,
  furthestStage,
  hasReason,
  laterStage,
  openKinds,
  outcomeToSend,
  panelActions,
  showHrPanel,
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
