// Pure helpers for the assignment screens (migration 236): the Assign
// menu's load label, the people a rotation may pick from, the limit
// input and the error codes the API answers. Dependency-free so client
// components and route handlers share them.

import type { MemberLoad } from './types';

/** Bounds of a chat limit, as 236's CHECKs and writers hold them. */
export const MIN_CHAT_LIMIT = 1;
export const MAX_CHAT_LIMIT = 500;

/** The most people a broadcast pool may hold (236's pool_too_large). */
export const MAX_POOL_SIZE = 500;

/**
 * "12/30" while chat limits are on, "12" while they are off, null when
 * the person has no row (a load that never arrived shows nothing).
 */
export function formatMemberLoad(
  load: MemberLoad | null | undefined
): string | null {
  if (!load) return null;
  const open = Math.max(0, Math.trunc(load.openCount));
  return load.chatLimit === null ? String(open) : `${open}/${load.chatLimit}`;
}

/** True when a person holds as many open chats as their limit allows. */
export function isAtLimit(load: MemberLoad | null | undefined): boolean {
  return !!load && load.chatLimit !== null && load.openCount >= load.chatLimit;
}

/** Loads keyed by auth user id, for a menu that looks people up. */
export function loadsByUser(
  loads: readonly MemberLoad[]
): Map<string, MemberLoad> {
  return new Map(loads.map((l) => [l.userId, l]));
}

/** Roles a rotation picks from (236: live agents and team leaders). */
export const ROTATION_ROLES: readonly string[] = ['agent', 'team_leader'];

export interface PersonOption {
  /** Auth user id. */
  userId: string;
  name: string;
}

interface MemberLike {
  user_id: string;
  full_name?: string | null;
  email?: string | null;
  role?: string | null;
  account_role?: string | null;
  deactivated_at?: string | null;
}

/**
 * The people a rotation picker offers: live agents and team leaders,
 * by name. Ids in `keep` (already saved) stay listed whatever they are
 * now, so a saved pool never silently loses someone from view.
 */
export function rotationPeople(
  members: readonly MemberLike[],
  keep: readonly string[] = []
): PersonOption[] {
  const kept = new Set(keep);
  const seen = new Set<string>();
  const out: PersonOption[] = [];
  for (const m of members) {
    if (!m.user_id || seen.has(m.user_id)) continue;
    const role = m.role ?? m.account_role ?? '';
    const eligible = !m.deactivated_at && ROTATION_ROLES.includes(role);
    if (!eligible && !kept.has(m.user_id)) continue;
    seen.add(m.user_id);
    out.push({
      userId: m.user_id,
      name: m.full_name?.trim() || m.email || m.user_id,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A typed limit: an integer 1-500, else null. */
export function parseChatLimit(text: string | number): number | null {
  const s = String(text).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_CHAT_LIMIT && n <= MAX_CHAT_LIMIT ? n : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Error codes the assignment API answers; each has a plain message. */
export const ASSIGNMENT_ERRORS = [
  'bad_limit',
  'pool_member_invalid',
  'pool_too_large',
  'no_such_member',
  'not_allowed',
  'not_available',
  'invalid_body',
] as const;

export type AssignmentError = (typeof ASSIGNMENT_ERRORS)[number];

/**
 * A SQL refusal (its HINT, else its SQLSTATE) as one of the codes
 * above, with the HTTP status to answer; null for anything unexpected.
 */
export function assignmentErrorOf(
  code: string | null | undefined
): { error: AssignmentError; status: number } | null {
  switch (code) {
    case 'bad_limit':
    case 'pool_member_invalid':
    case 'pool_too_large':
      return { error: code, status: 422 };
    case 'no_such_member':
    case 'P0002':
      return { error: 'no_such_member', status: 404 };
    case '42501':
      return { error: 'not_allowed', status: 403 };
    case 'PGRST202':
    case 'PGRST205':
    case '42883':
    case '42P01':
      return { error: 'not_available', status: 503 };
    default:
      return null;
  }
}

/** A code from a response body, if it is one the screens can word. */
export function knownAssignmentError(value: unknown): AssignmentError | null {
  return typeof value === 'string' &&
    (ASSIGNMENT_ERRORS as readonly string[]).includes(value)
    ? (value as AssignmentError)
    : null;
}
