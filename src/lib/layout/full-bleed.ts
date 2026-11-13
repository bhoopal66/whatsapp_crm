// ============================================================
// Which dashboard screens fill the space under the top bar themselves.
//
// The shell's <main> is normally a padded, scrolling column. Split-view
// screens (the WhatsApp inboxes, groups, team chat, a meeting room) size
// their own panes instead: the shell gives them a non-scrolling flex
// column and they take `flex-1`. They used to set
// `h-[calc(100vh-3.5rem)]` inside the padded column, which broke on
// phones twice over: 100vh counts the space under the browser's address
// bar, and anything the shell shows above the page (the push offer, the
// access alert) made the column taller than the screen, so the chat
// input slid off the bottom.
// ============================================================

import { isChatPath } from '@/lib/chat/view';
import { isMeetingRoomPath } from '@/lib/meetings/session/paths';

/** Screens that fill the shell's main area and scroll their own panes. */
export const FULL_BLEED_ROOTS = [
  '/inbox',
  '/team-inbox',
  '/hr-inbox',
  '/broadcasts/inbox',
  '/groups',
  '/submission-groups',
] as const;

function underRoot(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function isFullBleedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return (
    isChatPath(pathname) ||
    isMeetingRoomPath(pathname) ||
    FULL_BLEED_ROOTS.some((root) => underRoot(pathname, root))
  );
}
