import { describe, expect, it } from 'vitest';

import {
  acceptedLocalTracks,
  checkCloseTracks,
  checkTracksRequest,
  checkTracksUpdate,
  ownedTrackKind,
  simulcastError,
  withoutTracks,
  withTracks,
} from './sfu-rules';

const P = '11111111-1111-4111-8111-111111111111';
const offer = { type: 'offer', sdp: 'v=0' };

describe('ownedTrackKind', () => {
  it('reads the kind after the participant prefix', () => {
    expect(ownedTrackKind(P, `${P}:audio`)).toBe('audio');
    expect(ownedTrackKind(P, `${P}:screen:2`)).toBe('screen');
  });

  it('refuses another participant, a bare id and an unknown kind', () => {
    expect(ownedTrackKind(P, 'someone-else:audio')).toBeNull();
    expect(ownedTrackKind(P, P)).toBeNull();
    expect(ownedTrackKind(P, `${P}:data`)).toBeNull();
    expect(ownedTrackKind(P, 7)).toBeNull();
  });
});

describe('checkTracksRequest', () => {
  const present = new Set(['sess-b']);

  it('accepts own local tracks and returns them with their kind', () => {
    const r = checkTracksRequest(
      {
        sessionDescription: offer,
        tracks: [
          { location: 'local', mid: '0', trackName: `${P}:audio` },
          { location: 'local', mid: '1', trackName: `${P}:video` },
        ],
      },
      P,
      present
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        localTracks: [
          { trackName: `${P}:audio`, kind: 'audio' },
          { trackName: `${P}:video`, kind: 'video' },
        ],
      },
    });
  });

  it('refuses a local track named for someone else (403)', () => {
    const r = checkTracksRequest(
      { tracks: [{ location: 'local', mid: '0', trackName: 'other:audio' }] },
      P,
      present
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('accepts a remote track from a present participant', () => {
    const r = checkTracksRequest(
      {
        tracks: [
          { location: 'remote', sessionId: 'sess-b', trackName: 'x:audio' },
        ],
      },
      P,
      present
    );
    expect(r).toMatchObject({ ok: true, value: { localTracks: [] } });
  });

  it('refuses a remote track from a session not present in this meeting', () => {
    const r = checkTracksRequest(
      {
        tracks: [
          { location: 'remote', sessionId: 'sess-z', trackName: 'x:audio' },
        ],
      },
      P,
      present
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses autoDiscover, a missing location, no tracks and a bad SDP', () => {
    const local = { location: 'local', trackName: `${P}:audio` };
    expect(
      checkTracksRequest({ autoDiscover: true, tracks: [local] }, P, present)
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      checkTracksRequest({ tracks: [{ trackName: `${P}:audio` }] }, P, present)
    ).toMatchObject({ ok: false, status: 400 });
    expect(checkTracksRequest({ tracks: [] }, P, present)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      checkTracksRequest(
        { sessionDescription: { type: 'pranswer', sdp: 'x' }, tracks: [local] },
        P,
        present
      )
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      checkTracksRequest(
        { tracks: [{ ...local, sessionId: 'sess-b' }] },
        P,
        present
      )
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe('acceptedLocalTracks', () => {
  it('drops the tracks the SFU answered with an errorCode', () => {
    const asked = [
      { trackName: `${P}:audio`, kind: 'audio' as const },
      { trackName: `${P}:video`, kind: 'video' as const },
    ];
    expect(
      acceptedLocalTracks(asked, {
        tracks: [{ trackName: `${P}:video`, errorCode: 'x' }],
      })
    ).toEqual([asked[0]]);
  });
});

describe('checkCloseTracks', () => {
  it('accepts mids plus own local names', () => {
    expect(
      checkCloseTracks(
        { tracks: [{ mid: '0' }], force: false },
        [`${P}:video`],
        P
      )
    ).toMatchObject({ ok: true, value: { closedNames: [`${P}:video`] } });
  });

  it('refuses closing a name that is not the caller’s (403)', () => {
    expect(
      checkCloseTracks({ tracks: [{ mid: '0' }], force: false }, ['x:a'], P)
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a request without mids or force (400)', () => {
    expect(
      checkCloseTracks({ tracks: [{}], force: false }, undefined, P)
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      checkCloseTracks({ tracks: [{ mid: '0' }] }, undefined, P)
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe('withTracks / withoutTracks', () => {
  const a = { trackName: `${P}:audio`, kind: 'audio' as const };
  const v = { trackName: `${P}:video`, kind: 'video' as const };

  it('adds once per name and removes by name', () => {
    expect(withTracks([a], [a, v])).toEqual([a, v]);
    expect(withoutTracks([a, v], [a.trackName])).toEqual([v]);
  });
});

describe('simulcast on pulled tracks', () => {
  const present = new Set(['sess-b']);
  const pull = (simulcast: unknown) => ({
    tracks: [
      {
        location: 'remote',
        sessionId: 'sess-b',
        trackName: 'b:video',
        simulcast,
      },
    ],
  });

  it('accepts a layer preference on a remote track', () => {
    const ok = checkTracksRequest(
      pull({
        preferredRid: 'q',
        priorityOrdering: 'asciibetical',
        ridNotAvailable: 'none',
      }),
      P,
      present
    );
    expect(ok.ok).toBe(true);
  });

  it('refuses an unknown rid or fallback', () => {
    for (const simulcast of [
      { preferredRid: 'x' },
      {},
      'f',
      { preferredRid: 'h', priorityOrdering: 'random' },
      { preferredRid: 'h', ridNotAvailable: 'z' },
    ]) {
      const res = checkTracksRequest(pull(simulcast), P, present);
      expect(res).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('names the problem', () => {
    expect(simulcastError({ preferredRid: 'f' })).toBeNull();
    expect(simulcastError({ preferredRid: 'F' })).toMatch(/preferredRid/);
  });
});

describe('checkTracksUpdate', () => {
  const present = new Set(['sess-b']);
  const track = (over: Record<string, unknown> = {}) => ({
    location: 'remote',
    sessionId: 'sess-b',
    trackName: 'b:video',
    mid: '3',
    simulcast: { preferredRid: 'h', priorityOrdering: 'asciibetical' },
    ...over,
  });

  it('accepts a layer switch on a present session', () => {
    const req = {
      tracks: [track(), track({ mid: '4', simulcast: { preferredRid: 'f' } })],
    };
    expect(checkTracksUpdate(req, present)).toEqual({ ok: true, value: req });
  });

  it('forwards validated fields only, dropping unknown keys', () => {
    const r = checkTracksUpdate(
      {
        tracks: [
          track({
            extra: 'x',
            simulcast: {
              preferredRid: 'h',
              evil: 1,
              ridNotAvailable: 'asciibetical',
            },
          }),
        ],
        sessionDescription: { type: 'answer', sdp: 'v=0', junk: true },
        autoDiscover: false,
        other: 1,
      },
      present
    );
    expect(r).toEqual({
      ok: true,
      value: {
        tracks: [
          {
            location: 'remote',
            sessionId: 'sess-b',
            trackName: 'b:video',
            mid: '3',
            simulcast: { preferredRid: 'h', ridNotAvailable: 'asciibetical' },
          },
        ],
        sessionDescription: { type: 'answer', sdp: 'v=0' },
      },
    });
  });

  it('refuses autoDiscover', () => {
    expect(
      checkTracksUpdate({ tracks: [track()], autoDiscover: true }, present)
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses local tracks, a missing mid, trackName or simulcast', () => {
    for (const t of [
      track({ location: 'local' }),
      track({ mid: '' }),
      track({ mid: undefined }),
      track({ trackName: undefined }),
      track({ simulcast: undefined }),
      track({ simulcast: { preferredRid: 'x' } }),
    ]) {
      expect(checkTracksUpdate({ tracks: [t] }, present)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    expect(checkTracksUpdate({ tracks: [] }, present)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('refuses a session not present in this meeting', () => {
    expect(
      checkTracksUpdate({ tracks: [track({ sessionId: 'sess-z' })] }, present)
    ).toMatchObject({ ok: false, status: 403 });
  });
});
