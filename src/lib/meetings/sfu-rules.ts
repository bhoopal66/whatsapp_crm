// ============================================================
// What a participant may ask the SFU for — pure (no I/O).
//
// One Cloudflare app serves every meeting of every workspace, so the
// SFU itself would let any session pull any track it can name. These
// rules confine a participant to their own meeting:
//   - a local (pushed) track is named `${participantId}:<kind>[:…]`,
//     kind audio | video | screen, so names cannot collide or be
//     spoofed and the kind is recorded with it;
//   - a remote (pulled) track must come from the cf_session_id of a
//     participant present in the same meeting;
//   - autoDiscover is refused: it names tracks at random.
// ============================================================

import {
  SIMULCAST_FALLBACKS,
  SIMULCAST_RIDS,
  TRACK_KINDS,
  type CloseTracksRequest,
  type ParticipantTrack,
  type SessionDescription,
  type TrackKind,
  type TracksRequest,
  type TracksResponse,
  type UpdateTracksRequest,
} from './types';

export type Checked<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 403; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const trackNamePrefix = (participantId: string) => `${participantId}:`;

/** The kind encoded in an owned track name, else null. */
export function ownedTrackKind(
  participantId: string,
  trackName: unknown
): TrackKind | null {
  const prefix = trackNamePrefix(participantId);
  if (typeof trackName !== 'string' || !trackName.startsWith(prefix)) {
    return null;
  }
  const kind = trackName.slice(prefix.length).split(':')[0];
  return (TRACK_KINDS as readonly string[]).includes(kind)
    ? (kind as TrackKind)
    : null;
}

export function isSessionDescription(v: unknown): v is SessionDescription {
  return (
    isObject(v) &&
    typeof v.sdp === 'string' &&
    v.sdp.length > 0 &&
    (v.type === 'offer' || v.type === 'answer')
  );
}

/**
 * A pulled track's `simulcast` preference, when given: preferredRid is
 * one of the layers the camera publishes (f, h, q) and the two
 * fallbacks are the schema's enum. Null when acceptable.
 */
export function simulcastError(v: unknown): string | null {
  if (!isObject(v)) return 'simulcast must be an object';
  if (!(SIMULCAST_RIDS as readonly unknown[]).includes(v.preferredRid)) {
    return `simulcast.preferredRid must be ${SIMULCAST_RIDS.join(', ')}`;
  }
  for (const key of ['priorityOrdering', 'ridNotAvailable'] as const) {
    if (
      v[key] !== undefined &&
      !(SIMULCAST_FALLBACKS as readonly unknown[]).includes(v[key])
    ) {
      return `simulcast.${key} must be ${SIMULCAST_FALLBACKS.join(' or ')}`;
    }
  }
  return null;
}

/**
 * A tracks/new request. `presentSessionIds` are the cf_session_ids of
 * the meeting's present participants. Returns the local tracks to record.
 */
export function checkTracksRequest(
  raw: unknown,
  participantId: string,
  presentSessionIds: ReadonlySet<string>
): Checked<{ request: TracksRequest; localTracks: ParticipantTrack[] }> {
  if (!isObject(raw) || !Array.isArray(raw.tracks) || !raw.tracks.length) {
    return { ok: false, status: 400, error: 'request.tracks is required' };
  }
  if (raw.autoDiscover !== undefined && raw.autoDiscover !== false) {
    return { ok: false, status: 400, error: 'autoDiscover is not allowed' };
  }
  if (
    raw.sessionDescription !== undefined &&
    !isSessionDescription(raw.sessionDescription)
  ) {
    return { ok: false, status: 400, error: 'Invalid sessionDescription' };
  }
  const localTracks: ParticipantTrack[] = [];
  for (const t of raw.tracks as unknown[]) {
    if (!isObject(t) || typeof t.trackName !== 'string' || !t.trackName) {
      return { ok: false, status: 400, error: 'Every track needs a trackName' };
    }
    if (t.location === 'local') {
      if (t.sessionId !== undefined) {
        return {
          ok: false,
          status: 400,
          error: 'A local track takes no sessionId',
        };
      }
      const kind = ownedTrackKind(participantId, t.trackName);
      if (!kind) {
        return {
          ok: false,
          status: 403,
          error: `Local track names must be ${trackNamePrefix(participantId)}audio|video|screen`,
        };
      }
      localTracks.push({ trackName: t.trackName, kind });
    } else if (t.location === 'remote') {
      if (
        typeof t.sessionId !== 'string' ||
        !presentSessionIds.has(t.sessionId)
      ) {
        return {
          ok: false,
          status: 403,
          error: 'That track is not from someone in this meeting',
        };
      }
      if (t.simulcast !== undefined) {
        const bad = simulcastError(t.simulcast);
        if (bad) return { ok: false, status: 400, error: bad };
      }
    } else {
      return {
        ok: false,
        status: 400,
        error: "Every track's location must be local or remote",
      };
    }
  }
  return { ok: true, value: { request: raw as TracksRequest, localTracks } };
}

