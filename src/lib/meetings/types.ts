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
  'id, meeting_id, account_id, user_id, cf_session_id, joined_at, last_seen_at, left_at, tracks, audio_muted, video_off, hand_raised_at, mute_requested_at, removed_at, removed_by';

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
  /** 107: set while the hand is up (the queue order), null when down. */
  hand_raised_at: string | null;
  /** 107: the host's latest "please mute"; the client mutes when it moves. */
  mute_requested_at: string | null;
  /** 107: set with left_at when a moderator removed the seat. */
  removed_at: string | null;
  removed_by: string | null;
}

export const MESSAGE_KINDS = ['chat', 'reaction'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** What the API returns of a `meeting_messages` row (107). */
export const MESSAGE_COLUMNS = 'id, user_id, kind, body, created_at';

export interface MeetingMessage {
  id: string;
  user_id: string;
  kind: MessageKind;
  body: string;
  created_at: string;
}

/** `readmit` targets a person (user id), the others an open seat (110). */
export const MODERATION_ACTIONS = [
  'mute',
  'remove',
  'lower_hand',
  'readmit',
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** Present = not left and heard from within this window (clients beat every 20 s). */
export const PRESENCE_WINDOW_MS = 60_000;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** STUN only: the fallback when no TURN key is configured or it fails. */
export const MEETING_ICE_SERVERS: IceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
];

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
  simulcast?: Simulcast;
}

/** The layers the camera publishes (full, half, quarter resolution). */
export const SIMULCAST_RIDS = ['f', 'h', 'q'] as const;
export type SimulcastRid = (typeof SIMULCAST_RIDS)[number];
export const SIMULCAST_FALLBACKS = ['none', 'asciibetical'] as const;
export type SimulcastFallback = (typeof SIMULCAST_FALLBACKS)[number];

/** A pulled track's layer preference (OpenAPI TrackObject.simulcast). */
export interface Simulcast {
  preferredRid?: SimulcastRid;
  priorityOrdering?: SimulcastFallback;
  ridNotAvailable?: SimulcastFallback;
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

/** PUT tracks/update (OpenAPI UpdateTracksRequest / Response). */
export interface UpdateTracksRequest {
  sessionDescription?: SessionDescription;
  tracks: TrackObject[];
}

export interface UpdateTracksResponse extends SfuErrorFields {
  requiresImmediateRenegotiation?: boolean;
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
