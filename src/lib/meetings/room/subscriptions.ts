import type { ParticipantRow, RemoteTrackRef } from './types';

export interface SubscriptionPlan {
  /** Remote tracks to start receiving. */
  pull: RemoteTrackRef[];
  /** Track names currently received that should be closed. */
  close: string[];
}

/**
 * What to change so that this client receives exactly the published
 * tracks of every other present participant.
 *
 * `currentlyPulled` is every remote track name already received *or
 * already queued*: the caller passes in-flight pulls too, so a burst of
 * realtime events cannot pull the same track twice. Our own tracks are
 * never pulled: they are local, and pulling one back would echo our
 * own voice.
 */
export function planSubscriptions(
  present: readonly ParticipantRow[],
  myParticipantId: string,
  currentlyPulled: ReadonlySet<string>
): SubscriptionPlan {
  const wanted = new Map<string, RemoteTrackRef>();
  for (const row of present) {
    if (row.id === myParticipantId) continue;
    for (const t of row.tracks) {
      wanted.set(t.trackName, {
        participantId: row.id,
        sessionId: row.cf_session_id,
        trackName: t.trackName,
        kind: t.kind,
      });
    }
  }
  const pull = [...wanted.values()].filter(
    (ref) => !currentlyPulled.has(ref.trackName)
  );
  const close = [...currentlyPulled].filter((name) => !wanted.has(name));
  return { pull, close };
}
