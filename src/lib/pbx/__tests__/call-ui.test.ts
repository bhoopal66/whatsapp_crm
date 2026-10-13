import { describe, expect, it } from 'vitest';
import {
  DISPOSITIONS,
  NOTES_MAX as ROUTE_NOTES_MAX,
  OVERRIDE_REASON_MAX as ROUTE_OVERRIDE_MAX,
} from '../calls';
import {
  CARD_NOTES_MAX,
  NOTES_MAX,
  OUTCOMES,
  OVERRIDE_REASON_MAX,
  RING_TIMER_MAX_MS,
  alsoRinging,
  canTransferToOwner,
  callCardText,
  clip,
  consentState,
  consentText,
  contactCandidates,
  dialResult,
  factsFor,
  formatTimer,
  isCustomerCall,
  liveKey,
  maskPhone,
  messageWhen,
  myActiveCall,
  myRingingCall,
  needsOutcome,
  otherOwner,
  ringElapsedMs,
  type CallCardLabels,
  type CallLiveRow,
} from '../call-ui';

const ME = 'u-me';
const SARA = 'u-sara';
const OMAR = 'u-omar';
const inbound = {
  kind: 'inbound',
  channelId: 't1',
  status: 'ALERT',
  from: '971501234567',
};
const outbound = {
  kind: 'outbound',
  channelId: 't2',
  status: 'ANSWERED',
  to: '971501234567',
};
const ext = (n: string, status = 'RING') => ({
  kind: 'extension',
  channelId: `e${n}`,
  status,
  number: n,
});

function row(p: Partial<CallLiveRow> = {}): CallLiveRow {
  return {
    connection_id: 'c1',
    pbx_call_id: 'p1',
    account_id: 'a1',
    contact_id: null,
    remote_number: '971501234567',
    did_number: null,
    ringing_user_ids: [ME],
    answered_by: null,
    members: [inbound, ext('101')],
    state: 'ringing',
    updated_at: '2026-10-12T10:00:00Z',
    ...p,
  };
}

describe('constants mirror the routes', () => {
  it('offers exactly the dispositions the DB accepts', () => {
    expect([...OUTCOMES]).toEqual([...DISPOSITIONS]);
  });
  it('limits notes and override reasons as the routes do', () => {
    expect(NOTES_MAX).toBe(ROUTE_NOTES_MAX);
    expect(OVERRIDE_REASON_MAX).toBe(ROUTE_OVERRIDE_MAX);
  });
});

describe('myRingingCall', () => {
  it('is an inbound, unanswered call ringing my extension', () => {
    expect(myRingingCall([row()], ME)?.pbx_call_id).toBe('p1');
  });
  it('ignores a call a leader merely sees', () => {
    expect(myRingingCall([row({ ringing_user_ids: [SARA] })], ME)).toBeNull();
  });
  it('ignores an answered call, even if my id lingers', () => {
    expect(myRingingCall([row({ answered_by: SARA })], ME)).toBeNull();
  });
  it('ignores my own click-to-call ringing my phone first', () => {
    const r = row({ members: [ext('101')] });
    expect(myRingingCall([r], ME)).toBeNull();
    expect(
      myRingingCall([row({ members: [ext('101'), outbound] })], ME)
    ).toBeNull();
  });
  it('picks the oldest of two and needs a user', () => {
    const late = row({ pbx_call_id: 'p2', updated_at: '2026-10-12T10:00:09Z' });
    expect(myRingingCall([late, row()], ME)?.pbx_call_id).toBe('p1');
    expect(myRingingCall([row()], null)).toBeNull();
  });
});

