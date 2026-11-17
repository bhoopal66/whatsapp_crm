// ============================================================
// The new chat notice (migration 207): a standing reminder shown to
// everyone about to open a chat with a new client, pointing them at
// the workspace's marketing number. Pure rules; the route and the
// banner call these.
// ============================================================

export interface NewChatNotice {
  enabled: boolean;
  channelId: string | null;
  channelLabel: string | null;
  channelPhone: string | null;
  provider: string | null;
  text: string | null;
}

export const NOTICE_TEXT_MAX = 300;

/** No row, a missing function or a malformed answer: on, generic. */
export const DEFAULT_NEW_CHAT_NOTICE: NewChatNotice = {
  enabled: true,
  channelId: null,
  channelLabel: null,
  channelPhone: null,
  provider: null,
  text: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Parse `team_activity_new_chat_notice()`'s jsonb, defensively. */
export function parseNewChatNotice(json: unknown): NewChatNotice {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ...DEFAULT_NEW_CHAT_NOTICE };
  }
  const o = json as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    channelId: str(o.channel_id),
    channelLabel: str(o.channel_label),
    channelPhone: str(o.channel_phone),
    provider: str(o.channel_provider),
    text: str(o.text),
  };
}

export type NoticeInput = {
  enabled: boolean;
  channelId: string | null;
  text: string | null;
};

/** Validate the PUT body. */
export function parseNoticeInput(
  body: unknown
): { ok: true; value: NoticeInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be an object.' };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be true or false.' };
  }
  let channelId: string | null = null;
  if (o.channelId !== null && o.channelId !== undefined) {
    if (typeof o.channelId !== 'string' || !UUID.test(o.channelId)) {
      return { ok: false, error: 'channelId must be a number id or null.' };
    }
    channelId = o.channelId;
  }
  let text: string | null = null;
  if (o.text !== null && o.text !== undefined) {
    if (typeof o.text !== 'string') {
      return { ok: false, error: 'text must be text or null.' };
    }
    const trimmed = o.text.trim();
    if (trimmed.length > NOTICE_TEXT_MAX) {
      return {
        ok: false,
        error: `text must be at most ${NOTICE_TEXT_MAX} characters.`,
      };
    }
    text = trimmed === '' ? null : trimmed;
  }
  return { ok: true, value: { enabled: o.enabled, channelId, text } };
}

/**
 * Whether the reminder shows: on, this send would open a new chat, not
 * a personal chat, and not already from the marketing number (when one
 * is named).
 */
export function shouldShowNewChatNotice(args: {
  notice: NewChatNotice;
  wouldStartChat: boolean;
  isPersonalChat: boolean;
  sendingChannelId: string | null;
}): boolean {
  const { notice, wouldStartChat, isPersonalChat, sendingChannelId } = args;
  return (
    notice.enabled &&
    wouldStartChat &&
    !isPersonalChat &&
    (notice.channelId === null || sendingChannelId !== notice.channelId)
  );
}

/** The marketing number's name for the banner: label, else phone. */
export function marketingNumberName(notice: NewChatNotice): string | null {
  return notice.channelLabel ?? notice.channelPhone ?? null;
}

export type NewChatNoticeWording =
  | { kind: 'custom'; text: string }
  | { kind: 'named'; name: string }
  | { kind: 'default' };

/**
 * What the reminder says: the admin's own text verbatim, else the
 * default wording, naming the marketing number when one is set.
 */
export function newChatNoticeWording(
  notice: NewChatNotice
): NewChatNoticeWording {
  if (notice.text) return { kind: 'custom', text: notice.text };
  const name = notice.channelId ? marketingNumberName(notice) : null;
  return name ? { kind: 'named', name } : { kind: 'default' };
}

/**
 * Whether the reminder offers "Switch to marketing number": one is set,
 * the caller may send from it (`usableIds`, the switcher's list), and
 * the chat is not locked to its own number (a coordinator share, 133).
 */
export function offersMarketingSwitch(args: {
  notice: NewChatNotice;
  usableIds: readonly string[] | null;
  locked: boolean;
}): boolean {
  const { notice, usableIds, locked } = args;
  return (
    !locked &&
    notice.channelId !== null &&
    !!usableIds &&
    usableIds.includes(notice.channelId)
  );
}
