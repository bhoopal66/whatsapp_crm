import { isBankGuest } from '@/lib/auth/roles';
import type { AccountMember } from '@/types';

/**
 * Fetch the current account's members from the API (which applies the
 * email-visibility rules — agents/viewers don't see emails). Best-effort:
 * returns `[]` on any error or on an older deployment without the
 * endpoint, so callers can fall back to a queue-only / raw-id picker.
 *
 * Client-side only (uses `fetch` against the relative API route).
 */
export async function fetchAccountMembers(): Promise<AccountMember[]> {
  try {
    const res = await fetch('/api/account/members', { cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as { members?: AccountMember[] };
    return json.members ?? [];
  } catch {
    return [];
  }
}

/**
 * The account's own people: everyone but a partner bank's guest
 * (migration 083). Use it for any list that picks a person for staff
 * work: assignees, team members, number allocation, the AI hand-off
 * person. The members API still returns guests, because the Members tab
 * has to show and manage them.
 */
export function staffOnly<T extends Pick<AccountMember, 'role'>>(
  members: readonly T[]
): T[] {
  return members.filter((m) => !isBankGuest(m.role));
}

/** Display label for a member: full name → email → raw id. */
export function memberLabel(m: AccountMember): string {
  return m.full_name || m.email || m.user_id;
}