describe('myActiveCall', () => {
  it('is a customer call I answered, inbound or click-to-call', () => {
    expect(
      myActiveCall([row({ answered_by: ME, state: 'answered' })], ME)
    ).not.toBeNull();
    const out = row({
      members: [ext('101', 'ANSWERED'), outbound],
      answered_by: ME,
    });
    expect(myActiveCall([out], ME)?.pbx_call_id).toBe('p1');
  });
  it('is not a call someone else answered or an internal call', () => {
    expect(myActiveCall([row({ answered_by: SARA })], ME)).toBeNull();
    const internal = row({
      members: [ext('101', 'ANSWERED'), ext('102')],
      answered_by: ME,
    });
    expect(isCustomerCall(internal)).toBe(false);
    expect(myActiveCall([internal], ME)).toBeNull();
  });
  it('survives a malformed members value', () => {
    expect(
      myActiveCall([row({ members: null, answered_by: ME })], ME)
    ).toBeNull();
    expect(liveKey(row())).toBe('c1:p1');
  });
});

describe('contactCandidates', () => {
  it('reads the candidates riding on the customer leg, once each', () => {
    const r = row({
      members: [
        { ...inbound, contactCandidates: ['k1', 'k2', 'k1', 7] },
        ext('101'),
      ],
    });
    expect(contactCandidates(r)).toEqual(['k1', 'k2']);
    expect(contactCandidates(row())).toEqual([]);
  });
});

describe('maskPhone', () => {
  it('keeps the country code and the last four of a long number', () => {
    expect(maskPhone('971501234567')).toBe('+971 ••••• 4567');
    expect(maskPhone('+971 50 123 4567')).toBe('+971 ••••• 4567');
    expect(maskPhone('0501234567')).toBe('050 ••• 4567');
  });
  it('keeps less of a short number', () => {
    expect(maskPhone('1234567')).toBe('••• 4567');
    expect(maskPhone('8001')).toBe('•• 01');
    expect(maskPhone('12')).toBe('••');
    expect(maskPhone(null)).toBe('');
  });
  it('never shows more than seven digits of a number', () => {
    for (const n of ['971501234567', '447700900123', '12025550123'])
      expect(maskPhone(n).replace(/\D/g, '').length).toBeLessThanOrEqual(7);
  });
});

describe('formatTimer', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatTimer(7_000)).toBe('0:07');
    expect(formatTimer(192_400)).toBe('3:12');
    expect(formatTimer(3_723_000)).toBe('1:02:03');
    expect(formatTimer(-5)).toBe('0:00');
    expect(formatTimer(Number.NaN)).toBe('0:00');
  });
});

describe('ringElapsedMs', () => {
  const now = Date.parse('2026-10-13T09:00:30Z');
  const shownAt = now - 4_000; // the card showed the call 4 s ago

  it('counts from when the call first rang, so a reload keeps the count', () => {
    expect(ringElapsedMs('2026-10-13T09:00:00Z', shownAt, now)).toBe(30_000);
    expect(formatTimer(ringElapsedMs('2026-10-13T09:00:00Z', now, now))).toBe(
      '0:30'
    );
  });

  it('counts from the first render without rang_at (before 094)', () => {
    for (const rangAt of [undefined, null, '', 'not a time'])
      expect(ringElapsedMs(rangAt, shownAt, now)).toBe(4_000);
  });

  it('never shows a negative or absurd time when the clocks disagree', () => {
    // Ahead of this clock: the browser is behind the database.
    expect(ringElapsedMs('2026-10-13T09:00:40Z', shownAt, now)).toBe(4_000);
    // Older than any ring: a stale row, or a clock hours out.
    const old = new Date(now - RING_TIMER_MAX_MS - 1).toISOString();
    expect(ringElapsedMs(old, shownAt, now)).toBe(4_000);
    // Never less than since the card showed it, so it never runs back.
    expect(ringElapsedMs('2026-10-13T09:00:28Z', shownAt, now)).toBe(4_000);
    expect(ringElapsedMs(null, now + 1_000, now)).toBe(0);
  });
});

