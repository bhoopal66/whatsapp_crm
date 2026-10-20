// Pure decisions for the coordinator screens (migration 130): who is
// offered the share dialog, who can receive a share, which rows are
// "shared with me", and how a share-only sender's refusal is worded.
// The database decides every one of these again; this only keeps the
// UI from offering what SQL would refuse.

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

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
 * Whether a share can give this role anything (130's
 * `coordinator_share_grants`): agents and team leaders. Admins see
 * every chat anyway; viewers and guests get nothing from a share.
 */
export function receivesShares(role: AccountRole | null): boolean {
  return !!role && hasMinRole(role, 'agent') && !hasMinRole(role, 'admin');
}

/** Whose banks an admin may set in Settings -> Members (130's set_coordinator_banks). */
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
 * per chat and coordinator, by 130's partial unique index).
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
 * Sees this chat only through a share: not an admin, neither its owner
 * nor its assignee. Such a person may reply only on the chat's own
 * number, so the number switcher is not offered (SQL would refuse it).
 */
export function isShareOnlyViewer(
  role: AccountRole | null,
  userId: string | null,
  conversation: { user_id?: string | null; assigned_agent_id?: string | null },
  sharedWithMe: boolean
): boolean {
  if (!sharedWithMe || !role || !userId) return false;
  if (hasMinRole(role, 'admin')) return false;
  return (
    conversation.user_id !== userId && conversation.assigned_agent_id !== userId
  );
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
