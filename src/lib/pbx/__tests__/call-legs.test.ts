import { describe, expect, it } from 'vitest';

import {
  MAX_CDR_LEGS,
  legOf,
  internalPeerExtension,
  legsOf,
  mergeCallLegs,
  withLeg,
  type CallLeg,
} from '../call-legs';
import type { CallEndEvent } from '../yeastar/events';

const T0 = Date.parse('2026-10-27T10:47:26.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const leg = (
  uid: string,
  status: string,
  o: Partial<CallLeg> & { start?: number | null } = {}
): CallLeg => {
  const { start = 0, ...rest } = o;
  return {
    uid,
    status,
    started_at: start === null ? null : at(start),
    call_seconds: 0,
    talk_seconds: 0,
    extension: null,
    peer: null,
    direction: 'inbound',
    ...rest,
  };
};

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])
  );
}

/** Every arrival order, folded in one leg at a time as onCallEnd does. */
function everyOrder(legs: CallLeg[], opts = {}) {
  return permutations(legs).map((order) => {
    let kept: CallLeg[] = [];
    for (const l of order) kept = withLeg(kept, l).legs;
    return { legs: kept, merged: mergeCallLegs(kept, opts) };
  });
}

const EXTS = new Map<string, { user_id: string | null }>([
  ['2122', { user_id: 'u-sara' }],
  ['2100', { user_id: 'u-faisal' }],
  ['4000', { user_id: null }],
  ['1001', { user_id: 'u1' }],
  ['1002', { user_id: 'u2' }],
]);

describe('withLeg with the uid Yeastar shares across legs (live)', () => {
  it('keeps the transfer legs that differ only by the other side', () => {
    // 2026-10-27, call 1793098226.17733: four legs, one uid.
    const common = {
      call_seconds: 145,
      talk_seconds: 145,
      direction: 'internal' as const,
    };
    const legs = [
      leg('u', 'ANSWERED', { ...common, peer: '2122' }),
      leg('u', 'ANSWERED', { ...common, extension: '4000', peer: '2100' }),
      leg('u', 'ANSWERED', {
        start: -17,
        call_seconds: 17,
        talk_seconds: 7,
        extension: '4000',
        peer: '2100',
        direction: 'internal',
      }),
      leg('u', 'ANSWERED', { ...common, extension: '4000', peer: '4000' }),
    ];
    for (const { legs: kept, merged } of everyOrder(legs, {
      extensions: EXTS,
    })) {
      expect(kept).toHaveLength(4);
      expect(merged.talkSeconds).toBe(145);
    }
  });

  it('a voicemail after a NO ANSWER under one uid is still voicemail', () => {
    const legs = [
      leg('u', 'NO ANSWER', { call_seconds: 24, extension: '2000' }),
      leg('u', 'VOICEMAIL', {
        start: 24,
        call_seconds: 27,
        talk_seconds: 27,
        extension: '2000',
      }),
    ];
    for (const { legs: kept, merged } of everyOrder(legs)) {
      expect(kept).toHaveLength(2);
      expect(merged).toMatchObject({ status: 'voicemail', startedAt: at(0) });
    }
  });

  it('an identical record is a redelivery', () => {
    const a = leg('u', 'ANSWERED', { talk_seconds: 9, extension: '1002' });
    const once = withLeg([], a).legs;
    expect(withLeg(once, { ...a })).toEqual({ legs: once, added: false });
  });
});

