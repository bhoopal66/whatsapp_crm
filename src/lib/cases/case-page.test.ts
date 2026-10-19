import { describe, expect, it } from 'vitest';

import {
  canTakeOver,
  docRequestKey,
  detailsErrorKey,
  fromLocalInput,
  groupEndView,
  isFinalStage,
  normaliseAmount,
  OUTCOME_REASON_CODES,
  parseCaseDetail,
  resolveCaseTab,
  runningTimers,
  slaChipTone,
  stageErrorKey,
  stageMoveBody,
  takeoverNotApproved,
  toLocalInput,
  visibleCaseTabs,
} from './case-page';
import { OUTCOME_REASON_CODES as SERVER_REASON_CODES } from './dashboard';

const detail = {
  case: {
    id: 'c1',
    accountId: 'a1',
    groupId: 'g1',
    submissionRef: 'SUB-1',
    contactId: 'k1',
    contactName: 'Aisha',
    bankCode: 'ADCB',
    bankName: 'ADCB',
    product: 'Personal loan',
    amount: '150000.00',
    agentId: 'u1',
    coordinatorId: null,
    stage: 'Submitted',
    priority: 'high',
    dueAt: '2026-10-20T10:00:00.000Z',
    slaState: 'due_soon',
    openedAt: '2026-10-01T08:00:00.000Z',
    closedAt: null,
    outcome: null,
    groupEndedAt: null,
  },
  role: 'coordinator',
  permissions: { canWrite: true, canReassign: false, canSeeAudit: false },
  stages: ['Submitted', 'Approved', 'Declined', 'Withdrawn', 'Closed'],
  history: {
    stages: [
      {
        fromStage: null,
        toStage: 'Submitted',
        outcome: null,
        actorId: null,
        actorRole: 'api',
        changedAt: '2026-10-01T08:00:00.000Z',
      },
      { bogus: true },
    ],
    reassignments: [
      {
        field: 'agent',
        fromUser: 'u0',
        toUser: 'u1',
        actorId: 'u9',
        changedAt: '2026-10-02T08:00:00.000Z',
      },
      { field: 'owner', toUser: 'x' },
    ],
    details: [
      {
        field: 'amount',
        fromValue: '1',
        toValue: '2',
        actorId: 'u1',
        changedAt: '2026-10-03T08:00:00.000Z',
      },
    ],
  },
  timers: [
    {
      timer: 'bank_response',
      stage: 'Submitted',
      startedAt: '2026-10-01T08:00:00.000Z',
      dueSoonAt: '2026-10-02T08:00:00.000Z',
      dueAt: '2026-10-03T08:00:00.000Z',
      stoppedAt: null,
      state: 'due_soon',
    },
    {
      timer: 'customer_reply',
      stage: 'Submitted',
      startedAt: '2026-10-01T08:00:00.000Z',
      dueSoonAt: null,
      dueAt: null,
      stoppedAt: '2026-10-01T09:00:00.000Z',
      state: 'weird',
    },
  ],
  outcomeReason: null,
};

describe('parseCaseDetail', () => {
  it('reads a full detail and drops malformed rows', () => {
    const d = parseCaseDetail(detail);
    expect(d).not.toBeNull();
    expect(d!.case.priority).toBe('high');
    expect(d!.case.amount).toBe('150000.00');
    expect(d!.role).toBe('coordinator');
    expect(d!.permissions).toEqual({
      canWrite: true,
      canReassign: false,
      canSeeAudit: false,
    });
    expect(d!.history.stages).toHaveLength(1);
    expect(d!.history.reassignments).toHaveLength(1);
    expect(d!.history.details).toHaveLength(1);
    expect(d!.timers[1].state).toBeNull();
    expect(runningTimers(d!.timers).map((t) => t.timer)).toEqual([
      'bank_response',
    ]);
  });

  it('refuses a body that is not a case', () => {
    expect(parseCaseDetail(null)).toBeNull();
    expect(parseCaseDetail({ case: {} })).toBeNull();
    expect(parseCaseDetail({ ...detail, role: 'owner' })).toBeNull();
    expect(
      parseCaseDetail({ ...detail, case: { ...detail.case, stage: null } })
    ).toBeNull();
  });

  it('defaults what is missing rather than failing', () => {
    const d = parseCaseDetail({
      case: { ...detail.case, priority: 'whatever' },
      role: 'agent',
    });
    expect(d!.case.priority).toBe('normal');
    expect(d!.permissions.canWrite).toBe(false);
    expect(d!.stages).toEqual([]);
    expect(d!.history).toEqual({ stages: [], reassignments: [], details: [] });
    expect(d!.timers).toEqual([]);
    expect(d!.outcomeReason).toBeNull();
  });

  it('reads the outcome reason', () => {
    const d = parseCaseDetail({
      ...detail,
      outcomeReason: {
        reasonCode: 'KYC_AML',
        reasonText: null,
        createdAt: '2026-10-04T00:00:00.000Z',
      },
    });
    expect(d!.outcomeReason?.reasonCode).toBe('KYC_AML');
  });
});

