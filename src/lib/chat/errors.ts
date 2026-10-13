/**
 * Errors from the chat RPCs and tables → one `ChatError` shape.
 *
 * Ported from the 014b package. Migration 087 raises these SQLSTATEs:
 * 42501 forbidden (also "permission denied" from privileges), P0002 not
 * found, 22023 / 23514 invalid argument or rule, CH001 internal chat
 * disabled. The server adds 22P02 / 22001 / 22004 / 23502 (invalid
 * input), 23505 (unique violation — a duplicate channel name) and
 * 40001 / 40P01 (conflict). PostgREST passes the SQLSTATE through as
 * `error.code`.
 *
 * `key` is a stable, finer-grained reason for the UI to translate. It is
 * derived from the wording 087 raises, so a reworded RAISE in a later
 * migration degrades to the coarse key for its code, never to a wrong one.
 */

export type ChatErrorCode =
  'FORBIDDEN' | 'NOT_FOUND' | 'DISABLED' | 'INVALID' | 'CONFLICT' | 'UNKNOWN';

export type ChatErrorKey =
  // coarse, one per code
  | 'forbidden'
  | 'notFound'
  | 'disabled'
  | 'invalid'
  | 'conflict'
  | 'unknown'
  // finer reasons
  | 'notWorkspaceMember'
  | 'notChannelMember'
  | 'archived'
  | 'guestRestricted'
  | 'notAuthor'
  | 'messageDeleted'
  | 'adminRequired'
  | 'cannotShare'
  | 'attachmentMissing'
  | 'attachmentInvalid'
  | 'fileTooLarge'
  | 'tooManyFiles'
  | 'uploadFailed'
  | 'dmSize'
  | 'lastAdmin'
  | 'lastMember'
  | 'pinLimit'
  | 'reasonRequired'
  | 'threadInvalid'
  | 'bodyLength'
  | 'duplicateName'
  // 091's channel administration
  | 'nameLength'
  | 'topicLength'
  | 'removeSelf'
  | 'notManageable';

export class ChatError extends Error {
  override readonly name = 'ChatError';
  constructor(
    readonly code: ChatErrorCode,
    readonly key: ChatErrorKey,
    message: string,
    readonly sqlState?: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

const BY_SQLSTATE: Record<string, ChatErrorCode> = {
  '42501': 'FORBIDDEN',
  P0002: 'NOT_FOUND',
  CH001: 'DISABLED',
  '22023': 'INVALID',
  '23514': 'INVALID',
  '22P02': 'INVALID',
  '22001': 'INVALID',
  '22004': 'INVALID',
  '23502': 'INVALID',
  '23505': 'CONFLICT',
  '40001': 'CONFLICT',
  '40P01': 'CONFLICT',
};

const COARSE_KEY: Record<ChatErrorCode, ChatErrorKey> = {
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'notFound',
  DISABLED: 'disabled',
  INVALID: 'invalid',
  CONFLICT: 'conflict',
  UNKNOWN: 'unknown',
};

/** Message wording → finer key, checked in order within the code. */
const FINE_KEYS: Partial<Record<ChatErrorCode, [RegExp, ChatErrorKey][]>> = {
  FORBIDDEN: [
    [/channel is archived/i, 'archived'],
    [/not a member of this channel/i, 'notChannelMember'],
    [
      /not a member of this workspace|not an active member|no authenticated user/i,
      'notWorkspaceMember',
    ],
    [/cannot share this (conversation|call)/i, 'cannotShare'],
    [/only the author can edit/i, 'notAuthor'],
    [/message was deleted/i, 'messageDeleted'],
    [/bank guests?/i, 'guestRestricted'],
    [
      /owner(\/admin)? role required|owner or admin role required|only (the author or a workspace owner\/admin|channel admins)/i,
      'adminRequired',
    ],
  ],
  NOT_FOUND: [[/was not uploaded/i, 'attachmentMissing']],
  INVALID: [
    [/2 to 8 members/i, 'dmSize'],
    [/last admin/i, 'lastAdmin'],
    [/last member/i, 'lastMember'],
    [/at most 100 pins/i, 'pinLimit'],
    [/attachment/i, 'attachmentInvalid'],
    [/reason of at least 5 characters/i, 'reasonRequired'],
    [/one level of threading|same channel as its root/i, 'threadInvalid'],
    [/internal_messages_body_len/i, 'bodyLength'],
    [/chat_channels_name_check/i, 'nameLength'],
    [/chat_channels_topic_check/i, 'topicLength'],
    [/use chat_leave_channel/i, 'removeSelf'],
    [/only team and private channels/i, 'notManageable'],
  ],
  CONFLICT: [[/chat_channels_name_uq/i, 'duplicateName']],
};

function fineKey(code: ChatErrorCode, message: string): ChatErrorKey {
  for (const [re, key] of FINE_KEYS[code] ?? []) {
    if (re.test(message)) return key;
  }
  return COARSE_KEY[code];
}

/**
 * Any error from a supabase-js call (a PostgrestError, a thrown fetch
 * failure, …) → ChatError. Unrecognised codes become UNKNOWN with the
 * original kept as `cause`, so callers handle exactly one error type.
 */
export function toChatError(err: unknown): ChatError {
  if (err instanceof ChatError) return err;
  const rawCode = (err as { code?: unknown } | null)?.code;
  const sqlState = typeof rawCode === 'string' && rawCode ? rawCode : undefined;
  const rawMessage = (err as { message?: unknown } | null)?.message;
  const message =
    typeof rawMessage === 'string' && rawMessage ? rawMessage : String(err);
  const code: ChatErrorCode = (sqlState && BY_SQLSTATE[sqlState]) || 'UNKNOWN';
  return new ChatError(code, fineKey(code, message), message, sqlState, {
    cause: err,
  });
}
