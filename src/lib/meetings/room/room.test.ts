import { describe, expect, it } from 'vitest';

import {
  afterFailedPublish,
  classifyMediaError,
  isShareCancelled,
  tracksToRelease,
} from './devices';
import { gridColumns, tileLayout, type TileSource } from './layout';
import { clockSkewMs, isPresent, presentParticipants } from './presence';
import { createSerialQueue } from './queue';
import {
  admitPullRejoin,
  afterPullStrike,
  needsPullRollback,
  PULL_REJOIN_LIMIT,
  PULL_REJOIN_WINDOW_MS,
  PULL_STRIKES_BEFORE_REJOIN,
} from './recovery';
import { classifyRoomFailure, parseJoinResult, parseTracksResult } from './sfu';
import { planSubscriptions } from './subscriptions';
import {
  parseParticipantRow,
  parseTrackName,
  parseTracks,
  trackNameFor,
} from './tracks';
import type { ParticipantRow, TrackKind } from './types';

const NOW = Date.parse('2026-10-15T10:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function row(
  id: string,
  kinds: TrackKind[] = ['audio', 'video'],
  over: Partial<ParticipantRow> = {}
): ParticipantRow {
  return {
    id,
    meeting_id: 'm1',
    user_id: `u-${id}`,
    cf_session_id: `s-${id}`,
    joined_at: ago(100_000),
    last_seen_at: ago(5_000),
    left_at: null,
    tracks: kinds.map((kind) => ({ trackName: `${id}:${kind}`, kind })),
    audio_muted: false,
    video_off: false,
    hand_raised_at: null,
    mute_requested_at: null,
    removed_at: null,
    removed_by: null,
    ...over,
  };
}

describe('track names', () => {
  it('round-trips, generation 0 being the plain name', () => {
    expect(trackNameFor('p1', 'audio')).toBe('p1:audio');
    expect(trackNameFor('p1', 'screen', 2)).toBe('p1:screen:2');
    expect(parseTrackName('p1:audio')).toEqual({
      participantId: 'p1',
      kind: 'audio',
      generation: 0,
    });
    expect(parseTrackName('p1:screen:2')?.generation).toBe(2);
  });

  it('rejects names it did not produce', () => {
    for (const bad of [
      'p1',
      'p1:mic',
      ':audio',
      'p1:video:0',
      'p1:video:x',
      'a:b:c:d',
    ]) {
      expect(parseTrackName(bad)).toBeNull();
    }
  });

  it("keeps only a row's own, well-formed tracks", () => {
    expect(
      parseTracks(
        [
          { trackName: 'p1:audio', kind: 'audio' },
          { trackName: 'p2:video', kind: 'video' }, // someone else's name
          { trackName: 'p1:video', kind: 'audio' }, // kind disagrees
          { trackName: 'p1:audio', kind: 'audio' }, // duplicate
          { trackName: 'p1:screen:1', kind: 'screen' },
          null,
          'p1:video',
        ],
        'p1'
      )
    ).toEqual([
      { trackName: 'p1:audio', kind: 'audio' },
      { trackName: 'p1:screen:1', kind: 'screen' },
    ]);
    expect(parseTracks(null, 'p1')).toEqual([]);
  });

  it('parses a participant row and refuses one missing an id', () => {
    const r = row('p1');
    expect(parseParticipantRow({ ...r, extra: 1 })).toEqual(r);
    expect(parseParticipantRow({ ...r, cf_session_id: undefined })).toBeNull();
    expect(parseParticipantRow('nope')).toBeNull();
  });
});

describe('presence', () => {
  it('is open and heard from within 60 s', () => {
    expect(isPresent(row('a'), NOW)).toBe(true);
    expect(isPresent(row('a', [], { last_seen_at: ago(59_000) }), NOW)).toBe(
      true
    );
    expect(isPresent(row('a', [], { last_seen_at: ago(60_000) }), NOW)).toBe(
      false
    );
    expect(isPresent(row('a', [], { left_at: ago(1_000) }), NOW)).toBe(false);
    expect(isPresent(row('a', [], { last_seen_at: 'garbage' }), NOW)).toBe(
      false
    );
  });

  it('lists present rows oldest joiner first', () => {
    const rows = [
      row('late', [], { joined_at: ago(10_000) }),
      row('gone', [], { left_at: ago(1) }),
      row('early', [], { joined_at: ago(90_000) }),
      row('stale', [], { last_seen_at: ago(120_000) }),
    ];
    expect(presentParticipants(rows, NOW).map((r) => r.id)).toEqual([
      'early',
      'late',
    ]);
  });

  it('estimates the server clock offset', () => {
    expect(clockSkewMs(new Date(NOW + 90_000).toISOString(), NOW)).toBe(90_000);
    expect(clockSkewMs('bad', NOW)).toBe(0);
  });
});