describe('stage moves', () => {
  it('sends the outcome for Approved, Declined and Withdrawn only', () => {
    expect(stageMoveBody('Approved')).toEqual({
      stage: 'Approved',
      outcome: 'Approved',
    });
    expect(stageMoveBody('Declined')).toEqual({
      stage: 'Declined',
      outcome: 'Declined',
    });
    expect(stageMoveBody('Withdrawn')).toEqual({
      stage: 'Withdrawn',
      outcome: 'Withdrawn',
    });
    expect(stageMoveBody('Closed')).toEqual({ stage: 'Closed' });
    expect(stageMoveBody('Submitted')).toEqual({ stage: 'Submitted' });
  });

  it('knows the final stages', () => {
    expect(isFinalStage('Closed')).toBe(true);
    expect(isFinalStage('Approved')).toBe(true);
    expect(isFinalStage('Submitted')).toBe(false);
  });

  it('keeps the reason codes equal to the server list', () => {
    expect([...OUTCOME_REASON_CODES]).toEqual([...SERVER_REASON_CODES]);
  });
});

describe('groupEndView', () => {
  it('names what happened to the WhatsApp group', () => {
    expect(groupEndView(null)).toBeNull();
    expect(
      groupEndView({ groupEnded: false, reason: 'NO_GROUP', end: null })
    ).toBeNull();
    const end = (o: object) => ({
      ended: true,
      reason: null,
      closed: true,
      closeError: null,
      closeDeferred: false,
      ...o,
    });
    expect(
      groupEndView({ groupEnded: true, reason: 'ENDED', end: end({}) })
    ).toBe('ended');
    expect(
      groupEndView({
        groupEnded: true,
        reason: 'ENDED',
        end: end({ closed: false, closeDeferred: true }),
      })
    ).toBe('pending');
    expect(
      groupEndView({
        groupEnded: true,
        reason: 'ENDED',
        end: end({ closed: false, closeError: 'boom' }),
      })
    ).toBe('failed');
    expect(
      groupEndView({ groupEnded: false, reason: 'ALREADY_ENDED', end: null })
    ).toBe('ended');
    expect(
      groupEndView({ groupEnded: false, reason: 'END_FAILED', end: null })
    ).toBe('failed');
    expect(
      groupEndView({ groupEnded: false, reason: 'NO_DEPS', end: null })
    ).toBe('pending');
  });
});

describe('result codes', () => {
  it('maps document request results', () => {
    expect(docRequestKey(409, 'NOTHING_MISSING')).toBe('nothingMissing');
    expect(docRequestKey(409, 'BLOCKED')).toBe('blocked');
    expect(docRequestKey(409, 'REFUSED')).toBe('refused');
    expect(docRequestKey(409, 'SEND_FAILED')).toBe('sendFailed');
    expect(docRequestKey(429, 'SEND_RATE_LIMITED')).toBe('rateLimited');
    expect(docRequestKey(429, undefined)).toBe('rateLimited');
    expect(docRequestKey(500, undefined)).toBe('sendFailed');
  });

  it('maps stage and detail refusals', () => {
    expect(detailsErrorKey(422, 'STAGE_NOT_IN_LIST')).toBe('stageNotInList');
    expect(detailsErrorKey(422, 'BANK_UNKNOWN')).toBe('bankUnknown');
    expect(stageErrorKey(422, 'CASE_CLOSED')).toBe('caseClosed');
    expect(stageErrorKey(422, 'OUTCOME_STAGE_MISMATCH')).toBe('outcomeInvalid');
    expect(stageErrorKey(403, undefined)).toBe('notAllowed');
    expect(stageErrorKey(500, 'NOPE')).toBe('unknown');
  });

  it('recognises the not-yet-approved take-over', () => {
    expect(takeoverNotApproved(409, 'TEMPLATE_NOT_APPROVED')).toBe(true);
    expect(takeoverNotApproved(409, 'BLOCKED')).toBe(false);
  });
});

describe('SLA chips and tabs', () => {
  it('colours SLA states', () => {
    expect(slaChipTone('on_track')).toBe('ok');
    expect(slaChipTone('due_soon')).toBe('warn');
    expect(slaChipTone('overdue')).toBe('bad');
    expect(slaChipTone(null)).toBe('muted');
  });

  it('hides the audit tab unless allowed', () => {
    expect(visibleCaseTabs(false)).not.toContain('audit');
    expect(visibleCaseTabs(true)).toContain('audit');
    expect(resolveCaseTab('audit', false)).toBe('overview');
    expect(resolveCaseTab('audit', true)).toBe('audit');
    expect(resolveCaseTab('bank-contacts', false)).toBe('bank-contacts');
    expect(resolveCaseTab('nope', true)).toBe('overview');
    expect(resolveCaseTab(null, true)).toBe('overview');
  });
});

describe('inputs', () => {
  it('round-trips a local date-time', () => {
    const iso = '2026-10-20T10:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
  });

  it('normalises an amount', () => {
    expect(normaliseAmount('150,000.50')).toBe('150000.50');
    expect(normaliseAmount('12.345')).toBeNull();
    expect(normaliseAmount('abc')).toBeNull();
  });
});

describe('canTakeOver', () => {
  it('is for coordinators and team leads only (SQL 128)', () => {
    expect(canTakeOver('coordinator')).toBe(true);
    expect(canTakeOver('team_lead')).toBe(true);
    expect(canTakeOver('agent')).toBe(false);
    expect(canTakeOver('admin')).toBe(false);
    expect(canTakeOver('super_admin')).toBe(false);
  });
});