describe('mergeCallLegs', () => {
  it('a trailing FAILED never hides a NO ANSWER (live, 2026-10-27)', () => {
    const legs = [
      leg('a', 'NO ANSWER', { call_seconds: 55, direction: 'outbound' }),
      leg('b', 'FAILED', { call_seconds: 0, direction: 'outbound' }),
    ];
    for (const { merged } of everyOrder(legs)) {
      expect(merged).toMatchObject({
        status: 'no_answer',
        pbxStatus: 'NO ANSWER',
        answered: false,
        direction: 'outbound',
        uid: 'a',
        talkSeconds: 0,
        ringSeconds: 55,
        startedAt: at(0),
        endedAt: at(55),
        answeredAt: null,
      });
    }
  });

  it('a voicemail after a NO ANSWER starts at the first ring (live)', () => {
    const legs = [
      leg('a', 'NO ANSWER', { call_seconds: 24, extension: '2000' }),
      leg('b', 'VOICEMAIL', {
        start: 24,
        call_seconds: 27,
        talk_seconds: 27,
        extension: '2000',
      }),
    ];
    for (const { merged } of everyOrder(legs, { extensions: EXTS })) {
      expect(merged).toMatchObject({
        status: 'voicemail',
        pbxStatus: 'VOICEMAIL',
        talkSeconds: 27,
        ringSeconds: 24,
        startedAt: at(0),
        endedAt: at(51),
        extension: '2000',
        userId: null,
      });
    }
  });

  it('a transfer: the longest talk, never the sum; the first answerer (live)', () => {
    const legs = [
      leg('a', 'ANSWERED', {
        call_seconds: 145,
        talk_seconds: 145,
        extension: '2122',
      }),
      leg('b', 'ANSWERED', {
        call_seconds: 145,
        talk_seconds: 145,
        extension: '4000',
        direction: 'internal',
      }),
      leg('c', 'ANSWERED', {
        start: 30,
        call_seconds: 17,
        talk_seconds: 7,
        extension: '4000',
        direction: 'internal',
      }),
      leg('d', 'ANSWERED', {
        call_seconds: 145,
        talk_seconds: 145,
        extension: '4000',
        direction: 'internal',
      }),
    ];
    const results = everyOrder(legs, { extensions: EXTS });
    expect(results).toHaveLength(24);
    for (const { merged } of results) {
      expect(merged).toMatchObject({
        status: 'answered',
        answered: true,
        direction: 'inbound',
        talkSeconds: 145,
        ringSeconds: 0,
        startedAt: at(0),
        endedAt: at(145),
        answeredAt: at(0),
        // 4000 is a known extension but no one's: a person's wins.
        extension: '2122',
        userId: 'u-sara',
      });
    }
  });

  it('a ring group: a late NO ANSWER leg does not undo the answer', () => {
    const legs = [
      leg('a', 'ANSWERED', {
        call_seconds: 30,
        talk_seconds: 20,
        extension: '1002',
      }),
      leg('b', 'NO ANSWER', { call_seconds: 12, extension: '1001' }),
    ];
    for (const { merged } of everyOrder(legs, { extensions: EXTS })) {
      expect(merged).toMatchObject({
        status: 'answered',
        pbxStatus: 'ANSWERED',
        uid: 'a',
        talkSeconds: 20,
        ringSeconds: 10,
        answeredAt: at(10),
        extension: '1002',
        userId: 'u2',
      });
    }
  });

  it('answered: ring runs from the first leg to the first answer', () => {
    const merged = mergeCallLegs(
      [
        leg('a', 'NO ANSWER', { call_seconds: 15, extension: '1001' }),
        leg('b', 'ANSWERED', {
          start: 15,
          call_seconds: 40,
          talk_seconds: 30,
          extension: '1002',
        }),
      ],
      { extensions: EXTS }
    );
    expect(merged).toMatchObject({
      ringSeconds: 25,
      answeredAt: at(25),
      endedAt: at(55),
      extension: '1002',
    });
  });

  it('ranks voicemail > busy > no answer > abandoned > failed > unknown', () => {
    const order = ['VOICEMAIL', 'BUSY', 'NO ANSWER', 'ABANDONED', 'FAILED'];
    for (let i = 0; i < order.length; i++) {
      const legs = [...order.slice(i), 'ODD'].map((s, n) =>
        leg(`u${n}`, s, { call_seconds: 5 })
      );
      for (const { merged } of everyOrder(legs.slice(0, 3))) {
        expect(merged.pbxStatus).toBe(order[i]);
      }
    }
    // Unknown on its own maps as before: failed, with its own word.
    expect(mergeCallLegs([leg('x', 'ODD')])).toMatchObject({
      status: 'failed',
      pbxStatus: 'ODD',
    });
  });

  it('keeps the old fallbacks when no leg has a time', () => {
    const merged = mergeCallLegs([
      leg('a', 'ANSWERED', {
        start: null,
        call_seconds: 30,
        talk_seconds: 20,
      }),
    ]);
    expect(merged).toMatchObject({
      startedAt: null,
      endedAt: null,
      answeredAt: null,
      ringSeconds: 10,
      talkSeconds: 20,
    });
    expect(
      mergeCallLegs([leg('a', 'NO ANSWER', { start: null, call_seconds: 9 })])
        .ringSeconds
    ).toBe(9);
  });

  it('extension: as before when no answered leg names a known one', () => {
    // A ring group's number: the row's own extension (a 30011 answerer).
    expect(
      mergeCallLegs(
        [leg('a', 'ANSWERED', { call_seconds: 9, extension: '6300' })],
        { extensions: EXTS, existingExtension: '1002' }
      )
    ).toMatchObject({ extension: '1002', userId: 'u2' });
    // ...unless that is just another leg's number an earlier merge wrote.
    const legs = [
      leg('a', 'NO ANSWER', { call_seconds: 9, extension: '6300' }),
      leg('b', 'VOICEMAIL', { start: 9, call_seconds: 9, extension: '7000' }),
    ];
    for (const before of ['6300', '7000', null]) {
      expect(
        mergeCallLegs(legs, { extensions: EXTS, existingExtension: before })
          .extension
      ).toBe('7000');
    }
    // Direction from the legs: inbound/outbound beat internal.
    expect(
      mergeCallLegs([
        leg('a', 'ANSWERED', { direction: 'internal' }),
        leg('b', 'ANSWERED', { direction: null }),
      ]).direction
    ).toBe('internal');
    expect(
      mergeCallLegs([leg('a', 'BUSY', { direction: null })]).direction
    ).toBe(null);
  });
});

