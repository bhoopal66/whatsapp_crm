// ------------------------------------------------------------
// The `post_team_chat` step: an automation posts into a team chat
// channel as "wacrm · automation", through chat_post_system_message
// (migration 087, service role only). Pure rules here; the engine does
// the lookup and the call.
// ------------------------------------------------------------

/**
 * Channel kinds an automation may post into. A DM is people's own
 * conversation, and a deal room's Team notes belong to one deal, which
 * an account-wide rule has no way to name.
 */
export const TEAM_CHAT_POST_KINDS: readonly string[] = ['team', 'private'];

/** internal_messages_body_len (migration 087): 1 to 8000 characters. */
export const TEAM_CHAT_BODY_MAX = 8000;

/**
 * Why a channel cannot take the post, or null when it can. The row is
 * the engine's lookup, already confined to the automation's account,
 * so a missing row covers another account's channel too: one answer
 * for both, which does not say whether the id exists elsewhere.
 */
export function teamChatChannelRefusal(
  channel: { kind: string; archived_at: string | null } | null
): string | null {
  if (!channel) return 'post_team_chat: channel not found in this workspace';
  if (!TEAM_CHAT_POST_KINDS.includes(channel.kind)) {
    return `post_team_chat: cannot post to a ${channel.kind} channel`;
  }
  if (channel.archived_at) return 'post_team_chat: the channel is archived';
  return null;
}

/**
 * The body as posted: trimmed, and clipped to the column's limit in
 * characters (code points, as char_length counts them), so a long
 * `{{ message.text }}` shortens the post rather than failing the step.
 */
export function clipTeamChatBody(text: string): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= TEAM_CHAT_BODY_MAX) return trimmed;
  return `${chars.slice(0, TEAM_CHAT_BODY_MAX - 1).join('')}…`;
}

/** A failed chat_post_system_message call, worded for the run log. */
export function describeTeamChatPostError(err: {
  code?: string | null;
  message?: string | null;
}): string {
  switch (err.code) {
    case 'CH001':
      return 'post_team_chat: team chat is turned off for this workspace';
    case '42501':
      return 'post_team_chat: the channel is archived';
    case 'P0002':
      return 'post_team_chat: channel not found in this workspace';
    default:
      return `post_team_chat failed${err.message ? `: ${err.message}` : ''}`;
  }
}
