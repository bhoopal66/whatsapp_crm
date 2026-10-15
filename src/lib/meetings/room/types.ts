// Shapes the meeting room reads. `meeting_participants` is written only
// by the API routes (service role, migration 106); the browser reads it
// through RLS and the realtime publication.

/** What a published track carries. `screen` is a video track of a display. */
export type TrackKind = 'audio' | 'video' | 'screen';

export const TRACK_KINDS: readonly TrackKind[] = ['audio', 'video', 'screen'];

/** One entry of `meeting_participants.tracks`. */
export interface PublishedTrack {
  trackName: string;
  kind: TrackKind;
}

/** A `meeting_participants` row, as far as the room needs it. */
export interface ParticipantRow {
  id: string;
  meeting_id: string;
  user_id: string;
  cf_session_id: string;
  joined_at: string;
  last_seen_at: string;
  left_at: string | null;
  tracks: PublishedTrack[];
  audio_muted: boolean;
  video_off: boolean;
}

/** The columns the room selects. */
export const PARTICIPANT_COLUMNS =
  'id, meeting_id, user_id, cf_session_id, joined_at, last_seen_at, left_at, tracks, audio_muted, video_off';

/** A remote track the room wants to receive (one `location: 'remote'` entry). */
export interface RemoteTrackRef {
  participantId: string;
  sessionId: string;
  trackName: string;
  kind: TrackKind;
}
