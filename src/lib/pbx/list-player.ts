// The recording player on the Calls list. A call whose number matches
// no contact has no customer page, so this is the only place its
// recording plays. The list offers Play only where the customer page
// would show a player (the audio is stored and not deleted under the
// retention period); a held, pending, erased or unstored recording has
// nothing to play, and its state is the customer page's to explain.
// Nothing is fetched until Play is pressed: the player itself asks the
// recording route for a signed link, which logs the play.
//
// One player is open at a time: opening another row's closes the first,
// and a closed player's audio element is removed, which pauses it.

import { recordingView, type TimelineCall } from './timeline';

/** Whether a Calls list row offers its recording's Play control. */
export function listPlayerOffered(
  call: Pick<TimelineCall, 'recordingState' | 'recordingDeleted'>
): boolean {
  return recordingView(call) === 'player';
}

/** The row whose player is open after pressing `id`'s control. */
export function nextOpenPlayer(open: string | null, id: string): string | null {
  return open === id ? null : id;
}