describe('planSubscriptions', () => {
  it("pulls every other participant's tracks and never our own", () => {
    const plan = planSubscriptions(
      [row('me'), row('a'), row('b', ['audio'])],
      'me',
      new Set()
    );
    expect(plan.pull.map((p) => p.trackName)).toEqual([
      'a:audio',
      'a:video',
      'b:audio',
    ]);
    expect(plan.pull[0]).toEqual({
      participantId: 'a',
      sessionId: 's-a',
      trackName: 'a:audio',
      kind: 'audio',
    });
    expect(plan.close).toEqual([]);
  });

  it('skips what is already pulled or in flight, closes what went away', () => {
    const plan = planSubscriptions(
      [row('me'), row('a', ['audio', 'screen'])],
      'me',
      new Set(['a:audio', 'a:video', 'gone:audio'])
    );
    expect(plan.pull.map((p) => p.trackName)).toEqual(['a:screen']);
    expect(plan.close.sort()).toEqual(['a:video', 'gone:audio']);
  });

  it('is a no-op once in step', () => {
    const pulled = new Set(['a:audio', 'a:video']);
    expect(planSubscriptions([row('me'), row('a')], 'me', pulled)).toEqual({
      pull: [],
      close: [],
    });
  });
});

describe('tileLayout', () => {
  const src = (id: string, isSelf = false, sharing = false): TileSource => ({
    participantId: id,
    userId: `u-${id}`,
    isSelf,
    sharing,
  });

  it('puts yourself first, one camera tile each', () => {
    const l = tileLayout([src('a'), src('me', true), src('b')]);
    expect(l.featured).toBeNull();
    expect(l.grid.map((t) => t.key)).toEqual([
      'me:camera',
      'a:camera',
      'b:camera',
    ]);
    expect(l.columns).toBe(2);
  });

  it("features someone else's share ahead of your own", () => {
    const l = tileLayout([
      src('me', true, true),
      src('a', false, true),
      src('b'),
    ]);
    expect(l.featured?.key).toBe('a:screen');
    expect(l.grid.map((t) => t.key)).toEqual([
      'me:camera',
      'me:screen',
      'a:camera',
      'b:camera',
    ]);
  });

  it('features your own share when it is the only one', () => {
    expect(tileLayout([src('me', true, true), src('a')]).featured?.key).toBe(
      'me:screen'
    );
  });

  it('keeps the grid roughly square', () => {
    expect([1, 2, 4, 5, 9, 10, 17].map(gridColumns)).toEqual([
      1, 2, 2, 3, 3, 4, 5,
    ]);
  });
});

describe('createSerialQueue', () => {
  it('runs one task at a time, in order, and survives a failure', async () => {
    const q = createSerialQueue();
    const log: string[] = [];
    let running = 0;
    const task =
      (name: string, fail = false) =>
      async () => {
        running += 1;
        expect(running).toBe(1);
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`end ${name}`);
        running -= 1;
        if (fail) throw new Error(name);
        return name;
      };
    const a = q.run(task('a'));
    const b = q.run(task('b', true));
    const c = q.run(task('c'));
    expect(q.size).toBe(3);
    await expect(a).resolves.toBe('a');
    await expect(b).rejects.toThrow('b');
    await expect(c).resolves.toBe('c');
    expect(log).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c',
    ]);
    expect(q.size).toBe(0);
  });
});

describe('devices', () => {
  it('classifies getUserMedia failures', () => {
    const e = (name: string) => ({ name });
    expect(classifyMediaError(e('NotAllowedError'))).toBe('permission_denied');
    expect(classifyMediaError(e('NotFoundError'))).toBe('not_found');
    expect(classifyMediaError(e('OverconstrainedError'))).toBe('not_found');
    expect(classifyMediaError(e('NotReadableError'))).toBe('in_use');
    expect(classifyMediaError(new TypeError('x'))).toBe('unsupported');
    expect(classifyMediaError('weird')).toBe('unknown');
    expect(isShareCancelled(e('NotAllowedError'))).toBe(true);
    expect(isShareCancelled(e('NotReadableError'))).toBe(false);
  });

  it('releases what a stale preview opened, never what the engine holds', () => {
    const mic = { id: 'mic' };
    const cam = { id: 'cam' };
    // The mic resolved, the page was left, the camera came back null.
    expect(tracksToRelease([mic, null], [null, null])).toEqual([mic]);
    expect(tracksToRelease([mic, cam], [null, null])).toEqual([mic, cam]);
    // A track reused from before the preview is still the engine's.
    expect(tracksToRelease([mic, cam], [mic, null])).toEqual([cam]);
    expect(tracksToRelease([null, null], [null, null])).toEqual([]);
  });

  it('releases what a failed publish was for, so the toggle retries', () => {
    const [mic, cam, scr] = ['mic', 'cam', 'scr'];
    const held = { audio: mic, video: cam, screen: scr };
    const failed = [
      { track: mic, kind: 'audio' as const },
      { track: cam, kind: 'video' as const },
      { track: scr, kind: 'screen' as const },
    ];
    expect(afterFailedPublish(failed, held, new Set())).toEqual([
      { kind: 'audio', error: 'unknown' },
      { kind: 'video', error: 'unknown' },
      { kind: 'screen', error: null },
    ]);
  });

  it('keeps a track replaced meanwhile or a kind already published', () => {
    const failed = [
      { track: 'mic', kind: 'audio' as const },
      { track: 'cam', kind: 'video' as const },
    ];
    // The camera was turned off (or reopened) while the publish ran.
    expect(
      afterFailedPublish(
        failed,
        { audio: 'mic', video: 'cam2', screen: null },
        new Set()
      )
    ).toEqual([{ kind: 'audio', error: 'unknown' }]);
    // A duplicate publish of a mic that is already being sent.
    expect(
      afterFailedPublish(
        failed,
        { audio: 'mic', video: null, screen: null },
        new Set(['audio'])
      )
    ).toEqual([]);
  });
});

