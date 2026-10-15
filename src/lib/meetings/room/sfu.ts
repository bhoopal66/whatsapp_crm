// Reading our API's answers. The SFU routes return Cloudflare's JSON
// as-is (TracksResponse / CloseTracksResponse / RenegotiateResponse);
// our own failures are `{ error: string }` with a 4xx/5xx status.

export type RoomError =
  /** 503 meetings_not_configured: no Cloudflare keys on the server. */
  | 'not_configured'
  /** 409: the meeting has ended or was cancelled. */
  | 'meeting_closed'
  /** 403/404: not invited, or not this workspace's meeting. */
  | 'forbidden'
  /** 403 removed_from_meeting: the host removed us; they can let us back in (110). */
  | 'removed_from_meeting'
  | 'join_failed'
  /** ICE failed and rejoining did not bring it back. */
  | 'connection_failed'
  /** Our seat was closed under us: joined again from another tab. */
  | 'seat_closed';

export const NOT_CONFIGURED = 'meetings_not_configured';
export const REMOVED = 'removed_from_meeting';

/** The room's wording for a failed join (POST /join) or SFU call. */
export function classifyRoomFailure(status: number, body: unknown): RoomError {
  const error =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error: unknown }).error
      : null;
  if (status === 503 && error === NOT_CONFIGURED) return 'not_configured';
  if (status === 409) return 'meeting_closed';
  if (status === 403 && error === REMOVED) return 'removed_from_meeting';
  if (status === 403 || status === 404) return 'forbidden';
  return 'join_failed';
}

export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface JoinResult {
  participantId: string;
  sessionId: string;
  iceServers: RTCIceServerLike[];
}

/** RTCIceServer without the DOM lib, so this file stays node-testable. */
export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function parseJoinResult(body: unknown): JoinResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.participantId !== 'string' || !b.participantId) return null;
  if (typeof b.sessionId !== 'string' || !b.sessionId) return null;
  const iceServers = Array.isArray(b.iceServers)
    ? (b.iceServers as unknown[]).filter(
        (s): s is RTCIceServerLike =>
          !!s &&
          typeof s === 'object' &&
          (typeof (s as RTCIceServerLike).urls === 'string' ||
            Array.isArray((s as RTCIceServerLike).urls))
      )
    : [];
  return { participantId: b.participantId, sessionId: b.sessionId, iceServers };
}

export interface TrackResult {
  mid: string | null;
  trackName: string | null;
  sessionId: string | null;
  errorCode: string | null;
}

export interface TracksResult {
  /** A request-level failure (Cloudflare's errorCode). */
  errorCode: string | null;
  errorDescription: string | null;
  requiresImmediateRenegotiation: boolean;
  sessionDescription: SessionDescription | null;
  tracks: TrackResult[];
}

/** Cloudflare's tracks/new, tracks/close or renegotiate answer, read defensively. */
export function parseTracksResult(body: unknown): TracksResult {
  const b =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const str = (o: Record<string, unknown>, k: string) =>
    typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null;
  const sd = b.sessionDescription as Record<string, unknown> | undefined;
  const sessionDescription =
    sd &&
    typeof sd === 'object' &&
    (sd.type === 'offer' || sd.type === 'answer') &&
    typeof sd.sdp === 'string'
      ? { type: sd.type as SessionDescription['type'], sdp: sd.sdp }
      : null;
  const tracks = Array.isArray(b.tracks)
    ? (b.tracks as unknown[])
        .filter(
          (t): t is Record<string, unknown> => !!t && typeof t === 'object'
        )
        .map((t) => ({
          mid: str(t, 'mid'),
          trackName: str(t, 'trackName'),
          sessionId: str(t, 'sessionId'),
          errorCode: str(t, 'errorCode'),
        }))
    : [];
  return {
    errorCode: str(b, 'errorCode'),
    errorDescription: str(b, 'errorDescription'),
    requiresImmediateRenegotiation: b.requiresImmediateRenegotiation === true,
    sessionDescription,
    tracks,
  };
}
