/**
 * "Share to team chat" from the inbox: who gets the action and which
 * channels the dialog offers. The database has the last word
 * (chat_post_message checks the sharer can view the conversation and
 * that it belongs to the channel's workspace); this only keeps the
 * picker to channels a post can land in.
 */
import { normalizeDigits } from './search-view';
import type { ChannelWithMembership } from './types';

/** Bank guests have no inbox to share from; viewers don't post. */
export function canShareToTeamChat(role: string | null | undefined): boolean {
  return !!role && role !== 'viewer' && role !== 'bank_guest';
}

export interface ShareTarget {
  id: string;
  kind: 'team' | 'private';
  name: string;
  /** Posting in a team channel you are not in joins it. */
  joined: boolean;
}

/**
 * Open team channels (posting joins them) and the private channels the
 * viewer belongs to, whose name contains `query`; joined ones first,
 * then by name. DMs and deal rooms are left out.
 */
export function shareTargets(
  channels: readonly ChannelWithMembership[],
  query = ''
): ShareTarget[] {
  const q = normalizeDigits(query.trim()).toLowerCase().replace(/^#/, '');
  return channels
    .filter(
      (c) =>
        !c.archivedAt &&
        !!c.name &&
        (c.kind === 'team' || (c.kind === 'private' && !!c.membership))
    )
    .map((c) => ({
      id: c.id,
      kind: c.kind as 'team' | 'private',
      name: c.name as string,
      joined: !!c.membership,
    }))
    .filter((c) => !q || normalizeDigits(c.name).toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name)
    );
}