describe('pull recovery', () => {
  it('rolls back only an offer left unanswered', () => {
    expect(needsPullRollback('have-remote-offer')).toBe(true);
    expect(needsPullRollback('stable')).toBe(false);
    expect(needsPullRollback('have-local-offer')).toBe(false);
    expect(needsPullRollback('closed')).toBe(false);
  });

  it('retries one strike and rejoins on the next', () => {
    expect(PULL_STRIKES_BEFORE_REJOIN).toBe(2);
    const first = afterPullStrike(0, 'stable');
    expect(first).toEqual({ strikes: 1, rejoin: false });
    expect(afterPullStrike(first.strikes, 'stable')).toEqual({
      strikes: 2,
      rejoin: true,
    });
  });

  it('rejoins at once when the rollback left the connection wedged', () => {
    expect(afterPullStrike(0, 'have-remote-offer')).toEqual({
      strikes: 1,
      rejoin: true,
    });
    expect(afterPullStrike(0, 'closed').rejoin).toBe(true);
  });

  it('stops a pull that keeps failing instead of rejoining forever', () => {
    // A rejoin reaches `connected` (which resets the ICE retry count),
    // then two replans fail the pull again: about every 15 s.
    let rejoins: number[] = [];
    let admitted = 0;
    let t = NOW;
    for (let i = 0; i < 20; i += 1, t += 15_000) {
      const next = admitPullRejoin(rejoins, t);
      rejoins = next.rejoins;
      if (!next.admit) break;
      admitted += 1;
    }
    expect(PULL_REJOIN_LIMIT).toBe(3);
    expect(admitted).toBe(PULL_REJOIN_LIMIT);
  });

  it('admits pull rejoins again once the earlier ones age out', () => {
    const full = [NOW - 60_000, NOW - 30_000, NOW - 10_000];
    expect(admitPullRejoin(full, NOW).admit).toBe(false);
    const later = NOW - 60_000 + PULL_REJOIN_WINDOW_MS;
    expect(admitPullRejoin(full, later)).toEqual({
      rejoins: [NOW - 30_000, NOW - 10_000, later],
      admit: true,
    });
    expect(admitPullRejoin([], NOW)).toEqual({ rejoins: [NOW], admit: true });
  });
});

describe('sfu answers', () => {
  it('names the not-configured 503 and the other refusals', () => {
    expect(classifyRoomFailure(503, { error: 'meetings_not_configured' })).toBe(
      'not_configured'
    );
    expect(classifyRoomFailure(503, { error: 'other' })).toBe('join_failed');
    expect(classifyRoomFailure(409, { error: 'meeting_ended' })).toBe(
      'meeting_closed'
    );
    expect(classifyRoomFailure(403, null)).toBe('forbidden');
    expect(classifyRoomFailure(500, 'x')).toBe('join_failed');
  });

  it('parses a join answer', () => {
    expect(
      parseJoinResult({
        participantId: 'p',
        sessionId: 's',
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { nope: 1 }],
      })
    ).toEqual({
      participantId: 'p',
      sessionId: 's',
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });
    expect(parseJoinResult({ participantId: 'p' })).toBeNull();
  });

  it('parses a tracks answer with per-track errors', () => {
    expect(
      parseTracksResult({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'v=0' },
        tracks: [
          { mid: '0', trackName: 'a:audio', sessionId: 's-a' },
          { trackName: 'a:video', errorCode: 'not_found' },
        ],
      })
    ).toEqual({
      errorCode: null,
      errorDescription: null,
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [
        { mid: '0', trackName: 'a:audio', sessionId: 's-a', errorCode: null },
        {
          mid: null,
          trackName: 'a:video',
          sessionId: null,
          errorCode: 'not_found',
        },
      ],
    });
    expect(parseTracksResult(null).requiresImmediateRenegotiation).toBe(false);
  });
});
