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
 * The refusal for a channel with a bank guest (chat_channels_with_guests,
 * migration 102: a member with the guest role, or whose role in the
 * workspace is bank_guest). A guest reads the channel's messages, and
 * the post can carry a customer's own words, which bank guests never
 * see (087 refuses a conversation card there for the same reason).
 */
export const TEAM_CHAT_GUEST_REFUSAL =
  'post_team_chat: the channel has a bank guest member, and customer text is never posted where a bank guest reads it';

/**
 * chat_channels_with_guests' answer for the one channel asked about:
 * the refusal when it names a guest, or when it is not the expected
 * list at all (fail closed), else null.
 */
export function teamChatGuestRefusal(answer: unknown): string | null {
  if (!Array.isArray(answer)) {
    return 'post_team_chat: could not check the channel for bank guests';
  }
  return answer.length > 0 ? TEAM_CHAT_GUEST_REFUSAL : null;
}

const ASTERISK_LOOKALIKE = '\u2217'; // ∗ ASTERISK OPERATOR
const AT_LOOKALIKE = '\uFF20'; // ＠ FULLWIDTH COMMERCIAL AT
/** The `@` of @channel / @here as lib/chat/mentions.ts finds them. */
const BROADCAST_AT =
  /(?<![\p{L}\p{N}_])@(?=(?:channel|here)(?![\p{L}\p{N}_]))/giu;

/**
 * A value filled into the post (`{{ message.text }}`, `{{ vars.x }}`)
 * with the chat's markup defused, so a customer's text cannot bold part
 * of a post signed "wacrm · automation", unbalance the template's own
 * `**`, or show as a mention chip in search results. Every `*` becomes
 * `∗` (boldSegments in lib/chat/view.ts pairs `**`), and the `@` of
 * `<@`, `@channel` and `@here` becomes `＠`; an e-mail address keeps
 * its `@`. The automation's own text is left alone.
 */
export function neutraliseTeamChatValue(value: string): string {
  return value
    .replace(/\*/g, ASTERISK_LOOKALIKE)
    .replace(/<@/g, `<${AT_LOOKALIKE}`)
    .replace(BROADCAST_AT, AT_LOOKALIKE);
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
