import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/**
 * Whether a DM's header offers a Call button, and which extension it
 * dials. Only a 1:1 DM whose one other person has an extension, for a
 * caller who has a phone themselves and is staff (agent and up; a bank
 * guest never). The server dial route still applies every rule.
 */
export function dmCallTarget(input: {
  kind: string;
  others: readonly string[];
  extensionsByUser: ReadonlyMap<string, string>;
  hasPhone: boolean;
  role: AccountRole | null;
}): string | null {
  const { kind, others, extensionsByUser, hasPhone, role } = input;
  if (kind !== 'dm' || others.length !== 1) return null;
  if (!hasPhone || !role || !hasMinRole(role, 'agent')) return null;
  const ext = extensionsByUser.get(others[0].toLowerCase())?.trim();
  return ext || null;
}