describe('consent', () => {
  it('never reads "Calls OK" for consent it could not read', () => {
    // A contact the person's own read hides came back empty: that once
    // read "Calls OK" for a do-not-contact customer.
    expect(consentText({ consentKnown: false }, labels)).toBe('Unknown');
  });
  const labels = {
    callsOk: 'Calls OK',
    doNotContact: 'Do not contact',
    optedOut: 'Opted out',
    unknown: 'Unknown',
    marketingOn: 'marketing on',
    marketingOff: 'marketing off',
  };
  it('reads calls OK and marketing off by default', () => {
    expect(consentText({}, labels)).toBe('Calls OK · marketing off');
  });
  it('turns marketing on only with an opt-in and no opt-out', () => {
    const optIn = { marketing_opt_in_at: '2026-01-01' };
    expect(consentText(optIn, labels)).toBe('Calls OK · marketing on');
    expect(consentText({ ...optIn, opted_out_at: '2026-02-01' }, labels)).toBe(
      'Opted out · marketing off'
    );
  });
  it('does not call a do-not-contact customer, and carries the reason', () => {
    const c = {
      do_not_contact_at: '2026-03-01',
      do_not_contact_reason: ' Asked ',
      marketing_opt_in_at: '2026-01-01',
    };
    expect(consentState(c)).toEqual({
      callsOk: false,
      dncReason: 'Asked',
      marketing: false,
    });
    expect(consentText(c, labels)).toBe(
      'Do not contact: Asked · marketing off'
    );
    expect(
      consentState({ do_not_contact_at: 'x', do_not_contact_reason: ' ' })
        .dncReason
    ).toBeNull();
  });
});

describe('alsoRinging', () => {
  it('names the others, not me, and counts the rest', () => {
    const r = row({ ringing_user_ids: [ME, SARA, OMAR, 'u-x', SARA] });
    expect(alsoRinging(r, ME, { [SARA]: 'Sara', [OMAR]: 'Omar' })).toEqual({
      names: ['Sara', 'Omar'],
      more: 1,
    });
    expect(
      alsoRinging(r, ME, { [SARA]: 'Sara', [OMAR]: 'Omar', 'u-x': 'X' }, 1)
    ).toEqual({
      names: ['Sara'],
      more: 2,
    });
    expect(alsoRinging(row(), ME, {})).toEqual({ names: [], more: 0 });
  });
});

