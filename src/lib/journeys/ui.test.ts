import { describe, expect, it } from 'vitest';

import { SHIPPED_WORKFLOW as DEF } from './workflow';
import { NEW_STATE } from './types';
import {
  JOURNEY_STAGES,
  LABELLED_STATES,
  closeReasons,
  consentErrorKey,
  countByStage,
  decisionOptions,
  journeyErrorKey,
  nextTimer,
  recentHistory,
  stageOf,
  stateLabelKey,
  startBlocker,
  timerLabel,
  validUntilFromDate,
  windowStatus,
  WITHDRAW_OPT_IN,
} from './ui';

const NOW = '2026-10-12T10:00:00.000Z';

describe('states and stages', () => {
  it('labels and stages every state of the shipped workflow', () => {
    for (const s of [NEW_STATE, ...Object.keys(DEF.states)]) {
      expect(stateLabelKey(s), s).toBe(s);
      expect(stageOf(s), s).not.toBeNull();
    }
    expect([...LABELLED_STATES].sort()).toEqual(
      [NEW_STATE, ...Object.keys(DEF.states)].sort()
    );
  });

  it('maps states onto the funnel', () => {
    expect(stageOf('S_MENU')).toBe('menu');
    expect(stageOf('B_PITCH')).toBe('pitch');
    expect(stageOf('P_DECIDE')).toBe('quote');
    expect(stageOf('PRESCREEN')).toBe('quote');
    expect(stageOf('REMATCH')).toBe('submitted');
    expect(stageOf('RE_ENGAGE')).toBe('parked');
    expect(stageOf('WON')).toBe('won');
    expect(stageOf('CLOSED_ADVISOR')).toBe('closed');
    expect(stageOf('MYSTERY')).toBeNull();
    expect(stateLabelKey('MYSTERY')).toBeNull();
  });

  it('counts journeys per stage, every stage present', () => {
    const counts = countByStage([
      { state: 'DOCS' },
      { state: 'DOCS' },
      { state: 'CLOSED_NO_FIT' },
      { state: 'PARKED' },
      { state: 'MYSTERY' },
    ]);
    expect(Object.keys(counts)).toEqual([...JOURNEY_STAGES]);
    expect(counts).toMatchObject({ docs: 2, closed: 1, parked: 1, menu: 0 });
  });
});

describe('windowStatus', () => {
  const w = DEF.windows;
  it('is open for 24 hours after the last inbound message', () => {
    expect(
      windowStatus(
        { lastInboundAt: '2026-10-12T08:30:00.000Z', freeEntryUntil: null },
        NOW,
        w
      )
    ).toEqual({ kind: 'open', until: '2026-10-13T08:30:00.000Z' });
  });

  it('prefers the free entry window of an ad referral', () => {
    expect(
      windowStatus(
        {
          lastInboundAt: '2026-10-12T08:30:00.000Z',
          freeEntryUntil: '2026-10-15T08:30:00.000Z',
        },
        NOW,
        w
      )
    ).toEqual({ kind: 'freeEntry', until: '2026-10-15T08:30:00.000Z' });
  });

  it('is closed once both have lapsed, or with no inbound at all', () => {
    expect(
      windowStatus(
        {
          lastInboundAt: '2026-10-10T08:30:00.000Z',
          freeEntryUntil: '2026-10-11T08:30:00.000Z',
        },
        NOW,
        w
      )
    ).toEqual({ kind: 'closed' });
    expect(
      windowStatus({ lastInboundAt: null, freeEntryUntil: null }, NOW, w)
    ).toEqual({ kind: 'closed' });
  });
});

describe('timers and history', () => {
  it('picks the soonest pending timer', () => {
    const a = {
      kind: 'DOCS_REMINDER_2',
      fireAt: '2026-10-19T00:00:00Z',
      state: 'DOCS',
    };
    const b = {
      kind: 'DOCS_REMINDER_1',
      fireAt: '2026-10-15T00:00:00Z',
      state: 'DOCS',
    };
    expect(nextTimer([a, b])).toBe(b);
    expect(nextTimer([])).toBeNull();
  });

  it('names what a timer will do from the workflow', () => {
    const t = (state: string, kind: string) =>
      timerLabel(DEF, { state, kind, fireAt: NOW });
    expect(t('DOCS', 'DOCS_REMINDER_1')).toBe('docsReminder');
    expect(t('DOCS', 'DOCS_SILENCE')).toBe('reengage');
    expect(t('P_DECIDE', 'QUOTE_VALIDITY')).toBe('expiry');
    expect(t('FULFILMENT', 'OFFER_EXPIRY')).toBe('expiry');
    expect(t('RE_ENGAGE', 'REENGAGE_SILENCE')).toBe('autoClose');
    expect(t('REMATCH', 'REMATCH_SILENCE')).toBe('autoClose');
    expect(t('S_MENU', 'MENU_NUDGE')).toBe('nudge');
    expect(t('WON', 'THANKYOU')).toBe('thankYou');
    expect(t('DOCS', 'NOPE')).toBe('other');
  });

  it('keeps the last five history lines, newest first', () => {
    const h = Array.from({ length: 7 }, (_, i) => ({
      at: `2026-10-0${i + 1}T00:00:00Z`,
      from: `S${i}`,
      to: `S${i + 1}`,
      cause: 'X',
    }));
    expect(recentHistory(h).map((e) => e.to)).toEqual([
      'S7',
      'S6',
      'S5',
      'S4',
      'S3',
    ]);
  });
});

