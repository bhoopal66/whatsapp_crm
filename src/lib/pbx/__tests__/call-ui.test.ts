import { describe, expect, it } from 'vitest';
import {
  DISPOSITIONS,
  NOTES_MAX as ROUTE_NOTES_MAX,
  OVERRIDE_REASON_MAX as ROUTE_OVERRIDE_MAX,
} from '../calls';
import {
  NOTES_MAX,
  OUTCOMES,
  OVERRIDE_REASON_MAX,
  RING_TIMER_MAX_MS,
  alsoRinging,
  canTransferToOwner,
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
  type CallLiveRow,
  loadsPbxMe,
  callBackFor,
  callsTab,
  shownCallsTab,
  callsListReady,
  visibleCallTabs,
  dialBody,
  cleanDialInput,
  canDialInput,
  isExtensionNumber,
  pushRecentDial,
  readRecentDials,
  RECENT_DIALS_MAX,
} from '../call-ui';
import { ACCOUNT_ROLES } from '@/lib/auth/roles';

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

describe('clip', () => {
  it('collapses whitespace and clips by code point, with an ellipsis', () => {
    expect(clip('  a \n b  ', 10)).toBe('a b');
    expect(clip('ab😀cd', 4)).toBe('ab😀…');
    expect(clip(null, 4)).toBe('');
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

  it('keeps a deal-room participant the route will not call blocked', () => {
    expect(dialResult(409, { code: 'bank_guests_off', error: 'x' })).toEqual({
      kind: 'blocked',
      code: 'bank_guests_off',
    });
    expect(dialResult(422, { code: 'no_number' })).toEqual({
      kind: 'blocked',
      code: 'no_number',
    });
    expect(dialResult(409, { code: 'bank_calls_recorded' })).toEqual({
      kind: 'blocked',
      code: 'bank_calls_recorded',
    });
    expect(dialResult(403, { code: 'forbidden', error: 'No' })).toEqual({
      kind: 'error',
      message: 'No',
    });
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

describe('loadsPbxMe', () => {
  it('asks for every staff role once the session and workspace are known', () => {
    for (const role of ACCOUNT_ROLES.filter((r) => r !== 'bank_guest')) {
      expect(loadsPbxMe(ME, 'acc', role)).toBe(true);
    }
  });

  it('never asks for a bank guest, whom the route answers 403', () => {
    expect(loadsPbxMe(ME, 'acc', 'bank_guest')).toBe(false);
  });

  it('waits for the session and the workspace', () => {
    expect(loadsPbxMe(null, 'acc', 'agent')).toBe(false);
    expect(loadsPbxMe(ME, null, 'agent')).toBe(false);
    expect(loadsPbxMe(undefined, undefined, null)).toBe(false);
  });
});

describe('callBackFor', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const known = {
    contactId: C,
    remoteNumber: '971501234567',
    doNotContactAt: null,
    doNotContactReason: null,
  };
  const unknown = { ...known, contactId: null };

  it('calls a known caller back through their contact, agent and up', () => {
    for (const role of ['agent', 'team_leader', 'admin', 'owner'] as const)
      expect(callBackFor(known, role)).toEqual({
        kind: 'contact',
        contact: {
          id: C,
          do_not_contact_at: null,
          do_not_contact_reason: null,
        },
      });
  });

  it('carries the do-not-contact stamp, so the button is disabled with the reason', () => {
    const back = callBackFor(
      {
        ...known,
        doNotContactAt: '2026-10-01T09:00:00Z',
        doNotContactReason: 'Asked on the phone',
      },
      'agent'
    );
    expect(back?.kind).toBe('contact');
    const consent = consentState(back?.kind === 'contact' ? back.contact : {});
    expect(consent).toMatchObject({
      callsOk: false,
      dncReason: 'Asked on the phone',
    });
  });

  it('dials an unknown caller by number from agent up, as the route allows', () => {
    for (const role of ['agent', 'team_leader', 'admin', 'owner'] as const)
      expect(callBackFor(unknown, role)).toEqual({
        kind: 'number',
        number: '971501234567',
      });
    expect(callBackFor({ ...unknown, remoteNumber: '  ' }, 'owner')).toBeNull();
    expect(callBackFor({ ...unknown, remoteNumber: null }, 'owner')).toBeNull();
  });

  it('offers nothing below agent, or before the role is known', () => {
    for (const role of ['viewer', 'bank_guest', null, undefined] as const) {
      expect(callBackFor(known, role)).toBeNull();
      expect(callBackFor(unknown, role)).toBeNull();
    }
  });
});

describe('the Calls screen tabs', () => {
  it('offers By person to leaders and up, Unrouted to owners and admins', () => {
    const tabs = Object.fromEntries(
      ACCOUNT_ROLES.map((r) => [r, visibleCallTabs(r).join(',')])
    );
    expect(tabs).toEqual({
      owner: 'missed,log,people,unrouted',
      admin: 'missed,log,people,unrouted',
      team_leader: 'missed,log,people',
      agent: 'missed,log',
      viewer: 'missed,log',
      bank_guest: 'missed,log',
    });
    expect(visibleCallTabs(null)).toEqual(['missed', 'log']);
  });

  it('reads ?tab=, anything else being Missed calls', () => {
    expect(callsTab('unrouted')).toBe('unrouted');
    expect(callsTab('people')).toBe('people');
    expect(callsTab(undefined)).toBe('missed');
    expect(callsTab('team')).toBe('missed');
  });

  it('loads the Unrouted list only once the role is known', () => {
    expect(callsListReady('unrouted', null)).toBe(false);
    expect(callsListReady('unrouted', 'admin')).toBe(true);
    expect(callsListReady('missed', null)).toBe(true);
    expect(callsListReady('log', null)).toBe(true);
    expect(callsListReady('people', 'owner')).toBe(false);
  });

  it('shows Missed calls when a link names a tab the role is not offered', () => {
    expect(shownCallsTab('unrouted', 'team_leader')).toBe('missed');
    expect(shownCallsTab('unrouted', 'agent')).toBe('missed');
    expect(shownCallsTab('unrouted', 'viewer')).toBe('missed');
    expect(shownCallsTab('people', 'agent')).toBe('missed');
    expect(shownCallsTab('people', 'viewer')).toBe('missed');
    // The tabs a role is offered stand.
    expect(shownCallsTab('unrouted', 'admin')).toBe('unrouted');
    expect(shownCallsTab('unrouted', 'owner')).toBe('unrouted');
    expect(shownCallsTab('people', 'team_leader')).toBe('people');
    expect(shownCallsTab('log', 'viewer')).toBe('log');
    expect(shownCallsTab('missed', 'agent')).toBe('missed');
    // Before the role is known the request stands (the API decides).
    expect(shownCallsTab('unrouted', null)).toBe('unrouted');
  });
});

describe('dialling from the app', () => {
  it('sends one target, and an admin reason only when there is one', () => {
    expect(dialBody({ number: '201' })).toEqual({ number: '201' });
    expect(dialBody({ contactId: 'c1' }, '  asked to ')).toEqual({
      contactId: 'c1',
      overrideReason: 'asked to',
    });
    expect(dialBody({ conversationId: 'v1' }, '   ')).toEqual({
      conversationId: 'v1',
    });
  });

  it('cleans a pasted number: spaces, dashes and brackets out, Arabic digits in', () => {
    expect(cleanDialInput('+971 (50) 123-4567')).toBe('+971501234567');
    expect(cleanDialInput('٠٥٠١٢٣٤٥٦٧')).toBe('0501234567');
    expect(cleanDialInput('۲۰۱')).toBe('201');
    expect(cleanDialInput('*72#')).toBe('*72#');
    expect(cleanDialInput('97+1+5')).toBe('9715');
    expect(cleanDialInput('ext. 201')).toBe('201');
  });

  it('dials only something with a digit, and knows an extension', () => {
    expect(canDialInput('')).toBe(false);
    expect(canDialInput('+')).toBe(false);
    expect(canDialInput('*72')).toBe(true);
    expect(isExtensionNumber('201')).toBe(true);
    expect(isExtensionNumber('123456')).toBe(true);
    expect(isExtensionNumber('1234567')).toBe(false);
    expect(isExtensionNumber('+201')).toBe(false);
  });

  it('keeps the recent numbers newest first, without repeats, capped', () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = pushRecentDial(list, String(100 + i));
    expect(list).toHaveLength(RECENT_DIALS_MAX);
    expect(list[0]).toBe('111');
    expect(pushRecentDial(['1', '2', '3'], '2')).toEqual(['2', '1', '3']);
  });

  it('reads a stored list defensively', () => {
    expect(readRecentDials(null)).toEqual([]);
    expect(readRecentDials('not json')).toEqual([]);
    expect(readRecentDials('{"a":1}')).toEqual([]);
    expect(readRecentDials('["201", 5, "+971 50", "201", "x"]')).toEqual([
      '201',
      '+97150',
    ]);
  });
});
