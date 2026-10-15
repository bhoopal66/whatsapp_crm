import { describe, expect, it } from 'vitest';

import {
  acceptedLocalTracks,
  checkCloseTracks,
  checkTracksRequest,
  ownedTrackKind,
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
