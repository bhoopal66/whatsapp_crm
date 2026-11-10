import { describe, expect, it } from 'vitest';

import type { HealthEvent } from './ingest';
import {
  assessNumberState,
  isAlarmTransition,
  nextNumberState,
  numberStateFromRow,
  type NumberHealthState,
} from './state';

const AT = '2025-10-04T17:46:40.000Z';
const empty = numberStateFromRow(null);
const pnq = (patch: Partial<HealthEvent>): HealthEvent => ({
  kind: 'phone_number_quality_update',
  at: AT,
  ...patch,
});
const acct = (patch: Partial<HealthEvent>): HealthEvent => ({
  kind: 'account_update',
  at: AT,
  event: 'ACCOUNT_RESTRICTION',
  ...patch,
});

describe('assessNumberState', () => {
  it('GREEN, no status → NORMAL', () => {
    expect(assessNumberState('GREEN', 'CONNECTED')).toEqual({
      assessedState: 'NORMAL',
      reasons: [],
    });
  });
  it('quality: YELLOW → THROTTLED, RED → MARKETING_PAUSED, unknown → NO_SIGNAL', () => {
    expect(assessNumberState('YELLOW', null).assessedState).toBe('THROTTLED');
    expect(assessNumberState('RED', null).assessedState).toBe(
      'MARKETING_PAUSED'
    );
    expect(assessNumberState(null, null)).toEqual({
      assessedState: 'NORMAL',
      reasons: ['NO_SIGNAL'],
    });
    expect(assessNumberState('UNKNOWN', 'PENDING').assessedState).toBe(
      'NORMAL'
    );
  });
  it('status: FLAGGED, RESTRICTED, total block; worst wins, reasons kept', () => {
    expect(assessNumberState('GREEN', 'FLAGGED').assessedState).toBe(
      'MARKETING_PAUSED'
    );
    expect(assessNumberState('YELLOW', 'RESTRICTED')).toEqual({
      assessedState: 'ALL_PAUSED',
      reasons: ['QUALITY_YELLOW', 'STATUS_RESTRICTED'],
    });
    for (const s of ['BANNED', 'DISCONNECTED'] as const) {
      expect(assessNumberState('GREEN', s)).toEqual({
        assessedState: 'ALL_PAUSED',
        reasons: ['TOTAL_BLOCK'],
      });
    }
  });
});

describe('nextNumberState', () => {
  it('FLAGGED raises, UNFLAGGED clears only FLAGGED', () => {
    const flagged = nextNumberState(empty, pnq({ event: 'FLAGGED' }));
    expect(flagged.changed).toBe(true);
    expect(flagged.next).toEqual({
      qualityRating: null,
      messagingLimitTier: null,
      accountStatus: 'FLAGGED',
      assessedState: 'MARKETING_PAUSED',
      reasons: ['NO_SIGNAL', 'STATUS_FLAGGED'],
    });
    const back = nextNumberState(flagged.next, pnq({ event: 'UNFLAGGED' }));
    expect(back.next).toMatchObject({
      accountStatus: 'CONNECTED',
      assessedState: 'NORMAL',
    });
    const restricted: NumberHealthState = {
      ...empty,
      accountStatus: 'RESTRICTED',
    };
    expect(
      nextNumberState(restricted, pnq({ event: 'UNFLAGGED' })).next
        .accountStatus
    ).toBe('RESTRICTED');
    expect(
      nextNumberState(restricted, pnq({ event: 'FLAGGED' })).next.accountStatus
    ).toBe('RESTRICTED');
  });

  it('current_limit sets a readable tier; others are reported', () => {
    const up = nextNumberState(
      empty,
      pnq({ event: 'UPGRADE', currentLimit: 'TIER_10K' })
    );
    expect(up.next.messagingLimitTier).toBe('TIER_10K');
    expect(up.unrecognised).toEqual([]);
    const odd = nextNumberState(
      up.next,
      pnq({ event: 'ONBOARDING', currentLimit: 'LOTS' })
    );
    expect(odd.next.messagingLimitTier).toBe('TIER_10K');
    expect(odd.unrecognised).toEqual([
      'TIER_UNRECOGNISED: LOTS',
      'NUMBER_EVENT_UNRECOGNISED: ONBOARDING',
    ]);
  });

  it('account_update: biz restriction → RESTRICTED, ban DISABLE → BANNED', () => {
    const r = nextNumberState(
      empty,
      acct({
        restrictions: [
          { type: 'RESTRICTED_BIZ_INITIATED_MESSAGING' },
          { type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION' },
        ],
      })
    );
    expect(r.next).toMatchObject({
      accountStatus: 'RESTRICTED',
      assessedState: 'ALL_PAUSED',
    });
    expect(r.unrecognised).toEqual([
      'RESTRICTION_UNRECOGNISED: RESTRICTED_ADD_PHONE_NUMBER_ACTION',
    ]);
    const ban = nextNumberState(r.next, acct({ banState: 'DISABLE' }));
    expect(ban.next.accountStatus).toBe('BANNED');
    expect(ban.next.reasons).toEqual(['NO_SIGNAL', 'TOTAL_BLOCK']);
    const sched = nextNumberState(
      empty,
      acct({ banState: 'SCHEDULE_FOR_DISABLE' })
    );
    expect(sched.changed).toBe(true); // NO_SIGNAL reason now recorded
    expect(sched.next.accountStatus).toBeNull();
    expect(sched.unrecognised).toEqual([
      'BAN_STATE_UNRECOGNISED: SCHEDULE_FOR_DISABLE',
    ]);
  });

  it('account_review_update with only a decision is unmapped', () => {
    const r = nextNumberState(
      { ...empty, reasons: ['NO_SIGNAL'] },
      { kind: 'account_review_update', at: AT, event: 'APPROVED' }
    );
    expect(r.changed).toBe(false);
    expect(r.unrecognised).toEqual(['ACCOUNT_EVENT_UNMAPPED: APPROVED']);
  });

  it('template events leave the number alone', () => {
    const r = nextNumberState(empty, {
      kind: 'message_template_quality_update',
      at: AT,
      newQuality: 'RED',
      templateName: 't',
    });
    expect(r).toEqual({ next: empty, changed: false, unrecognised: [] });
  });

  it('quality from the stored row drives the assessment', () => {
    const prev = numberStateFromRow({
      quality_rating: 'YELLOW',
      messaging_limit_tier: 'TIER_1K',
      account_status: 'NOT_A_STATUS',
      assessed_state: 'BOGUS',
      reasons: ['A', 3],
    });
    expect(prev).toEqual({
      qualityRating: 'YELLOW',
      messagingLimitTier: 'TIER_1K',
      accountStatus: null,
      assessedState: 'NORMAL',
      reasons: ['A'],
    });
    expect(
      nextNumberState(prev, pnq({ event: 'FLAGGED' })).next.reasons
    ).toEqual(['QUALITY_YELLOW', 'STATUS_FLAGGED']);
  });
});

describe('isAlarmTransition', () => {
  it('true only into a worse state', () => {
    expect(isAlarmTransition('NORMAL', 'THROTTLED')).toBe(true);
    expect(isAlarmTransition(null, 'ALL_PAUSED')).toBe(true);
    expect(isAlarmTransition('THROTTLED', 'MARKETING_PAUSED')).toBe(true);
    expect(isAlarmTransition('ALL_PAUSED', 'MARKETING_PAUSED')).toBe(false);
    expect(isAlarmTransition('THROTTLED', 'THROTTLED')).toBe(false);
    expect(isAlarmTransition(null, 'NORMAL')).toBe(false);
  });
});
