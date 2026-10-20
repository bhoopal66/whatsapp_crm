// Pure decisions for the coordinator screens (migration 133): who is
// offered the share dialog, who can receive a share, which rows are
// "shared with me", and how a share-only sender's refusal is worded.
// The database decides every one of these again; this only keeps the
// UI from offering what SQL would refuse.

import { canViewConversation } from '@/lib/auth/conversation-visibility';
import {
  canReceiveCoordinatorShare,
  hasMinRole,
  type AccountRole,
} from '@/lib/auth/roles';

/** A coordinator as `GET /api/coordinators` lists them. */
export interface CoordinatorRow {
  user_id: string;
  name: string;
  email?: string | null;
  banks: string[];
}

/** An open share as `GET /api/conversations/[id]/coordinator-shares` lists it. */
export interface ConversationShareRow {
  id: string;
  coordinator_user_id: string;
  coordinator_name: string;
  bank_code: string;
  bank_name: string;
}

/** The "Share with coordinator" header button: agent and up, never a viewer or guest. */
export function canShareWithCoordinator(role: AccountRole | null): boolean {
  return !!role && hasMinRole(role, 'agent');
}

/**
 * Whether a share can give this role anything (133's
 * `coordinator_share_grants`): agents and team leaders. Admins see
 * every chat anyway; viewers and guests get nothing from a share.
 */
export function receivesShares(role: AccountRole | null): boolean {
  return canReceiveCoordinatorShare(role);
}

/** Whose banks an admin may set in Settings -> Members (133's set_coordinator_banks). */
export function canHoldCoordinatorBanks(role: AccountRole): boolean {
  return receivesShares(role);
}

/** Coordinators of `bank`, without the person sharing, by name. */
export function coordinatorChoices(
  coordinators: readonly CoordinatorRow[],
  bank: string | null,
  selfUserId: string | null
): CoordinatorRow[] {
  if (!bank) return [];
  return coordinators
    .filter((c) => c.banks.includes(bank) && c.user_id !== selfUserId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Conversation id -> the bank it was shared with me under. Rows come
 * oldest first; the first open share of a chat names it (one open share
 * per chat and coordinator, by 133's partial unique index).
 */
export function sharedBankByConversation(
  rows: readonly { conversation_id: string; bank_code: string }[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!out.has(r.conversation_id)) out.set(r.conversation_id, r.bank_code);
  }
  return out;
}

/**
 * Sees this chat only through a share: no ordinary access (admin, owner
 * or assignee, i.e. {@link canViewConversation} without the share). Such
 * a person may reply only on the chat's own number, so the number
 * switcher is not offered (SQL would refuse it).
 *
 * A team leader may also hold the chat by leading its owner or assignee,
 * which the client cannot see; guessing "share-only" would hide the
 * switcher from someone entitled to it, so a leader is never reported
 * share-only here. The server still refuses a share-only send
 * (`shared_chat_number`).
 */
export function isShareOnlyViewer(
  role: AccountRole | null,
  userId: string | null,
  conversation: { user_id?: string | null; assigned_agent_id?: string | null },
  sharedWithMe: boolean
): boolean {
  if (!sharedWithMe || !role || !userId) return false;
  if (role === 'team_leader') return false;
  return !canViewConversation(role, userId, {
    ownerId: conversation.user_id ?? null,
    assignedId: conversation.assigned_agent_id ?? null,
  });
}

/** `send-message.ts`'s refusal of a share-only sender on another number. */
export function isSharedChatNumberRefusal(
  status: number,
  payload: unknown
): boolean {
  return (
    status === 409 &&
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { code?: unknown }).code === 'shared_chat_number'
  );
}

/** Bank codes held by a person, from the coordinator list. */
export function banksByUser(
  coordinators: readonly CoordinatorRow[]
): Map<string, string[]> {
  return new Map(coordinators.map((c) => [c.user_id, [...c.banks].sort()]));
}

/** Toggle one code in a selection, keeping it sorted and distinct. */
export function toggleBank(
  selected: readonly string[],
  code: string
): string[] {
  const set = new Set(selected);
  if (set.has(code)) set.delete(code);
  else set.add(code);
  return [...set].sort();
}

/** Whether a draft selection differs from the saved banks (order-blind). */
export function banksChanged(
  saved: readonly string[],
  draft: readonly string[]
): boolean {
  const a = new Set(saved);
  const b = new Set(draft);
  if (a.size !== b.size) return true;
  for (const c of a) if (!b.has(c)) return true;
  return false;
}
