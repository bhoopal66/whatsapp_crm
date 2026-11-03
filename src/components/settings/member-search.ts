// Settings → Members: the roster's search box. Pure, so it is tested
// without a DOM. Every word typed must appear somewhere in the person's
// name, login email, role (as shown, in the page's language, and its
// key) or a bank guest's bank code; case and accents are ignored, so
// "jose" finds "José".

export interface SearchableMember {
  full_name: string | null;
  email: string | null;
  role: string;
  bank_code?: string | null;
}

/** Lower case with accents removed, for matching only. */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words of a query; none means "show everyone". */
export function searchWords(query: string): string[] {
  return foldForSearch(query).split(/\s+/).filter(Boolean);
}

export function memberMatches(
  m: SearchableMember,
  words: string[],
  roleLabel: (role: string) => string
): boolean {
  if (words.length === 0) return true;
  const hay = foldForSearch(
    [
      m.full_name,
      m.email,
      m.role.replace(/_/g, ' '),
      roleLabel(m.role),
      m.bank_code,
    ]
      .filter(Boolean)
      .join(' ')
  );
  return words.every((w) => hay.includes(w));
}

/** The members a query keeps, in their original order. */
export function filterMembers<T extends SearchableMember>(
  members: T[],
  query: string,
  roleLabel: (role: string) => string
): T[] {
  const words = searchWords(query);
  return words.length === 0
    ? members
    : members.filter((m) => memberMatches(m, words, roleLabel));
}

/**
 * Active people first, deactivated ones always at the bottom; each group
 * keeps its original order (Array.prototype.sort is stable).
 */
export function inactiveLast<T extends { deactivated_at?: string | null }>(
  members: T[]
): T[] {
  return [...members].sort(
    (a, b) => Number(!!a.deactivated_at) - Number(!!b.deactivated_at)
  );
}
