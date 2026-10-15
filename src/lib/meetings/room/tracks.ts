import {
  TRACK_KINDS,
  type ParticipantRow,
  type PublishedTrack,
  type TrackKind,
} from './types';

/**
 * The SFU track name for one of a participant's tracks. The API refuses
 * a local track whose name does not start with `${participantId}:`.
 *
 * `generation` exists for the screen share: stopping a share closes its
 * track at the SFU, and a later share publishes a fresh name rather
 * than reusing a closed one (Cloudflare can keep closed records in the
 * session). Generation 0 is the plain `${participantId}:${kind}`.
 */
export function trackNameFor(
  participantId: string,
  kind: TrackKind,
  generation = 0
): string {
  const base = `${participantId}:${kind}`;
  return generation > 0 ? `${base}:${generation}` : base;
}

/** The inverse of `trackNameFor`; null for anything it did not produce. */
export function parseTrackName(
  name: string
): { participantId: string; kind: TrackKind; generation: number } | null {
  const parts = name.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const [participantId, kind, gen] = parts;
  if (!participantId || !isTrackKind(kind)) return null;
  if (gen === undefined) return { participantId, kind, generation: 0 };
  if (!/^[1-9]\d*$/.test(gen)) return null;
  return { participantId, kind, generation: Number(gen) };
}

export function isTrackKind(value: unknown): value is TrackKind {
  return (
    typeof value === 'string' &&
    (TRACK_KINDS as readonly string[]).includes(value)
  );
}

/**
 * `meeting_participants.tracks` read defensively (it arrives as jsonb,
 * sometimes through a realtime payload): well-formed entries only, and
 * only names that belong to `participantId`, so one row can never make
 * the room pull another participant's track under its name.
 */
export function parseTracks(
  value: unknown,
  participantId: string
): PublishedTrack[] {
  if (!Array.isArray(value)) return [];
  const out: PublishedTrack[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { trackName, kind } = item as Record<string, unknown>;
    if (typeof trackName !== 'string' || !isTrackKind(kind)) continue;
    const parsed = parseTrackName(trackName);
    if (!parsed || parsed.participantId !== participantId) continue;
    if (parsed.kind !== kind || seen.has(trackName)) continue;
    seen.add(trackName);
    out.push({ trackName, kind });
  }
  return out;
}

/** A participant row read defensively; null when a required field is missing. */
export function parseParticipantRow(value: unknown): ParticipantRow | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const str = (k: string) =>
    typeof r[k] === 'string' ? (r[k] as string) : null;
  const id = str('id');
  const meetingId = str('meeting_id');
  const userId = str('user_id');
  const sessionId = str('cf_session_id');
  const joinedAt = str('joined_at');
  const lastSeenAt = str('last_seen_at');
  if (!id || !meetingId || !userId || !sessionId || !joinedAt || !lastSeenAt) {
    return null;
  }
  return {
    id,
    meeting_id: meetingId,
    user_id: userId,
    cf_session_id: sessionId,
    joined_at: joinedAt,
    last_seen_at: lastSeenAt,
    left_at: str('left_at'),
    tracks: parseTracks(r.tracks, id),
    audio_muted: r.audio_muted === true,
    video_off: r.video_off === true,
  };
}
