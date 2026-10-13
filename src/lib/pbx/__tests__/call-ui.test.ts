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
  newContactPhone,
  noteFrames,
  otherOwner,
  ringElapsedMs,
  ringFloor,
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

describe('newContactPhone', () => {
  it("starts a new contact with the caller's number, international", () => {
    expect(newContactPhone('971501234567')).toBe('+971501234567');
    expect(newContactPhone('+971501234567')).toBe('+971501234567');
    expect(newContactPhone(null)).toBe('');
    expect(newContactPhone(undefined)).toBe('');
  });
});

describe('ringElapsedMs', () => {
  const now = Date.parse('2026-10-13T09:00:30Z');
  const shownAt = now - 4_000; // the card showed the call 4 s ago
  const ring = (
    rang_at: string | null | undefined,
    updated_at = '2026-10-13T09:00:00Z'
  ) => ({
    rang_at,
    updated_at,
  });
  // Seen 30 s ago (browser time), as it arrived, or in the first load.
  const arrived = {
    updatedAt: '2026-10-13T09:00:00Z',
    at: now - 30_000,
    live: true,
  };
  const loaded = { ...arrived, at: now - 4_000, live: false };

  it('counts on the server clocks from the frame, whatever the browser clock says', () => {
    expect(
      ringElapsedMs(ring('2026-10-13T09:00:00Z'), arrived, shownAt, now)
    ).toBe(30_000);
    // The frame came 10 s into the ring: 10 s + 30 s since it arrived.
    expect(
      ringElapsedMs(ring('2026-10-13T08:59:50Z'), arrived, shownAt, now)
    ).toBe(40_000);
    // A browser 5 minutes ahead, or 5 minutes behind: the same count.
    for (const skew of [300_000, -300_000])
      expect(
        ringElapsedMs(
          ring('2026-10-13T09:00:00Z'),
          { ...arrived, at: arrived.at + skew },
          shownAt + skew,
          now + skew
        )
      ).toBe(30_000);
    // A frame received just before its own row's stamp started the ring.
    expect(
      ringElapsedMs(ring('2026-10-13T09:00:00.050Z'), arrived, shownAt, now)
    ).toBe(30_000);
  });

  it('keeps the count across a reload: a first-load frame of unknown age uses this clock', () => {
    expect(
      ringElapsedMs(ring('2026-10-13T09:00:00Z'), loaded, shownAt, now)
    ).toBe(30_000);
    expect(
      formatTimer(ringElapsedMs(ring('2026-10-13T09:00:00Z'), loaded, now, now))
    ).toBe('0:30');
  });

  it('counts from when the card showed the call without a usable rang_at', () => {
    for (const rangAt of [undefined, null, '', 'not a time'])
      expect(ringElapsedMs(ring(rangAt), arrived, shownAt, now)).toBe(4_000);
    // Older than any ring: a stale row, or a clock hours out.
    const old = new Date(now - RING_TIMER_MAX_MS - 1).toISOString();
    expect(
      ringElapsedMs(ring(old, old), { ...loaded, updatedAt: old }, shownAt, now)
    ).toBe(4_000);
    // Ahead of this clock (behind the database) with nothing seen arrive.
    expect(
      ringElapsedMs(ring('2026-10-13T09:00:40Z'), null, shownAt, now)
    ).toBe(4_000);
    expect(ringElapsedMs(ring(null), null, now + 1_000, now)).toBe(0);
  });

  it('a call after 40 idle minutes starts at 0:00', () => {
    // The page sat idle; the call's first frame arrives now and makes
    // it my ringing call (the provider stamps both with this update's now).
    const at = now;
    const call = row({
      rang_at: '2026-10-13T09:00:30Z',
      updated_at: '2026-10-13T09:00:30Z',
    });
    const frames = noteFrames({}, [call], at, true);
    const floor = ringFloor({ key: 'c1:p0', at: at - 40 * 60_000 }, call, at);
    expect(floor).toEqual({ key: liveKey(call), at });
    expect(
      formatTimer(
        ringElapsedMs(call, frames[liveKey(call)], floor!.at, at + 1_000)
      )
    ).toBe('0:01');
  });
});

describe('noteFrames and ringFloor', () => {
  const r1 = row({ updated_at: '2026-10-12T10:00:00Z' });
  it('keeps when a frame was first seen until its updated_at changes', () => {
    const first = noteFrames({}, [r1], 1_000, false);
    expect(first).toEqual({
      'c1:p1': { updatedAt: '2026-10-12T10:00:00Z', at: 1_000, live: false },
    });
    // The next poll returns the same frame: nothing moves.
    expect(noteFrames(first, [r1], 5_000, true)['c1:p1']).toBe(first['c1:p1']);
    const next = noteFrames(
      first,
      [{ ...r1, updated_at: '2026-10-12T10:00:09Z' }],
      9_000,
      true
    );
    expect(next['c1:p1']).toEqual({
      updatedAt: '2026-10-12T10:00:09Z',
      at: 9_000,
      live: true,
    });
    // A call that ended drops out.
    expect(noteFrames(next, [], 10_000, true)).toEqual({});
  });
  it('restarts the floor when the call stops ringing me and rings me again', () => {
    const shown = ringFloor(null, r1, 1_000);
    expect(shown).toEqual({ key: 'c1:p1', at: 1_000 });
    expect(ringFloor(shown, r1, 9_000)).toBe(shown);
    // Answered by someone (not ringing me), then transferred to me.
    expect(ringFloor(ringFloor(shown, null, 60_000), r1, 300_000)).toEqual({
      key: 'c1:p1',
      at: 300_000,
    });
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
  const sara = { contactId: 'k-a', callKey: 'c1:p1', facts: { owner: SARA } };
  it('shows facts only for the contact they were loaded for', () => {
    expect(factsFor(sara, 'k-a', 'c1:p1')).toEqual({ owner: SARA });
    // The next call's customer: nothing until its own load lands.
    expect(factsFor(sara, 'k-b', 'c1:p1')).toBeNull();
  });
  it('shows a repeat caller nothing from the last call', () => {
    // Marked do-not-contact between the calls: the old "Calls OK" must
    // not show on the new call while its own load is in flight.
    expect(factsFor(sara, 'k-a', 'c1:p2')).toBeNull();
    expect(factsFor(sara, 'k-a', null)).toBeNull();
    expect(factsFor({ ...sara, callKey: null }, 'k-a', null)).toEqual({
      owner: SARA,
    });
  });
  it('shows nothing with no contact, or before any load', () => {
    expect(factsFor(sara, null, 'c1:p1')).toBeNull();
    expect(factsFor(null, 'k-a', 'c1:p1')).toBeNull();
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
