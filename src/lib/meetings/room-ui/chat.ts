// Chat display rules: grouping, safe link splitting, unread counting.

import type { MeetingChatMessage } from '@/lib/meetings/room/contract';

export const CHAT_MAX_CHARS = 2000;
/** Lines from one author closer together than this share a header. */
export const CHAT_GROUP_GAP_MS = 5 * 60_000;

export interface ChatGroup {
  key: string;
  userId: string;
  startedAt: string;
  messages: MeetingChatMessage[];
}

export function groupChat(
  messages: readonly MeetingChatMessage[],
  gapMs = CHAT_GROUP_GAP_MS
): ChatGroup[] {
  const groups: ChatGroup[] = [];
  for (const m of messages) {
    const last = groups.at(-1);
    const prev = last?.messages.at(-1);
    if (
      last &&
      prev &&
      last.userId === m.userId &&
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) < gapMs
    ) {
      last.messages.push(m);
    } else {
      groups.push({
        key: m.id,
        userId: m.userId,
        startedAt: m.createdAt,
        messages: [m],
      });
    }
  }
  return groups;
}

export type ChatPart =
  { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** An http(s) href for a matched candidate, or null. */
export function safeHref(candidate: string): string | null {
  const raw = /^www\./i.test(candidate) ? `https://${candidate}` : candidate;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Text into text and http(s)/www links; nothing else becomes a link. */
export function splitLinks(text: string): ChatPart[] {
  const parts: ChatPart[] = [];
  let at = 0;
  const push = (t: string) => {
    if (!t) return;
    const last = parts.at(-1);
    if (last?.type === 'text') last.text += t;
    else parts.push({ type: 'text', text: t });
  };
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    const candidate = match[0].replace(TRAILING, '');
    const href = safeHref(candidate);
    push(text.slice(at, start));
    if (href) parts.push({ type: 'link', text: candidate, href });
    else push(candidate);
    at = start + candidate.length;
  }
  push(text.slice(at));
  return parts;
}

/** Others' lines newer than the last one seen; `seenAt` null = none seen. */
export function unreadCount(
  messages: readonly MeetingChatMessage[],
  seenAt: string | null,
  selfUserId: string | null
): number {
  return messages.filter(
    (m) => m.userId !== selfUserId && (!seenAt || m.createdAt > seenAt)
  ).length;
}

/** Autoscroll only while the reader is at (or near) the bottom. */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 80
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** The body to send, or null when empty or over the limit. */
export function chatBodyToSend(input: string): string | null {
  const body = input.trim();
  return body && body.length <= CHAT_MAX_CHARS ? body : null;
}