/**
 * A tracks/update request: only pulled tracks switching layer. Each
 * names its transceiver (`mid`), a session present in this meeting
 * (the update can point a transceiver at another track, so the pull
 * rule applies again) and a simulcast preference.
 */
export function checkTracksUpdate(
  raw: unknown,
  presentSessionIds: ReadonlySet<string>
): Checked<UpdateTracksRequest> {
  if (!isObject(raw) || !Array.isArray(raw.tracks) || !raw.tracks.length) {
    return { ok: false, status: 400, error: 'request.tracks is required' };
  }
  if (
    raw.sessionDescription !== undefined &&
    !isSessionDescription(raw.sessionDescription)
  ) {
    return { ok: false, status: 400, error: 'Invalid sessionDescription' };
  }
  for (const t of raw.tracks as unknown[]) {
    if (
      !isObject(t) ||
      t.location !== 'remote' ||
      typeof t.mid !== 'string' ||
      !t.mid ||
      typeof t.trackName !== 'string' ||
      !t.trackName
    ) {
      return {
        ok: false,
        status: 400,
        error: 'Every track must be remote with a mid and a trackName',
      };
    }
    if (
      typeof t.sessionId !== 'string' ||
      !presentSessionIds.has(t.sessionId)
    ) {
      return {
        ok: false,
        status: 403,
        error: 'That track is not from someone in this meeting',
      };
    }
    const bad = simulcastError(t.simulcast);
    if (bad) return { ok: false, status: 400, error: bad };
  }
  return { ok: true, value: raw as unknown as UpdateTracksRequest };
}

/** The local tracks the SFU accepted (a per-track errorCode is a refusal). */
export function acceptedLocalTracks(
  asked: readonly ParticipantTrack[],
  response: TracksResponse
): ParticipantTrack[] {
  const refused = new Set(
    (response.tracks ?? [])
      .filter((t) => t.errorCode && t.trackName)
      .map((t) => t.trackName as string)
  );
  return asked.filter((t) => !refused.has(t.trackName));
}

/** A tracks/close request plus the owned local names it closes. */
export function checkCloseTracks(
  raw: unknown,
  closedLocalTrackNames: unknown,
  participantId: string
): Checked<{ request: CloseTracksRequest; closedNames: string[] }> {
  if (
    !isObject(raw) ||
    !Array.isArray(raw.tracks) ||
    !raw.tracks.length ||
    !raw.tracks.every(
      (t) => isObject(t) && typeof t.mid === 'string' && t.mid.length > 0
    ) ||
    typeof raw.force !== 'boolean'
  ) {
    return {
      ok: false,
      status: 400,
      error: 'request needs tracks[{ mid }] and force',
    };
  }
  if (
    raw.sessionDescription !== undefined &&
    !isSessionDescription(raw.sessionDescription)
  ) {
    return { ok: false, status: 400, error: 'Invalid sessionDescription' };
  }
  let closedNames: string[] = [];
  if (closedLocalTrackNames !== undefined) {
    if (!Array.isArray(closedLocalTrackNames)) {
      return {
        ok: false,
        status: 400,
        error: 'closedLocalTrackNames must be a list',
      };
    }
    if (!closedLocalTrackNames.every((n) => ownedTrackKind(participantId, n))) {
      return {
        ok: false,
        status: 403,
        error: 'You can only close your own tracks',
      };
    }
    closedNames = closedLocalTrackNames as string[];
  }
  return {
    ok: true,
    value: { request: raw as unknown as CloseTracksRequest, closedNames },
  };
}

/** `existing` plus `added`, one entry per trackName (the newer wins). */
export function withTracks(
  existing: readonly ParticipantTrack[],
  added: readonly ParticipantTrack[]
): ParticipantTrack[] {
  const names = new Set(added.map((t) => t.trackName));
  return [...existing.filter((t) => !names.has(t.trackName)), ...added];
}

export function withoutTracks(
  existing: readonly ParticipantTrack[],
  names: readonly string[]
): ParticipantTrack[] {
  const drop = new Set(names);
  return existing.filter((t) => !drop.has(t.trackName));
}
