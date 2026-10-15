import { describe, expect, it } from 'vitest';

import { presenceNotices, selfRowEffects } from './notices';
import {
  hiddenVideo,
  planLayerUpdates,
  ridForTileSize,
  simulcastFor,
  type PulledVideo,
} from './simulcast';
import {
  INITIAL_SPEAKER_STATE,
  levelPatch,
  loudest,
  quantizeLevel,
  rmsLevel,
  SPEAKER_HOLD_MS,
  SPEAKING_HANG_MS,
  stepSpeaker,
  type SpeakerState,
} from './speaker';
import { parseParticipantRow } from './tracks';
import type { ParticipantRow } from './types';

function run(samples: [number, Record<string, number>][]) {
  let state: SpeakerState = INITIAL_SPEAKER_STATE;
  const out: (string | null)[] = [];
  for (const [t, levels] of samples) {
    const step = stepSpeaker(state, levels, t);
    state = step.state;
    out.push(step.activeSpeakerId);
  }
  return { out, state };
}

describe('active speaker', () => {
  it('takes the first voice at once', () => {
    expect(run([[0, { a: 0.3, b: 0 }]]).out).toEqual(['a']);
  });

  it('switches only after the other voice has been loudest for the hold', () => {
    const { out } = run([
      [0, { a: 0.3, b: 0 }],
      [200, { a: 0.1, b: 0.4 }],
      [200 + SPEAKER_HOLD_MS - 1, { a: 0.1, b: 0.4 }],
      [200 + SPEAKER_HOLD_MS, { a: 0.1, b: 0.4 }],
    ]);
    expect(out).toEqual(['a', 'a', 'a', 'b']);
  });

  it('a short interjection does not switch, and restarts the hold', () => {
    const { out } = run([
      [0, { a: 0.3, b: 0 }],
      [200, { a: 0.1, b: 0.4 }],
      [800, { a: 0.3, b: 0.1 }],
      [1000, { a: 0.1, b: 0.4 }],
      [1800, { a: 0.1, b: 0.4 }],
      [2000, { a: 0.1, b: 0.4 }],
    ]);
    expect(out).toEqual(['a', 'a', 'a', 'a', 'a', 'b']);
  });

  it('keeps the speaker through silence, drops one who left', () => {
    const { out } = run([
      [0, { a: 0.3, b: 0 }],
      [5000, { a: 0, b: 0 }],
      [5200, { b: 0 }],
    ]);
    expect(out).toEqual(['a', 'a', null]);
  });

  it('ignores levels below the floor', () => {
    expect(loudest({ a: 0.04, b: 0.01 })).toBeNull();
    expect(loudest({ a: 0.2, b: 0.2 })).toBe('a');
  });

  it('speaking hangs on briefly between words', () => {
    let s = stepSpeaker(INITIAL_SPEAKER_STATE, { a: 0.3 }, 0);
    s = stepSpeaker(s.state, { a: 0 }, SPEAKING_HANG_MS - 1);
    expect(s.speaking).toEqual({ a: true });
    s = stepSpeaker(s.state, { a: 0 }, SPEAKING_HANG_MS);
    expect(s.speaking).toEqual({ a: false });
  });
});

describe('levels', () => {
  it('rms and quantize', () => {
    expect(rmsLevel([])).toBe(0);
    expect(rmsLevel([0.5, -0.5])).toBeCloseTo(0.5);
    expect(quantizeLevel(0.123)).toBe(0.1);
    expect(quantizeLevel(-1)).toBe(0);
    expect(quantizeLevel(NaN)).toBe(0);
    expect(quantizeLevel(3)).toBe(1);
  });

  it('levelPatch is null when nothing visible changed', () => {
    const view = {
      activeSpeakerId: 'a',
      speaking: { a: true },
      localAudioLevel: 0.1,
    };
    expect(
      levelPatch(view, {
        ...view,
        speaking: { a: true },
        localAudioLevel: 0.11,
      })
    ).toBeNull();
    expect(levelPatch(view, { ...view, localAudioLevel: 0.2 })).toEqual({
      localAudioLevel: 0.2,
    });
    expect(levelPatch(view, { ...view, speaking: { a: false } })).toEqual({
      speaking: { a: false },
    });
    expect(levelPatch(view, { ...view, activeSpeakerId: 'b' })).toEqual({
      activeSpeakerId: 'b',
    });
  });
});