describe('callCardText', () => {
  const labels: CallCardLabels = {
    heading: (d, who) => `${d} call with ${who}`,
    direction: {
      inbound: 'Inbound',
      outbound: 'Outbound',
      internal: 'Internal',
    },
    outcome: {
      interested: 'Interested',
      docs_requested: 'Docs requested',
      call_back: 'Call back',
      not_eligible: 'Not eligible',
      wrong_number: 'Wrong number',
    },
    noOutcome: 'No outcome',
    unknownCaller: 'Unknown caller',
  };
  const base = {
    direction: 'inbound' as const,
    talkSeconds: 192,
    outcome: 'interested' as const,
  };

  it('reads as the walkthrough shows it', () => {
    expect(
      callCardText(
        {
          ...base,
          contactName: 'Acme Trading',
          notes: ' Wants  the card form ',
        },
        labels
      )
    ).toBe(
      '📞 Inbound call with Acme Trading · 3:12 · Interested — Wants the card form'
    );
  });
  it('says when there is no outcome and leaves out empty notes', () => {
    expect(
      callCardText(
        { ...base, contactName: 'Acme', outcome: null, talkSeconds: null },
        labels
      )
    ).toBe('📞 Inbound call with Acme · 0:00 · No outcome');
  });
  it('names an unknown customer by a masked number, never the number', () => {
    const text = callCardText(
      { ...base, contactName: ' ', remoteNumber: '971501234567' },
      labels
    );
    expect(text).toContain('+971 ••••• 4567');
    expect(text).not.toContain('971501234567');
    expect(text).not.toMatch(/\d{5,}/);
  });
  it('falls back to "Unknown caller" and clips long notes', () => {
    const text = callCardText({ ...base, notes: 'n'.repeat(5000) }, labels);
    expect(text.startsWith('📞 Inbound call with Unknown caller')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(CARD_NOTES_MAX + 80);
    expect(clip('ab😀cd', 4)).toBe('ab😀…');
  });
});

describe('dialResult', () => {
  it('maps the dial route answers', () => {
    expect(dialResult(200, { pbxCallId: 'x1' })).toEqual({
      kind: 'ok',
      pbxCallId: 'x1',
    });
    expect(
      dialResult(409, { code: 'do_not_contact', reason: 'Asked' })
    ).toEqual({
      kind: 'do_not_contact',
      reason: 'Asked',
    });
    expect(dialResult(409, { code: 'no_extension' })).toEqual({
      kind: 'no_extension',
    });
    expect(dialResult(502, { error: 'PBX down' })).toEqual({
      kind: 'error',
      message: 'PBX down',
    });
    expect(dialResult(200, null)).toEqual({ kind: 'error', message: null });
  });
});

describe('needsOutcome', () => {
  it('asks only when mandatory and unset', () => {
    expect(needsOutcome(true, null)).toBe(true);
    expect(needsOutcome(true, 'call_back')).toBe(false);
    expect(needsOutcome(false, null)).toBe(false);
  });
});

describe('factsFor', () => {
  const sara = { contactId: 'k-a', facts: { owner: SARA } };
  it('shows facts only for the contact they were loaded for', () => {
    expect(factsFor(sara, 'k-a')).toEqual({ owner: SARA });
    // The next call's customer: nothing until its own load lands.
    expect(factsFor(sara, 'k-b')).toBeNull();
  });
  it('shows nothing with no contact, or before any load', () => {
    expect(factsFor(sara, null)).toBeNull();
    expect(factsFor(null, 'k-a')).toBeNull();
  });
});

describe('otherOwner and canTransferToOwner', () => {
  it('names the owner only when that is someone else', () => {
    expect(otherOwner(SARA, ME)).toBe(SARA);
    expect(otherOwner(ME, ME)).toBeNull();
    expect(otherOwner(null, ME)).toBeNull();
    expect(otherOwner(undefined, null)).toBeNull();
  });
  it('offers the transfer for another owner on another extension', () => {
    expect(canTransferToOwner(SARA, ME, '102', '101')).toBe(true);
    expect(canTransferToOwner(ME, ME, '101', '101')).toBe(false);
    expect(canTransferToOwner(SARA, ME, null, '101')).toBe(false);
    expect(canTransferToOwner(SARA, ME, '101', '101')).toBe(false);
    expect(canTransferToOwner(null, ME, '102', '101')).toBe(false);
  });
});

describe('messageWhen', () => {
  const opts = { locale: 'en-GB', timeZone: 'Asia/Dubai' };
  const now = Date.parse('2026-10-13T08:00:00Z'); // 12:00 in Dubai
  it('is the time alone for a message from today', () => {
    expect(messageWhen('2026-10-13T05:30:00Z', now, opts)).toBe('09:30');
  });
  it('adds the date for an earlier day', () => {
    expect(messageWhen('2026-10-06T05:30:00Z', now, opts)).toBe('6 Oct, 09:30');
  });
  it('judges "today" in the printed time zone', () => {
    // 21:30 UTC on the 12th is 01:30 on the 13th in Dubai.
    expect(messageWhen('2026-10-12T21:30:00Z', now, opts)).toBe('01:30');
    expect(messageWhen('2026-10-12T19:30:00Z', now, opts)).toBe(
      '12 Oct, 23:30'
    );
  });
  it('adds the year for another year', () => {
    expect(messageWhen('2025-12-30T05:30:00Z', now, opts)).toBe(
      '30 Dec 2025, 09:30'
    );
  });
  it('is empty for an unreadable time', () => {
    expect(messageWhen('not a time', now, opts)).toBe('');
  });
});