describe('decisionOptions', () => {
  const opts = (
    state: string,
    product: 'POS' | 'ACCOUNT' | 'LOAN' | null = 'POS',
    parkedReason: string | null = null
  ) => decisionOptions(DEF, { state, product, parkedReason });

  it('offers CLOSE in every open stage, and it needs a reason', () => {
    for (const [s, sd] of Object.entries(DEF.states)) {
      const close = opts(s).find((o) => o.decision === 'CLOSE');
      if (sd.terminal) expect(close, s).toBeUndefined();
      else
        expect(close, s).toEqual({
          decision: 'CLOSE',
          needsReason: true,
          acceptsValidUntil: false,
        });
    }
  });

  it("offers the stage's own decisions; only quote and offer ones take a validity", () => {
    expect(opts('PRESCREEN', 'LOAN')).toEqual([
      { decision: 'CLOSE', needsReason: true, acceptsValidUntil: false },
      { decision: 'FIT', needsReason: false, acceptsValidUntil: false },
      { decision: 'NO_FIT', needsReason: false, acceptsValidUntil: false },
    ]);
    expect(opts('P_QUOTE_WAIT')[1]).toEqual({
      decision: 'QUOTE_READY',
      needsReason: false,
      acceptsValidUntil: true,
    });
    expect(opts('FULFILMENT', 'LOAN')[1]).toEqual({
      decision: 'FULFILMENT_SCHEDULED',
      needsReason: false,
      acceptsValidUntil: true,
    });
    expect(opts('NEW')).toEqual([]);
    expect(opts('WON')).toEqual([]);
  });

  it('leaves out decisions limited to another product', () => {
    const pos = opts('PARKED', 'POS', 'VALIDITY_LAPSED').map((o) => o.decision);
    const loan = opts('PARKED', 'LOAN', 'VALIDITY_LAPSED').map(
      (o) => o.decision
    );
    expect(pos).toEqual([
      'CLOSE',
      'QUOTE_READY',
      'COMPARISON_READY',
      'FULFILMENT_SCHEDULED',
    ]);
    expect(loan).toEqual(['CLOSE', 'FULFILMENT_SCHEDULED']);
  });
});

describe('closeReasons', () => {
  it("is the workflow's NOT_WON reasons, without the opt-out", () => {
    expect(closeReasons(DEF)).toEqual([
      'OUTSIDE_APPETITE',
      'DECLINED_NO_REMATCH',
      'OFFER_REJECTED',
      'NO_RESPONSE',
    ]);
  });
});

describe('validUntilFromDate', () => {
  it('is the end of that local day', () => {
    const iso = validUntilFromDate('2026-10-20')!;
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([
      2026, 9, 20, 23,
    ]);
    expect(validUntilFromDate('')).toBeNull();
    expect(validUntilFromDate('20/10/2026')).toBeNull();
  });
});

describe('startBlocker', () => {
  const ok = {
    marketing_opt_in_at: NOW,
    opted_out_at: null,
    do_not_contact_at: null,
  };
  it("follows the start route's order", () => {
    expect(startBlocker(ok)).toBeNull();
    expect(startBlocker({ ...ok, marketing_opt_in_at: null })).toBe('noOptIn');
    expect(startBlocker({ ...ok, do_not_contact_at: NOW })).toBe(
      'doNotContact'
    );
    expect(
      startBlocker({ ...ok, do_not_contact_at: NOW, opted_out_at: NOW })
    ).toBe('optedOut');
  });
});

describe('error keys', () => {
  it('names each route code, anything else generic', () => {
    for (const c of [
      'DECISION_NOT_AVAILABLE',
      'REASON_REQUIRED',
      'CONFLICT',
      'OPTED_OUT',
      'DO_NOT_CONTACT',
      'NO_MARKETING_OPT_IN',
      'JOURNEYS_DISABLED',
    ])
      expect(journeyErrorKey(c)).toBe(c);
    expect(journeyErrorKey('WHATEVER')).toBe('generic');
    expect(journeyErrorKey(undefined)).toBe('generic');
  });

  it("maps the consent guard's errors", () => {
    expect(consentErrorKey({ code: '23514', message: 'x' })).toBe(
      'sourceRequired'
    );
    expect(
      consentErrorKey({
        code: '42501',
        message: 'Only an admin can clear do-not-contact',
      })
    ).toBe('adminOnly');
    expect(
      consentErrorKey({
        code: '42501',
        message:
          'Only an agent who can see this customer can change their marketing consent or do-not-contact',
      })
    ).toBe('notAllowed');
    expect(consentErrorKey({ code: 'PGRST116' })).toBe('generic');
    expect(consentErrorKey(null)).toBe('generic');
  });
});

describe('WITHDRAW_OPT_IN', () => {
  it('clears the stamp and its source together', () => {
    expect(WITHDRAW_OPT_IN).toEqual({
      marketing_opt_in_at: null,
      marketing_opt_in_source: null,
    });
    expect(
      startBlocker({
        ...WITHDRAW_OPT_IN,
        opted_out_at: null,
        do_not_contact_at: null,
      })
    ).toBe('noOptIn');
  });
});