describe('simulcast', () => {
  it('maps tile sizes to layers', () => {
    expect(ridForTileSize('large')).toBe('f');
    expect(ridForTileSize('medium')).toBe('h');
    expect(ridForTileSize('small')).toBe('q');
    expect(ridForTileSize('hidden')).toBeNull();
    expect(simulcastFor('small')).toEqual({
      preferredRid: 'q',
      priorityOrdering: 'asciibetical',
      ridNotAvailable: 'asciibetical',
    });
    expect(hiddenVideo({ a: 'hidden', b: 'small' })).toEqual(new Set(['a']));
  });

  it('updates only cameras whose layer changes', () => {
    const v = (
      participantId: string,
      rid: PulledVideo['rid']
    ): PulledVideo => ({
      trackName: `${participantId}:video`,
      participantId,
      sessionId: `s-${participantId}`,
      mid: `m-${participantId}`,
      rid,
    });
    const updates = planLayerUpdates({ a: 'large', b: 'small', c: 'hidden' }, [
      v('a', 'h'),
      v('b', 'q'),
      v('c', 'h'),
      v('d', null),
    ]);
    expect(updates.map((u) => [u.trackName, u.simulcast.preferredRid])).toEqual(
      [
        ['a:video', 'f'],
        ['d:video', 'h'],
      ]
    );
    expect(updates[0]).toMatchObject({
      location: 'remote',
      mid: 'm-a',
      sessionId: 's-a',
    });
  });
});

const NOW = Date.parse('2026-10-15T10:00:00Z');
function prow(id: string, userId: string): ParticipantRow {
  return parseParticipantRow({
    id,
    meeting_id: 'm1',
    user_id: userId,
    cf_session_id: `s-${id}`,
    joined_at: new Date(NOW).toISOString(),
    last_seen_at: new Date(NOW).toISOString(),
    tracks: [],
  })!;
}

describe('participant row v2 columns', () => {
  it('parses missing as null and keeps strings', () => {
    const r = prow('p1', 'u1');
    expect(r).toMatchObject({
      hand_raised_at: null,
      mute_requested_at: null,
      removed_at: null,
      removed_by: null,
    });
    const raw = { ...r, hand_raised_at: '2026-10-15T10:00:00Z', removed_by: 7 };
    expect(parseParticipantRow(raw)).toMatchObject({
      hand_raised_at: '2026-10-15T10:00:00Z',
      removed_by: null,
    });
  });
});

describe('presence notices', () => {
  const self = { userId: 'me', participantId: 'p-me' };
  it('the initial load records who is there without notices', () => {
    const r = presenceNotices(
      null,
      [prow('p-me', 'me'), prow('p1', 'u1')],
      self
    );
    expect(r.notices).toEqual([]);
    expect(r.users).toEqual(new Set(['u1']));
  });

  it('joins and leaves by person, never about ourselves', () => {
    const r = presenceNotices(
      new Set(['u1', 'u2']),
      [prow('p-me2', 'me'), prow('p1b', 'u1'), prow('p3', 'u3')],
      self
    );
    expect(r.notices).toEqual([
      { kind: 'joined', userId: 'u3' },
      { kind: 'left', userId: 'u2' },
    ]);
  });
});

describe('self row effects', () => {
  const base = {
    mute_requested_at: null,
    hand_raised_at: null,
    removed_at: null,
  };
  it('mutes on a newer request only', () => {
    const a = selfRowEffects(
      null,
      { ...base, mute_requested_at: '2026-10-15T10:00:00Z' },
      false
    );
    expect(a.mute).toBe(true);
    const again = selfRowEffects(
      a.memo,
      { ...base, mute_requested_at: '2026-10-15T10:00:00Z' },
      false
    );
    expect(again.mute).toBe(false);
    const older = selfRowEffects(
      a.memo,
      { ...base, mute_requested_at: '2026-10-15T09:59:00Z' },
      false
    );
    expect(older.mute).toBe(false);
    expect(
      selfRowEffects(
        a.memo,
        { ...base, mute_requested_at: '2026-10-15T10:01:00Z' },
        false
      ).mute
    ).toBe(true);
  });

  it('hand lowered by the host, not by ourselves', () => {
    const up = selfRowEffects(
      null,
      { ...base, hand_raised_at: '2026-10-15T10:00:00Z' },
      true
    );
    expect(selfRowEffects(up.memo, base, true).handLoweredByHost).toBe(true);
    expect(selfRowEffects(up.memo, base, false).handLoweredByHost).toBe(false);
    expect(selfRowEffects(null, base, true).handLoweredByHost).toBe(false);
  });

  it('removed', () => {
    expect(
      selfRowEffects(
        null,
        { ...base, removed_at: '2026-10-15T10:00:00Z' },
        false
      ).removed
    ).toBe(true);
  });
});