describe('withLeg / legsOf', () => {
  it('a redelivered leg changes nothing', () => {
    const a = leg('a', 'NO ANSWER');
    const one = withLeg([], a);
    expect(one).toEqual({ legs: [a], added: true });
    const again = withLeg(one.legs, { ...a });
    expect(again.added).toBe(false);
    expect(again.legs).toEqual([a]);
    // The same uid with another status is another leg: Yeastar shares
    // one uid across a call's legs.
    expect(withLeg(one.legs, { ...a, status: 'ANSWERED' }).added).toBe(true);
  });

  it('keeps the earliest legs past the cap, whatever arrived first', () => {
    const all = Array.from({ length: MAX_CDR_LEGS + 3 }, (_, i) =>
      leg(`u${String(i).padStart(2, '0')}`, 'NO ANSWER', { start: i })
    );
    let forward: CallLeg[] = [];
    for (const l of all) forward = withLeg(forward, l).legs;
    let backward: CallLeg[] = [];
    for (const l of [...all].reverse()) backward = withLeg(backward, l).legs;
    expect(forward).toHaveLength(MAX_CDR_LEGS);
    expect(backward).toEqual(forward);
    expect(withLeg(forward, all[all.length - 1]).added).toBe(false);
  });

  it('reads stored legs and drops malformed ones', () => {
    const a = leg('a', 'BUSY', { recording: 'r.wav' });
    expect(
      legsOf({
        rang_user_ids: ['u1'],
        cdr_legs: [
          a,
          null,
          { status: 'X' },
          { ...a, uid: 'b', direction: 'x' },
        ],
      })
    ).toEqual([a, { ...a, uid: 'b', direction: null }]);
    expect(legsOf(null)).toEqual([]);
    expect(legsOf({ cdr_legs: 'no' })).toEqual([]);
  });

  it('legOf: our side of the leg, by its own type else the fallback', () => {
    const ev = {
      kind: 'call_end',
      type: 30012,
      callId: 'c',
      uid: 'u',
      direction: null,
      from: '0501234567',
      to: '1001',
      startedAt: at(0),
      startedAtRaw: null,
      callSeconds: 10,
      talkSeconds: 4,
      status: 'ANSWERED',
      recordingFile: 'r.wav',
      raw: {},
    } satisfies CallEndEvent;
    expect(legOf(ev, 'inbound')).toEqual({
      uid: 'u',
      status: 'ANSWERED',
      started_at: at(0),
      call_seconds: 10,
      talk_seconds: 4,
      extension: '1001',
      peer: '0501234567',
      direction: null,
      recording: 'r.wav',
    });
    expect(legOf({ ...ev, direction: 'outbound' }, 'inbound').extension).toBe(
      '0501234567'
    );
  });
});

describe('internalPeerExtension', () => {
  it("is the leg's other side that is not ours", () => {
    const meta = {
      cdr_legs: [leg('u', 'ANSWERED', { extension: '5005', peer: '2122' })],
    };
    expect(internalPeerExtension(meta, '5005')).toBe('2122');
    // Seen from the other end, our side is the peer's own.
    expect(internalPeerExtension(meta, '2122')).toBe('5005');
  });

  it('is null with no legs (calls stored before legs were kept)', () => {
    expect(internalPeerExtension({}, '5005')).toBeNull();
    expect(internalPeerExtension(null, '5005')).toBeNull();
  });
});
