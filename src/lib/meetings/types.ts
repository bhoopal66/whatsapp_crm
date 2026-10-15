// ============================================================
// Video meetings (migration 106) — row shapes and the Cloudflare
// Realtime SFU wire types (OpenAPI: TracksRequest, TrackObject,
// SessionDescription, CloseTracksRequest).
// ============================================================

export const MEETING_STATUSES = ['scheduled', 'ended', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_COLUMNS =
  'id, account_id, title, description, scheduled_start, scheduled_end, host_user_id, open_to_workspace, status, ended_at, created_at, updated_at';

export interface MeetingRow {
  id: string;
  account_id: string;
  title: string;
  description: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  host_user_id: string;
  open_to_workspace: boolean;
  status: MeetingStatus;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export const TRACK_KINDS = ['audio', 'video', 'screen'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

/** One entry of `meeting_participants.tracks`. */
export interface ParticipantTrack {
  trackName: string;
  kind: TrackKind;
}

export const PARTICIPANT_COLUMNS =
  'id, meeting_id, account_id, user_id, cf_session_id, joined_at, last_seen_at, left_at, tracks, audio_muted, video_off';

export interface ParticipantRow {
  id: string;
  meeting_id: string;
  account_id: string;
  user_id: string;
  cf_session_id: string;
  joined_at: string;
  last_seen_at: string;
  left_at: string | null;
  tracks: ParticipantTrack[];
  audio_muted: boolean;
  video_off: boolean;
}

/** Present = not left and heard from within this window (clients beat every 20 s). */
export const PRESENCE_WINDOW_MS = 60_000;

/** STUN only for now; TURN is a later addition. */
export const MEETING_ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

export const MEETING_SCOPES = ['live', 'upcoming', 'past'] as const;
export type MeetingScope = (typeof MEETING_SCOPES)[number];

// ---- Cloudflare Realtime SFU ----

export interface SessionDescription {
  sdp: string;
  type: 'offer' | 'answer';
}

export interface TrackObject {
  location?: 'local' | 'remote';
  mid?: string;
  sessionId?: string;
  trackName?: string;
  bidirectionalMediaStream?: boolean;
  kind?: string;
  simulcast?: Record<string, unknown>;
}

export interface TracksRequest {
  sessionDescription?: SessionDescription;
  tracks?: TrackObject[];
  autoDiscover?: boolean;
}

export interface SfuErrorFields {
  errorCode?: string;
  errorDescription?: string;
}

export interface TracksResponse extends SfuErrorFields {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: (TrackObject & SfuErrorFields)[];
}

export interface CloseTracksRequest {
  sessionDescription?: SessionDescription;
  tracks: { mid: string }[];
  force: boolean;
}

export interface CloseTracksResponse extends SfuErrorFields {
  sessionDescription?: SessionDescription;
  tracks?: ({ mid: string } & SfuErrorFields)[];
  requiresImmediateRenegotiation?: boolean;
}

export interface NewSessionResponse extends SfuErrorFields {
  sessionId: string;
  sessionDescription?: SessionDescription;
}

export interface RenegotiateResponse extends SfuErrorFields {
  sessionDescription?: SessionDescription;
}

export interface GetSessionStateResponse extends SfuErrorFields {
  tracks?: (TrackObject & {
    status?: 'active' | 'inactive' | 'initializing';
  })[];
  dataChannels?: Record<string, unknown>[];
}
