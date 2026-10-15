import { describe, expect, it } from 'vitest';

import { isBusyDeviceError, keepOpenedTrack } from './devices';
import { LEFT_GRACE_MS, stepPresence, type PresenceMemo } from './notices';
import { landedPull, planLayerUpdates, pullSimulcast } from './simulcast';
import { remoteLevel, SOURCE_MAX_AGE_MS } from './speaker';
import { parseParticipantRow } from './tracks';
import type { ParticipantRow } from './types';

function row(id: string, userId: string): ParticipantRow {
  const at = '2026-10-15T10:00:00Z';
  return parseParticipantRow({
    id,
    meeting_id: 'm1',
    user_id: userId,
    cf_session_id: `s-${id}`,
    joined_at: at,
    last_seen_at: at,
    tracks: [],
  })!;
}

describe('camera pull layer (H1)', () => {
  it('records the layer sent, so a resize in flight gets an update', () => {
    // Pulled before the screen sized the tile: medium, layer h.
    const sent = pullSimulcast({}, 'p1');
    expect(sent?.preferredRid).toBe('h');
    // The screen reports the tile large while the pull is in flight.
    const now = { p1: 'large' } as const;
    const landed = landedPull(sent, now, 'p1');
    expect(landed).toEqual({ rid: 'h', resync: true });
    const updates = planLayerUpdates(now, [
      {
        trackName: 't1',
        participantId: 'p1',
        sessionId: 's1',
        mid: '3',
        rid: landed.rid,
      },
    ]);
    expect(updates.map((u) => u.simulcast.preferredRid)).toEqual(['f']);
  });

  it('needs nothing more when the tile kept its size', () => {
    const sizes = { p1: 'small' } as const;
    expect(landedPull(pullSimulcast(sizes, 'p1'), sizes, 'p1')).toEqual({
      rid: 'q',
      resync: false,
    });
  });

  it('resyncs a tile hidden while the pull was in flight', () => {
    expect(landedPull(pullSimulcast({}, 'p1'), { p1: 'hidden' }, 'p1')).toEqual(
      {
        rid: 'h',
        resync: true,
      }
    );
  });
});

describe('departure grace (M2)', () => {
  const self = { userId: 'me', participantId: 'p-me' };
  const start = (users: string[]): PresenceMemo => ({
    users: new Set(users),
    away: new Map(),
  });

  it('a reconnect within the grace reads as neither left nor joined', () => {
    let memo = start(['u1']);
    // u1's old seat closes: held, nothing shown yet.
    let r = stepPresence(memo, [row('p-me', 'me')], self, 1_000);
    expect(r.notices).toEqual([]);
    memo = r.memo;
    // u1 is back on a new seat a few seconds later.
    r = stepPresence(memo, [row('p-me', 'me'), row('p1b', 'u1')], self, 6_000);
    expect(r.notices).toEqual([]);
    // And nothing fires once the grace would have passed.
    r = stepPresence(
      r.memo,
      [row('p-me', 'me'), row('p1b', 'u1')],
      self,
      1_000 + LEFT_GRACE_MS + 5_000
    );
    expect(r.notices).toEqual([]);
  });

  it('announces a departure once the grace has passed', () => {
    let r = stepPresence(start(['u1']), [], self, 1_000);
    expect(r.notices).toEqual([]);
    r = stepPresence(r.memo, [], self, 1_000 + LEFT_GRACE_MS - 1);
    expect(r.notices).toEqual([]);
    r = stepPresence(r.memo, [], self, 1_000 + LEFT_GRACE_MS);
    expect(r.notices).toEqual([{ kind: 'left', userId: 'u1' }]);
    expect(r.memo.away.size).toBe(0);
  });

  it('someone back after the grace left and rejoined', () => {
    const r1 = stepPresence(start(['u1']), [], self, 0);
    const r2 = stepPresence(r1.memo, [row('p1b', 'u1')], self, LEFT_GRACE_MS);
    expect(r2.notices).toEqual([
      { kind: 'left', userId: 'u1' },
      { kind: 'joined', userId: 'u1' },
    ]);
  });

  it('a new face joins at once, and the first plan says nothing', () => {
    const first = stepPresence(null, [row('p1', 'u1')], self, 0);
    expect(first.notices).toEqual([]);
    const r = stepPresence(
      first.memo,
      [row('p1', 'u1'), row('p2', 'u2')],
      self,
      10
    );
    expect(r.notices).toEqual([{ kind: 'joined', userId: 'u2' }]);
  });
});

describe('a device that opened too late (M3)', () => {
  const at = { session: 2, epoch: 1 };
  it('is kept while the preview or the call is still there', () => {
    for (const phase of ['lobby', 'joining', 'live', 'reconnecting'])
      expect(keepOpenedTrack(at, { ...at, phase })).toBe(true);
  });
  it('is refused after leave, removal, the end, or unmount', () => {
    expect(keepOpenedTrack(at, { session: 3, epoch: 1, phase: 'live' })).toBe(
      false
    );
    expect(keepOpenedTrack(at, { session: 2, epoch: 2, phase: 'live' })).toBe(
      false
    );
    for (const phase of ['left', 'removed', 'ended', 'error'])
      expect(keepOpenedTrack(at, { ...at, phase })).toBe(false);
  });
});

describe('busy camera retry (L7)', () => {
  it('retries only a busy device', () => {
    expect(isBusyDeviceError({ name: 'NotReadableError' })).toBe(true);
    expect(isBusyDeviceError({ name: 'AbortError' })).toBe(true);
    expect(isBusyDeviceError({ name: 'NotAllowedError' })).toBe(false);
    expect(isBusyDeviceError({ name: 'OverconstrainedError' })).toBe(false);
    expect(isBusyDeviceError(null)).toBe(false);
  });
});

describe('remote voice level (L6)', () => {
  const origin = 1_760_000_000_000;
  const perfNow = 50_000;

  it('ignores a source last heard too long ago (spec clock)', () => {
    const wall = origin + perfNow;
    expect(
      remoteLevel(
        [{ audioLevel: 0.6, timestamp: wall - SOURCE_MAX_AGE_MS - 1 }],
        false,
        perfNow,
        origin
      )
    ).toBe(0);
    expect(
      remoteLevel(
        [{ audioLevel: 0.6, timestamp: wall - 100 }],
        false,
        perfNow,
        origin
      )
    ).toBe(0.6);
  });

  it('ignores a stale source on the performance clock too', () => {
    expect(
      remoteLevel(
        [{ audioLevel: 0.6, timestamp: perfNow - 9_000 }],
        false,
        perfNow,
        origin
      )
    ).toBe(0);
    expect(
      remoteLevel(
        [
          { audioLevel: 0.9, timestamp: perfNow - 9_000 },
          { audioLevel: 0.3, timestamp: perfNow - 20 },
        ],
        false,
        perfNow,
        origin
      )
    ).toBe(0.3);
  });

  it('a muted participant is silent whatever the receiver reports', () => {
    expect(
      remoteLevel(
        [{ audioLevel: 0.6, timestamp: perfNow }],
        true,
        perfNow,
        origin
      )
    ).toBe(0);
  });
});
